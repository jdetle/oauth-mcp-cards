//! HTTP + WebSocket server. One process hosts the API, the sockets and the static front end.
use crate::crypto::{check_password, hash_password, random_bytes, sign_session, verify_session};
use crate::engine::{Game, GameError};
use crate::scenario::Scenario;
use crate::types::*;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tower_http::services::{ServeDir, ServeFile};

pub const MAX_MESSAGE_BYTES: usize = 1024;
const MAX_PLAYERS: usize = 24;
const MAX_ROOMS: usize = 2000;
const IDLE_TTL: Duration = Duration::from_secs(6 * 3600);

/// Sliding-window limiter: at most `limit` hits per `window` per key.
pub struct RateLimiter {
    limit: usize,
    window: Duration,
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn new(limit: usize, window: Duration) -> Self {
        RateLimiter { limit, window, hits: Mutex::new(HashMap::new()) }
    }
    /// Seconds to wait, or 0 if allowed (and the hit is recorded).
    pub fn check(&self, key: &str) -> u64 {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap();
        if hits.len() > 50_000 {
            hits.clear();
        }
        let q = hits.entry(key.to_string()).or_default();
        while q.front().map(|t| now.duration_since(*t) >= self.window).unwrap_or(false) {
            q.pop_front();
        }
        if q.len() >= self.limit {
            let oldest = *q.front().unwrap();
            return (self.window - now.duration_since(oldest)).as_secs().max(1);
        }
        q.push_back(now);
        0
    }
    /// Peek without recording.
    pub fn blocked(&self, key: &str) -> u64 {
        let now = Instant::now();
        let hits = self.hits.lock().unwrap();
        match hits.get(key) {
            Some(q) => {
                let live: Vec<_> = q.iter().filter(|t| now.duration_since(**t) < self.window).collect();
                if live.len() >= self.limit { (self.window - now.duration_since(*live[0])).as_secs().max(1) } else { 0 }
            }
            None => 0,
        }
    }
}

pub(crate) struct Conn {
    pub(crate) player_id: String,
    pub(crate) tx: mpsc::Sender<Message>,
}

pub struct Room {
    pub game: Game,
    password_hash: String,
    pub(crate) conns: HashMap<u64, Conn>,
    pub(crate) created: Instant,
    /// set when an admin deletes the room: sockets stop accepting moves
    pub(crate) closed: bool,
    pub last_active: Instant,
    msg_limiter: HashMap<u64, VecDeque<Instant>>,
    /// a sim move is already scheduled for this room
    sim_pending: bool,
    /// a wake-up is scheduled for the ready check's idle deadline
    ready_timer: bool,
}

impl Room {
    /// Send every socket the public state plus its own private view.
    fn broadcast(&self) {
        let online: std::collections::HashSet<&str> = self.conns.values().map(|c| c.player_id.as_str()).collect();
        let spectators = self.game.players.iter().filter(|p| p.role.is_none() && online.contains(p.id.as_str())).count();
        let state = self.game.public_state(&|id| online.contains(id), spectators);
        for c in self.conns.values() {
            let you = self.game.private_view(&c.player_id);
            let msg = serde_json::to_string(&ServerMessage::State { state: &state, you: &you }).unwrap_or_default();
            let _ = c.tx.try_send(Message::Text(msg.into()));
        }
    }

    fn allow_message(&mut self, conn: u64) -> bool {
        let now = Instant::now();
        let q = self.msg_limiter.entry(conn).or_default();
        while q.front().map(|t| now.duration_since(*t) >= Duration::from_secs(10)).unwrap_or(false) {
            q.pop_front();
        }
        if q.len() >= 60 {
            return false;
        }
        q.push_back(now);
        true
    }
}

/// Settings read from the environment in main.rs.
#[derive(Default, Clone)]
pub struct Config {
    pub internal_token: Option<String>,
    pub secure_cookies: bool,
    pub dev_origin: Option<String>,
    /// scrypt hash (`salt:hash`) of the admin password; admin is disabled without it
    pub admin_hash: Option<String>,
    /// Cloudflare Turnstile: both set = bot check required on create / join / admin login
    pub turnstile_site_key: Option<String>,
    pub turnstile_secret: Option<String>,
    /// serve everything under this prefix, e.g. "/mcp-oauth" (empty = site root)
    pub base_path: String,
}

