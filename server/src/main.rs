//! OAuth for MCP card game server.
//!
//! Env:
//!   PORT            (default 8080)
//!   STATIC_DIR      Next.js static export to serve (default ../out)
//!   SCENARIOS_DIR   scenario JSON files (default ../scenarios)
//!   DEV_ORIGIN      allow this browser origin with credentials (e.g. http://localhost:3000)
//!   SECURE_COOKIES  "1" to mark session cookies Secure (set when served over HTTPS)
//!   INTERNAL_TOKEN  lets load tests skip the per-IP room-creation limit
//!   ADMIN_PASSWORD_HASH  scrypt hash from `oauth-mcp-server hash-password`; enables /admin/
//!   TURNSTILE_SITE_KEY, TURNSTILE_SECRET  Cloudflare Turnstile bot check on create/join/admin login
//!   SIM_SKILL       0..1, how often simulated players make the right call (default 0.85)
//!   SIM_DELAY_MS    fixed delay before a simulated player moves (default ~5.6-6.3s, so each card can be read)
mod admin;
mod crypto;
mod engine;
mod explain;
mod scenario;
mod server;
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
    let scenarios_dir = PathBuf::from(env("SCENARIOS_DIR").unwrap_or_else(|| "../scenarios".into()));

    let scenarios = match scenario::load_dir(&scenarios_dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("scenario error: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("loaded {} scenarios from {}", scenarios.len(), scenarios_dir.display());
    if !static_dir.join("index.html").exists() {
        eprintln!("note: no front end at {} (run `bun run build`); API and sockets still work", static_dir.display());
    }

    let cfg = server::Config {
        internal_token: env("INTERNAL_TOKEN"),
        secure_cookies: env("SECURE_COOKIES").as_deref() == Some("1"),
        dev_origin: env("DEV_ORIGIN"),
        admin_hash: env("ADMIN_PASSWORD_HASH"),
        turnstile_site_key: env("TURNSTILE_SITE_KEY"),
        turnstile_secret: env("TURNSTILE_SECRET"),
    };
    eprintln!(
        "admin: {} · bot check (Turnstile): {}",
        if cfg.admin_hash.is_some() { "enabled" } else { "disabled (set ADMIN_PASSWORD_HASH)" },
        if cfg.turnstile_site_key.is_some() && cfg.turnstile_secret.is_some() { "enabled" } else { "disabled" }
    );
    let state = server::AppState::new(scenarios, cfg);
    server::spawn_reaper(state.clone());
    let app = server::router(state, &static_dir);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    eprintln!("listening on http://{addr}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server");
}
