//! OAuth for MCP card game server.
//!
//! Env:
//!   PORT            (default 8080)
//!   STATIC_DIR      Next.js static export to serve (default ../out)
//!   GAMES_DIR       the series: one folder per game, each with game.json and rounds/ (default ../games)
//!   DEV_ORIGIN      allow this browser origin with credentials (e.g. http://localhost:3000)
//!   SECURE_COOKIES  "1" to mark session cookies Secure (set when served over HTTPS)
//!   INTERNAL_TOKEN  lets load tests skip the per-IP room-creation limit
//!   ADMIN_PASSWORD_HASH  scrypt hash from `oauth-mcp-server hash-password`; enables /admin/
//!   TURNSTILE_SITE_KEY, TURNSTILE_SECRET  Cloudflare Turnstile bot check on create/join/admin login
//!   BASE_PATH       serve the whole app under this prefix, e.g. /mcp-oauth (default: site root)
//!   LEGACY_BASE_PATH  a prefix the site used to live under (e.g. /mcp-oauth): links there are redirected
//!   EDGE_PUBLIC_KEY Ed25519 public key (hex) of the edge Worker that signs visitor addresses
//!   INTRUDER_RATE   0..1, chance per round that a token is swapped in transit (default 0.35)
//!   INTRUDER_TARGET application | mcp: pin whose token the intruder goes after (default: random)
//!   READY_TIMEOUT_MS  idle time after a round before the table moves on by itself (default 180000)
//!   S10_INGEST_KEY  s10 ingest key (same project as jdetle.com); S10_INGEST_URL overrides the endpoint
//!   SENTRY_DSN      Sentry project DSN for server errors and panics; also enables the /monitoring tunnel
//!   TELEMETRY_ENV   environment tag (default production); RELEASE: version tag
//!   SESSION_SECRET  64 hex chars that sign session cookies (same on every server, so deploys keep people signed in)
//!   ROOMS_TABLE     DynamoDB table that keeps games across deploys (or ROOMS_DIR: a directory, for local runs)
//!   IDLE_SLEEP_MIN  after this many minutes with nobody doing anything, scale the ECS service to zero
//!                   (needs a room store; the edge Worker wakes it). Unset: never sleep
//!   SIM_SKILL       0..1, how often simulated players make the right call (default 0.85)
//!   SIM_DELAY_MS    fixed delay before a simulated player moves (default ~9-9.7s, so each card can be read)
mod admin;
mod aws;
mod crypto;
mod engine;
mod explain;
mod scenario;
mod pack;
mod server;
mod store;
mod telemetry;
mod types;
mod validate;

#[cfg(test)]
mod tests;

use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    // `oauth-mcp-server hash-password`: read a password from stdin, print its scrypt hash, exit.
    // The hash (never the password) is what ADMIN_PASSWORD_HASH holds.
    if std::env::args().nth(1).as_deref() == Some("hash-password") {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).expect("read stdin");
        let pw = line.trim_end_matches(['\n', '\r']);
        if pw.chars().count() < 12 {
            eprintln!("admin password must be at least 12 characters");
            std::process::exit(2);
        }
        println!("{}", crypto::hash_password(pw));
        return;
    }
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let port: u16 = env("PORT").and_then(|p| p.parse().ok()).unwrap_or(8080);
    let static_dir = PathBuf::from(env("STATIC_DIR").unwrap_or_else(|| "../out".into()));
    let games_dir = PathBuf::from(env("GAMES_DIR").unwrap_or_else(|| "../games".into()));

    // a broken game pack stops the server here, rather than a table getting stuck mid-round
    let packs = match pack::load_all(&games_dir) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("game pack error: {e}");
            std::process::exit(1);
        }
    };
    let rounds: usize = packs.values().map(|p| p.scenarios.len()).sum();
    eprintln!("loaded {} games ({rounds} rounds) from {}: {}", packs.len(), games_dir.display(), packs.keys().cloned().collect::<Vec<_>>().join(", "));
    if !static_dir.join("index.html").exists() {
        eprintln!("note: no front end at {} (run `bun run build`); API and sockets still work", static_dir.display());
    }

    telemetry::init(telemetry::Settings::from_env());
    telemetry::event("server.started", serde_json::json!({ "games": packs.len(), "rounds": rounds }));
    let cfg = server::Config {
        internal_token: env("INTERNAL_TOKEN"),
        secure_cookies: env("SECURE_COOKIES").as_deref() == Some("1"),
        dev_origin: env("DEV_ORIGIN"),
        admin_hash: env("ADMIN_PASSWORD_HASH"),
        turnstile_site_key: env("TURNSTILE_SITE_KEY"),
        turnstile_secret: env("TURNSTILE_SECRET"),
        base_path: env("BASE_PATH").unwrap_or_default(),
        session_secret: env("SESSION_SECRET").and_then(|h| hex::decode(h.trim()).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok()),
        store: store::from_env(),
        idle_sleep: env("IDLE_SLEEP_MIN").and_then(|m| m.parse::<u64>().ok()).filter(|m| *m > 0).map(|m| std::time::Duration::from_secs(m * 60)),
    };
    if cfg.session_secret.is_none() {
        eprintln!("note: no SESSION_SECRET (64 hex chars); sessions won't survive a restart");
    }
    eprintln!("rooms: {}", cfg.store.as_ref().map_or("memory only (set ROOMS_TABLE or ROOMS_DIR)", |s| s.name()));
    eprintln!(
        "admin: {} · bot check (Turnstile): {}",
        if cfg.admin_hash.is_some() { "enabled" } else { "disabled (set ADMIN_PASSWORD_HASH)" },
        if cfg.turnstile_site_key.is_some() && cfg.turnstile_secret.is_some() { "enabled" } else { "disabled" }
    );
    let state = server::AppState::new(packs, cfg);
    state.preload().await;
    server::spawn_reaper(state.clone());
    server::spawn_saver(state.clone());
    let leaving = state.clone();
    let base = state.base_path.clone();
    // old links (the site's previous prefix) are redirected to the new one
    let legacy = server::normalize_base_path(&std::env::var("LEGACY_BASE_PATH").unwrap_or_default());
    let app = server::with_base_path(server::router(state, &static_dir), base, legacy);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    eprintln!("listening on http://{addr}{}", server::normalize_base_path(&std::env::var("BASE_PATH").unwrap_or_default()));
    axum::serve(listener, axum::ServiceExt::<axum::extract::Request>::into_make_service_with_connect_info::<SocketAddr>(app))
        .with_graceful_shutdown(async move {
            // ECS stops tasks with SIGTERM; without this the server ignored it and was killed 30s later
            #[cfg(unix)]
            {
                let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
            eprintln!("shutting down");
            leaving.hand_off().await;
            telemetry::event("server.stopping", serde_json::json!({}));
            telemetry::flush_blocking();
        })
        .await
        .expect("server");
}