/// "/mcp-oauth/" or "mcp-oauth" -> "/mcp-oauth"; "" or "/" -> "".
pub fn normalize_base_path(raw: &str) -> String {
    let t = raw.trim().trim_matches('/');
    let ok = !t.is_empty() && t.len() <= 64 && t.split('/').all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    if ok { format!("/{t}") } else { String::new() }
}

/// The visitor's address as vouched for by our edge Worker: it signs "<ts>.<ip>" with an
/// Ed25519 key whose private half never leaves Cloudflare. We hold only the public key, so
/// nothing secret is shared, and a header someone else writes won't verify.
pub fn edge_ip(headers: &HeaderMap, public_key_hex: &str, now_ms: i64) -> Option<String> {
    let get = |k: &str| headers.get(k).and_then(|v| v.to_str().ok());
    let (ip, ts, sig) = (get("x-edge-ip")?, get("x-edge-ts")?, get("x-edge-sig")?);
    let t: i64 = ts.parse().ok()?;
    if (now_ms - t).abs() > 120_000 || ip.is_empty() || ip.len() > 64 {
        return None;
    }
    crate::crypto::ed_verify(&format!("{ts}.{ip}"), sig, public_key_hex).then(|| ip.to_string())
}

pub struct AppState {
    pub base_path: String,
    pub admin_hash: Option<String>,
    pub admin_limiter: RateLimiter,
    pub turnstile_site_key: Option<String>,
    pub turnstile_secret: Option<String>,
    pub scenarios: Arc<Vec<Scenario>>,
    pub rooms: Mutex<HashMap<String, Arc<Mutex<Room>>>>,
    pub secret: [u8; 32],
    pub join_limiter: RateLimiter,
    pub create_limiter: RateLimiter,
    pub internal_token: Option<String>,
    pub secure_cookies: bool,
    pub dev_origin: Option<String>,
    next_conn: AtomicU64,
}

impl AppState {
    pub fn new(scenarios: Vec<Scenario>, cfg: Config) -> Arc<Self> {
        let Config { internal_token, secure_cookies, dev_origin, admin_hash, turnstile_site_key, turnstile_secret, base_path } = cfg;
        let turnstile_on = turnstile_site_key.is_some() && turnstile_secret.is_some();
        Arc::new(AppState {
            base_path: normalize_base_path(&base_path),
            admin_hash,
            admin_limiter: RateLimiter::new(5, Duration::from_secs(300)),
            turnstile_site_key: turnstile_site_key.filter(|_| turnstile_on),
            turnstile_secret: turnstile_secret.filter(|_| turnstile_on),
            scenarios: Arc::new(scenarios),
            rooms: Mutex::new(HashMap::new()),
            secret: random_bytes::<32>(),
            join_limiter: RateLimiter::new(5, Duration::from_secs(60)),
            create_limiter: RateLimiter::new(10, Duration::from_secs(60)),
            internal_token,
            secure_cookies,
            dev_origin,
            next_conn: AtomicU64::new(1),
        })
    }

    /// Path attribute for our cookies: the base path, so they are only sent to this app.
    pub(crate) fn cookie_path(&self) -> &str {
        if self.base_path.is_empty() { "/" } else { &self.base_path }
    }

    pub(crate) fn room(&self, name: &str) -> Option<Arc<Mutex<Room>>> {
        self.rooms.lock().unwrap().get(name).cloned()
    }

    pub(crate) fn trusted(&self, headers: &HeaderMap) -> bool {
        self.internal_token.as_ref().is_some_and(|t| headers.get("x-omcp-internal").and_then(|v| v.to_str().ok()) == Some(t.as_str()))
    }

