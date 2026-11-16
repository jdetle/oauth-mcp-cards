//! Admin API: one password (stored only as a scrypt hash), a short-lived signed cookie,
//! and the ability to see and delete active games.
use crate::crypto::{check_password, hmac_hex, safe_eq};
use crate::engine::now_ms;
use crate::server::{client_ip, error, read_cookie, valid_room_name, AppState};
use crate::types::RoundStatus;
use axum::extract::ws::{CloseFrame, Message};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;

const COOKIE: &str = "omcp_admin";
const SESSION_MS: i64 = 8 * 3600 * 1000;
/// WebSocket close code sent to players when an admin deletes their room.
pub const CLOSE_DELETED: u16 = 4410;

pub fn sign_admin(exp: i64, secret: &[u8]) -> String {
    format!("{exp}.{}", hmac_hex(secret, &format!("admin:{exp}")))
}

pub fn verify_admin(token: &str, secret: &[u8], now: i64) -> bool {
    let Some((exp, _)) = token.split_once('.') else { return false };
    let Ok(exp) = exp.parse::<i64>() else { return false };
    exp > now && token.len() < 200 && safe_eq(&sign_admin(exp, secret), token)
}

fn cookie(state: &AppState, value: &str, max_age: i64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        if state.secure_cookies { "; Secure" } else { "" }
    ))
    .unwrap()
}

/// Every admin call needs the cookie; state-changing ones also need a custom header,
/// which a cross-site form or image can't send.
fn authorize(state: &AppState, headers: &HeaderMap, mutating: bool) -> Result<(), Response> {
    if state.admin_hash.is_none() {
        return Err(error(StatusCode::NOT_FOUND, "Admin is not enabled on this server."));
    }
    let ok = read_cookie(headers, COOKIE).is_some_and(|t| verify_admin(&t, &state.secret, now_ms()));
    if !ok {
        return Err(error(StatusCode::UNAUTHORIZED, "Sign in first."));
    }
    if mutating && headers.get("x-omcp-admin").is_none() {
        return Err(error(StatusCode::FORBIDDEN, "Missing admin header."));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginBody {
    password: Option<String>,
    turnstile_token: Option<String>,
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Option<Json<LoginBody>>,
) -> Response {
    let Some(hash) = state.admin_hash.clone() else { return error(StatusCode::NOT_FOUND, "Admin is not enabled on this server.") };
    let Some(Json(body)) = body else { return error(StatusCode::BAD_REQUEST, "Bad request.") };
    let ip = client_ip(&headers, &addr);
    let key = format!("admin|{ip}");
    let wait = state.admin_limiter.blocked(&key);
    if wait > 0 {
        return error(StatusCode::TOO_MANY_REQUESTS, &format!("Too many attempts. Try again in {wait}s."));
    }
    if let Err(r) = state.bot_check(&headers, body.turnstile_token.as_deref(), &ip).await {
        return r;
    }
    let password = body.password.unwrap_or_default();
    let ok = password.len() <= 256 && tokio::task::spawn_blocking(move || check_password(&password, &hash)).await.unwrap_or(false);
    if !ok {
        let w = state.admin_limiter.check(&key);
        return if w > 0 {
            error(StatusCode::TOO_MANY_REQUESTS, &format!("Too many attempts. Try again in {w}s."))
        } else {
            error(StatusCode::UNAUTHORIZED, "Wrong password.")
        };
    }
    let token = sign_admin(now_ms() + SESSION_MS, &state.secret);
    let mut res = Json(json!({ "ok": true })).into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie(&state, &token, SESSION_MS / 1000));
    res
}

pub async fn logout(State(state): State<Arc<AppState>>) -> Response {
    let mut res = Json(json!({ "ok": true })).into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie(&state, "", 0));
    res
}

pub async fn rooms(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&state, &headers, false) {
        return r;
    }
    let list: Vec<_> = state.rooms.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut out: Vec<(u64, serde_json::Value)> = list
        .into_iter()
        .map(|(name, room)| {
            let r = room.lock().unwrap();
            let online: Vec<&str> = r.conns.values().map(|c| c.player_id.as_str()).collect();
            let round = r.game.round.as_ref();
            (
                r.created.elapsed().as_secs(),
                json!({
                    "name": name,
                    "ageSeconds": r.created.elapsed().as_secs(),
                    "idleSeconds": r.last_active.elapsed().as_secs(),
                    "connections": r.conns.len(),
                    "started": r.game.started,
                    "round": round.map(|x| x.index + 1),
                    "rounds": r.game.scenarios.len(),
                    "status": round.map(|x| match x.status { RoundStatus::Identify => "identify", RoundStatus::Playing => "playing", RoundStatus::Done => "done" }),
                    "players": r.game.players.iter().map(|p| json!({
                        "name": p.name, "role": p.role, "bot": p.bot, "connected": p.bot || online.contains(&p.id.as_str()),
                    })).collect::<Vec<_>>(),
                }),
            )
        })
        .collect();
    out.sort_by_key(|x| x.0);
    let mut res = Json(json!({ "rooms": out.into_iter().map(|x| x.1).collect::<Vec<_>>() })).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub async fn delete_room(State(state): State<Arc<AppState>>, Path(name): Path<String>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&state, &headers, true) {
        return r;
    }
    if !valid_room_name(&name) {
        return error(StatusCode::NOT_FOUND, "No such room.");
    }
    let Some(room) = state.rooms.lock().unwrap().remove(&name) else { return error(StatusCode::NOT_FOUND, "No such room.") };
    let mut r = room.lock().unwrap();
    r.closed = true;
    let notice = json!({ "t": "error", "message": "This game was closed by an admin." }).to_string();
    for c in r.conns.values() {
        let _ = c.tx.try_send(Message::Text(notice.clone().into()));
        let _ = c.tx.try_send(Message::Close(Some(CloseFrame { code: CLOSE_DELETED, reason: "room deleted".into() })));
    }
    eprintln!("admin deleted room {name} ({} connections)", r.conns.len());
    Json(json!({ "ok": true, "deleted": name })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admin_tokens_expire_and_cannot_be_forged() {
        let secret = b"server-secret";
        let now = 1_000_000;
        let t = sign_admin(now + 1000, secret);
        assert!(verify_admin(&t, secret, now));
        assert!(!verify_admin(&t, secret, now + 2000), "expired");
        assert!(!verify_admin(&t, b"other-secret", now), "wrong key");
        // extending the expiry invalidates the signature
        let forged = t.replacen(&(now + 1000).to_string(), &(now + 999_999).to_string(), 1);
        assert!(!verify_admin(&forged, secret, now));
        assert!(!verify_admin("", secret, now));
        assert!(!verify_admin("abc.def", secret, now));
    }
}
