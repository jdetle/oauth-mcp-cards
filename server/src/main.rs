//! OAuth for MCP card game server.
//!
//! Env:
//!   PORT            (default 8080)
//!   STATIC_DIR      Next.js static export to serve (default ../out)
//!   SCENARIOS_DIR   scenario JSON files (default ../scenarios)
//!   DEV_ORIGIN      allow this browser origin with credentials (e.g. http://localhost:3000)
//!   SECURE_COOKIES  "1" to mark session cookies Secure (set when served over HTTPS)
//!   INTERNAL_TOKEN  lets load tests skip the per-IP room-creation limit
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

    let state = server::AppState::new(scenarios, env("INTERNAL_TOKEN"), env("SECURE_COOKIES").as_deref() == Some("1"), env("DEV_ORIGIN"));
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