    /// Cloudflare Turnstile: when configured, the browser must present a token from the widget
    /// and Cloudflare must confirm it. Requests carrying the internal token (tests) skip it.
    pub(crate) async fn bot_check(&self, headers: &HeaderMap, token: Option<&str>, ip: &str) -> Result<(), Response> {
        let Some(secret) = self.turnstile_secret.clone() else { return Ok(()) };
        if self.trusted(headers) {
            return Ok(());
        }
        let Some(token) = token.filter(|t| !t.is_empty() && t.len() < 4096).map(str::to_string) else {
            return Err(error(StatusCode::BAD_REQUEST, "Please complete the bot check first."));
        };
        let ip = ip.to_string();
        let ok = tokio::task::spawn_blocking(move || {
            ureq::post("https://challenges.cloudflare.com/turnstile/v0/siteverify")
                .timeout(Duration::from_secs(8))
                .send_form(&[("secret", secret.as_str()), ("response", token.as_str()), ("remoteip", ip.as_str())])
                .ok()
                .and_then(|r| r.into_json::<serde_json::Value>().ok())
                .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false);
        if ok { Ok(()) } else { Err(error(StatusCode::FORBIDDEN, "Bot check failed. Reload the page and try again.")) }
    }
}

// ---- room names ---------------------------------------------------------------------------------

const ADJ: &[&str] = &[
    "amber", "azure", "brisk", "calm", "cedar", "coral", "crisp", "dusky", "ember", "fern", "frosty", "gentle", "golden", "hazel",
    "indigo", "ivory", "jade", "lunar", "maple", "misty", "mossy", "nimble", "ochre", "pale", "quiet", "rapid", "rosy", "rustic",
    "sandy", "silver", "slate", "solar", "stony", "sunny", "swift", "tawny", "teal", "velvet", "windy",
];
const NOUN: &[&str] = &[
    "falcon", "otter", "heron", "badger", "lynx", "marten", "osprey", "puffin", "raven", "sparrow", "tern", "wren", "willow",
    "birch", "aspen", "harbor", "meadow", "canyon", "glacier", "lagoon", "summit", "valley", "comet", "delta", "ember", "fjord",
    "grove", "island", "mesa", "prairie", "reef", "ridge", "river", "tundra", "beacon", "lantern",
];

/// Neutral, server-generated room names: never user-supplied.
pub fn room_name(taken: &dyn Fn(&str) -> bool) -> String {
    let pick = |xs: &[&str]| xs[(u32::from_le_bytes(random_bytes::<4>()) as usize) % xs.len()].to_string();
    for _ in 0..50 {
        let n = format!("{}-{}", pick(ADJ), pick(NOUN));
        if !taken(&n) {
            return n;
        }
    }
    loop {
        let n = format!("{}-{}-{}", pick(ADJ), pick(NOUN), u16::from_le_bytes(random_bytes::<2>()) % 1000);
        if !taken(&n) {
            return n;
        }
    }
}

pub fn valid_room_name(n: &str) -> bool {
    let parts: Vec<&str> = n.split('-').collect();
    (parts.len() == 2 || parts.len() == 3)
        && n.len() <= 40
        && parts[..2].iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_lowercase()))
        && parts.get(2).map(|d| !d.is_empty() && d.len() <= 3 && d.bytes().all(|b| b.is_ascii_digit())).unwrap_or(true)
}

// ---- HTTP helpers ----------------------------------------------------------------------------------

pub(crate) fn client_ip(headers: &HeaderMap, addr: &SocketAddr) -> String {
    // Behind our Cloudflare Worker, CloudFront only sees Cloudflare. The Worker signs the real
    // visitor address; trust it only if the signature verifies against EDGE_PUBLIC_KEY.
    if let Ok(key) = std::env::var("EDGE_PUBLIC_KEY") {
        if let Some(ip) = edge_ip(headers, &key, crate::engine::now_ms()) {
            return ip;
        }
    }
    // Behind CloudFront (TRUST_CLOUDFRONT=1) the viewer's real address is in CloudFront-Viewer-Address;
    // X-Forwarded-For can be pre-filled by the client, so it's only used when that header is absent.
    if std::env::var("TRUST_CLOUDFRONT").as_deref() == Ok("1") {
        if let Some(v) = headers.get("cloudfront-viewer-address").and_then(|v| v.to_str().ok()) {
            return v.rsplit_once(':').map(|(ip, _)| ip.to_string()).unwrap_or_else(|| v.to_string());
        }
    }
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| addr.ip().to_string())
}

fn cookie_name(room: &str) -> String {
    format!("omcp_{}", room.replace('-', "_"))
}

pub(crate) fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

pub(crate) fn error(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinBody {
    password: Option<String>,
    display_name: Option<String>,
    role: Option<String>,
    turnstile_token: Option<String>,
}

fn seat_choice(role: &Option<String>) -> (Option<Role>, bool) {
    match role.as_deref() {
        Some("spectate") => (None, true),
        Some(r) => (serde_json::from_value::<Role>(json!(r)).ok(), false),
        None => (None, false),
    }
}

fn joined(state: &AppState, room: &str, player: &crate::engine::Player) -> Response {
    let token = sign_session(room, &player.id, &state.secret);
    let cookie = format!(
        "{}={token}; Path={}; HttpOnly; SameSite=Lax; Max-Age=86400{}",
        cookie_name(room),
        state.cookie_path(),
        if state.secure_cookies { "; Secure" } else { "" }
    );
    let mut res = Json(json!({ "room": room, "playerId": player.id, "role": player.role })).into_response();
    res.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    res
}

// ---- handlers ----------------------------------------------------------------------------------

/// What the browser needs to know before it can talk to us.
async fn public_config(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({ "turnstileSiteKey": state.turnstile_site_key, "admin": state.admin_hash.is_some() })).into_response()
}

async fn list_rooms(State(state): State<Arc<AppState>>) -> Response {
    let rooms: Vec<(String, Arc<Mutex<Room>>)> = state.rooms.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut out: Vec<(Instant, serde_json::Value)> = rooms
        .into_iter()
        .map(|(name, r)| {
            let r = r.lock().unwrap();
            (r.last_active, json!({ "name": name, "seated": r.game.seated_roles().len() }))
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    let mut res = Json(json!({ "rooms": out.into_iter().map(|x| x.1).collect::<Vec<_>>() })).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn create_room(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Option<Json<JoinBody>>,
) -> Response {
    let Some(Json(body)) = body else { return error(StatusCode::BAD_REQUEST, "Bad request.") };
    // tests present the internal token to skip the per-IP limit
    let trusted = state.trusted(&headers);
    if let Err(r) = state.bot_check(&headers, body.turnstile_token.as_deref(), &client_ip(&headers, &addr)).await {
        return r;
    }
    if !trusted {
        let wait = state.create_limiter.check(&client_ip(&headers, &addr));
        if wait > 0 {
            return error(StatusCode::TOO_MANY_REQUESTS, &format!("Too many rooms created. Try again in {wait}s."));
        }
    }
    let password = body.password.unwrap_or_default();
    if password.chars().count() < 4 || password.len() > 128 {
        return error(StatusCode::BAD_REQUEST, "Password must be 4 to 128 characters.");
    }
    let hash = tokio::task::spawn_blocking(move || hash_password(&password)).await.unwrap();
    let mut rooms = state.rooms.lock().unwrap();
    if rooms.len() >= MAX_ROOMS {
        return error(StatusCode::SERVICE_UNAVAILABLE, "Server is full. Try again later.");
    }
    let name = room_name(&|n| rooms.contains_key(n));
    let mut game = Game::new(&name, state.scenarios.clone());
    // how often an intruder swaps a token in transit (learning and assessment rounds)
    game.intruder_rate = std::env::var("INTRUDER_RATE").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.35).clamp(0.0, 1.0);
    game.intruder_target = match std::env::var("INTRUDER_TARGET").as_deref() {
        Ok("application") => Some(Role::Application),
        Ok("mcp") => Some(Role::Mcp),
        _ => None,
    };
    if let Some(ms) = std::env::var("READY_TIMEOUT_MS").ok().and_then(|v| v.parse::<i64>().ok()).filter(|ms| *ms >= 1000) {
        game.ready_timeout_ms = ms;
    }
    let (pref, spectate) = seat_choice(&body.role);
    let player = game.add_player(body.display_name.as_deref().unwrap_or("Player"), pref, spectate);
    rooms.insert(
        name.clone(),
        Arc::new(Mutex::new(Room { game, password_hash: hash, conns: HashMap::new(), created: Instant::now(), closed: false, last_active: Instant::now(), msg_limiter: HashMap::new(), sim_pending: false, ready_timer: false })),
    );
    drop(rooms);
    joined(&state, &name, &player)
}

async fn join_room(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: Option<Json<JoinBody>>,
) -> Response {
    if !valid_room_name(&name) {
        return error(StatusCode::NOT_FOUND, "That room doesn't exist (or has closed).");
    }
    let Some(Json(body)) = body else { return error(StatusCode::BAD_REQUEST, "Bad request.") };
    let Some(room) = state.room(&name) else { return error(StatusCode::NOT_FOUND, "That room doesn't exist (or has closed).") };
    // failed attempts are limited per (client IP, room)
    let ip = format!("{}|{name}", client_ip(&headers, &addr));
    let wait = state.join_limiter.blocked(&ip);
    if wait > 0 {
        return error(StatusCode::TOO_MANY_REQUESTS, &format!("Too many attempts. Try again in {wait}s."));
    }
    if let Err(r) = state.bot_check(&headers, body.turnstile_token.as_deref(), &client_ip(&headers, &addr)).await {
        return r;
    }
    let password = body.password.clone().unwrap_or_default();
    let hash = room.lock().unwrap().password_hash.clone();
    let ok = password.len() <= 128 && tokio::task::spawn_blocking(move || check_password(&password, &hash)).await.unwrap();
    if !ok {
        let w = state.join_limiter.check(&ip);
        return if w > 0 {
            error(StatusCode::TOO_MANY_REQUESTS, &format!("Too many attempts. Try again in {w}s."))
        } else {
            error(StatusCode::UNAUTHORIZED, "Wrong password.")
        };
    }
    let mut r = room.lock().unwrap();
    if r.game.players.len() >= MAX_PLAYERS {
        return error(StatusCode::CONFLICT, "This room is full.");
    }
    let (pref, spectate) = seat_choice(&body.role);
    let player = r.game.add_player(body.display_name.as_deref().unwrap_or("Player"), pref, spectate);
    r.last_active = Instant::now();
    r.broadcast();
    drop(r);
    drive_sims(room.clone());
    joined(&state, &name, &player)
}

/// Logs of the rounds already played in this room, for the game-long timeline.
/// Same audience as the table itself: only people holding this room's session cookie.
async fn room_history(State(state): State<Arc<AppState>>, Path(name): Path<String>, headers: HeaderMap) -> Response {
    let player = if valid_room_name(&name) {
        read_cookie(&headers, &cookie_name(&name)).and_then(|t| verify_session(&name, &t, &state.secret))
    } else {
        None
    };
    let Some(room) = state.room(&name) else { return error(StatusCode::NOT_FOUND, "That room doesn't exist (or has closed).") };
    let r = room.lock().unwrap();
    if !player.is_some_and(|p| r.game.player(&p).is_some()) {
        return error(StatusCode::UNAUTHORIZED, "Not joined.");
    }
    let rounds: Vec<&ArchivedRound> = r.game.archive.iter().map(|a| a.as_ref()).collect();
    let mut res = Json(json!({ "rounds": rounds })).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn ws_handler(State(state): State<Arc<AppState>>, Path(name): Path<String>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let player = if valid_room_name(&name) {
        read_cookie(&headers, &cookie_name(&name)).and_then(|t| verify_session(&name, &t, &state.secret))
    } else {
        None
    };
    let room = state.room(&name);
    let player = match (player, &room) {
        (Some(p), Some(r)) if r.lock().unwrap().game.player(&p).is_some() => Some(p),
        _ => None,
    };
    ws.max_message_size(MAX_MESSAGE_BYTES * 4)
        .max_frame_size(MAX_MESSAGE_BYTES * 4)
        .on_upgrade(move |socket| handle_socket(socket, state, room, player))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, room: Option<Arc<Mutex<Room>>>, player: Option<String>) {
    let (mut sink, mut stream) = socket.split();
    let (Some(room), Some(player_id)) = (room, player) else {
        let msg = serde_json::to_string(&ServerMessage::Error { message: "Not joined. Enter the room password to join." }).unwrap();
        let _ = sink.send(Message::Text(msg.into())).await;
        let _ = sink.send(Message::Close(Some(CloseFrame { code: 4401, reason: "unauthorized".into() }))).await;
        return;
    };
    let conn_id = state.next_conn.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel::<Message>(64);
    {
        let mut r = room.lock().unwrap();
        r.conns.insert(conn_id, Conn { player_id: player_id.clone(), tx: tx.clone() });
        r.last_active = Instant::now();
        r.broadcast();
    }
    drive_ready(room.clone());
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });
    let send_one = |tx: &mpsc::Sender<Message>, m: ServerMessage| {
        let _ = tx.try_send(Message::Text(serde_json::to_string(&m).unwrap_or_default().into()));
    };
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Binary(_) => {
                send_one(&tx, ServerMessage::Error { message: "Malformed message." });
                continue;
            }
        };
        let mut r = room.lock().unwrap();
        if r.closed {
            break;
        }
        if !r.allow_message(conn_id) {
            send_one(&tx, ServerMessage::Error { message: "Slow down." });
            continue;
        }
        let Some(parsed) = parse_client_message(&text) else {
            send_one(&tx, ServerMessage::Error { message: "Malformed message." });
            continue;
        };
        if parsed == ClientMessage::Ping {
            send_one(&tx, ServerMessage::Pong);
            continue;
        }
        match apply(&mut r.game, &player_id, parsed) {
            Ok(()) => {
                r.last_active = Instant::now();
                r.broadcast();
                drop(r);
                drive_sims(room.clone());
                drive_ready(room.clone());
            }
            Err(e) => send_one(&tx, ServerMessage::Error { message: &e.0 }),
        }
    }
    {
        let mut r = room.lock().unwrap();
        r.conns.remove(&conn_id);
        r.msg_limiter.remove(&conn_id);
        r.broadcast();
    }
    if !room.lock().unwrap().closed {
        drive_ready(room.clone());
    }
    writer.abort();
}

/// Between rounds: move on as soon as every connected human is ready, or when the idle
/// deadline passes. Called after anything that could change the answer (a click, a round
/// ending, someone connecting or leaving); arms one timer per room for the deadline.
pub fn drive_ready(room: Arc<Mutex<Room>>) {
    let wait = {
        let mut r = room.lock().unwrap();
        let online: std::collections::HashSet<String> = r.conns.values().map(|c| c.player_id.clone()).collect();
        if let Some(why) = r.game.ready_outcome(&|id| online.contains(id)) {
            let _ = r.game.advance_after_ready(why);
            r.last_active = Instant::now();
            r.broadcast();
            drop(r);
            drive_sims(room.clone());
            return;
        }
        let Some(deadline) = r.game.round.as_ref().and_then(|x| x.ready_deadline) else { return };
        if r.ready_timer {
            return;
        }
        r.ready_timer = true;
        Duration::from_millis((deadline - crate::engine::now_ms()).max(0) as u64 + 50)
    };
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        room.lock().unwrap().ready_timer = false;
        drive_ready(room);
    });
}

/// If a sim is due to act, schedule its move after a human-paced delay
/// (long enough for the previous card's 3D animation to land). One pending move per room.
pub fn drive_sims(room: Arc<Mutex<Room>>) {
    let (delay, sim, choice) = {
        let mut r = room.lock().unwrap();
        if r.sim_pending {
            return;
        }
        let Some(sim) = r.game.next_sim() else { return };
        // SIM_SKILL (0..1) overrides how often sims make the right call
        let skill = std::env::var("SIM_SKILL").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(crate::engine::SIM_SKILL);
        let Some(choice) = r.game.sim_choice(&sim, skill) else { return };
        r.sim_pending = true;
        let identify = r.game.round.as_ref().map(|x| x.status == RoundStatus::Identify).unwrap_or(false);
        let jitter = u64::from(u16::from_le_bytes(random_bytes::<2>()) % 700);
        // A card play is on screen for about 5s, so a sim waits that out before its first
        // action on a new card. Checks after that are quick reveals, and so is the decision
        // that follows them. SIM_DELAY_MS overrides the pacing (tests run sims fast).
        let quick = r.game.checks_started();
        let delay = match std::env::var("SIM_DELAY_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
            Some(ms) => Duration::from_millis(ms),
            None => Duration::from_millis(if identify { 500 + jitter } else if quick { 1500 + jitter } else { 5600 + jitter }),
        };
        (delay, sim, choice)
    };
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        {
            let mut r = room.lock().unwrap();
            r.sim_pending = false;
            // only act if it is still this sim's move (a person may have taken the seat meanwhile)
            if r.game.next_sim().as_deref() == Some(sim.as_str()) && apply(&mut r.game, &sim, choice).is_ok() {
                r.last_active = Instant::now();
                r.broadcast();
            }
        }
        drive_sims(room.clone());
        drive_ready(room);
    });
}

/// Strict parse: size-limited, known message types only, no extra fields.
pub fn parse_client_message(raw: &str) -> Option<ClientMessage> {
    if raw.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = v.as_object()?;
    let allowed: &[&str] = match obj.get("t")?.as_str()? {
        "ping" | "stand" | "start" | "tell" => &["t"],
        "ready" => &["t", "ready"],
        "sit" => &["t", "role"],
        "play" => &["t", "cardId"],
        "identify" => &["t", "flow"],
        "host" => &["t", "action", "round"],
        _ => return None,
    };
    if !obj.keys().all(|k| allowed.contains(&k.as_str())) {
        return None;
    }
    if let Some(id) = obj.get("cardId") {
        let s = id.as_str()?;
        if s.is_empty() || s.len() > 64 {
            return None;
        }
    }
    if let Some(r) = obj.get("round") {
        if r.as_u64().map(|n| n >= 1000).unwrap_or(true) {
            return None;
        }
    }
    serde_json::from_value(v).ok()
}

pub fn apply(g: &mut Game, player_id: &str, m: ClientMessage) -> Result<(), GameError> {
    match m {
        ClientMessage::Sit { role } => g.sit(player_id, role),
        ClientMessage::Stand => g.stand(player_id),
        ClientMessage::Start => g.start(player_id),
        ClientMessage::Play { card_id } => g.play(player_id, &card_id),
        ClientMessage::Identify { flow } => g.identify(player_id, flow),
        ClientMessage::Tell => g.tell(player_id),
        ClientMessage::Host { action, round } => g.host_action(player_id, action, round),
        ClientMessage::Ready { ready } => g.set_ready(player_id, ready),
        ClientMessage::Ping => Ok(()),
    }
}

/// Drop rooms nobody has touched for a while.
pub fn spawn_reaper(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            state.rooms.lock().unwrap().retain(|_, r| {
                let r = r.lock().unwrap();
                !r.conns.is_empty() || r.last_active.elapsed() < IDLE_TTL
            });
        }
    });
}

const ROOT_REDIRECT: &str = "/__omcp_root";
const OUTSIDE: &str = "/__omcp_outside";

/// Where a request path lands once the base path (e.g. /mcp-oauth) is taken off.
/// Paths under the base lose the prefix; the bare origin and the bare base redirect to the
/// app's home; the load balancer's /api/health stays reachable at the root; anything else
/// outside the base is a 404 (nothing is served from the root by accident).
pub fn route_under_base(path: &str, base: &str) -> String {
    if base.is_empty() {
        return path.to_string();
    }
    if path == "/" || path == base {
        return ROOT_REDIRECT.to_string();
    }
    if let Some(rest) = path.strip_prefix(base) {
        if rest.starts_with('/') {
            return rest.to_string();
        }
    }
    if path == "/api/health" { path.to_string() } else { OUTSIDE.to_string() }
}

/// Wrap the app so the base path is stripped before routing.
pub fn with_base_path(app: Router, base: String) -> impl tower::Service<axum::extract::Request, Response = Response, Error = std::convert::Infallible, Future: Send> + Clone + Send + 'static {
    use tower::ServiceExt;
    app.map_request(move |mut req: axum::extract::Request| {
        if !base.is_empty() {
            let uri = req.uri();
            let path = route_under_base(uri.path(), &base);
            let pq = match uri.query() {
                Some(q) => format!("{path}?{q}"),
                None => path,
            };
            if let Ok(new) = pq.parse() {
                *req.uri_mut() = new;
            }
        }
        req
    })
}

pub fn router(state: Arc<AppState>, static_dir: &std::path::Path) -> Router {
    let api = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/config", get(public_config))
        .route("/api/admin/login", post(crate::admin::login))
        .route("/api/admin/logout", post(crate::admin::logout))
        .route("/api/admin/rooms", get(crate::admin::rooms))
        .route("/api/admin/rooms/{name}", axum::routing::delete(crate::admin::delete_room))
        .route("/api/rooms", get(list_rooms).post(create_room))
        .route("/api/rooms/{name}/join", post(join_room))
        .route("/api/rooms/{name}/history", get(room_history))
        .route("/ws/{name}", get(ws_handler));
    let index = static_dir.join("404.html");
    let files = ServeDir::new(static_dir).append_index_html_on_directories(true).not_found_service(ServeFile::new(index));
    let home = format!("{}/", state.base_path);
    let api = api.route(ROOT_REDIRECT, get(move || {
        let home = home.clone();
        async move { axum::response::Redirect::temporary(&home) }
    }));
    let mut app = api.fallback_service(files).with_state(state.clone());
    if let Some(origin) = &state.dev_origin {
        // local development: Next dev server on another port talks to this API
        app = app.layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(HeaderValue::from_str(origin).unwrap())
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([header::CONTENT_TYPE])
                .allow_credentials(true),
        );
    }
    app.layer(tower_http::set_header::SetResponseHeaderLayer::if_not_present(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    ))
    .layer(tower_http::set_header::SetResponseHeaderLayer::if_not_present(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    ))
}
