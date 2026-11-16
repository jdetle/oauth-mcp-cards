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

struct Conn {
    player_id: String,
    tx: mpsc::Sender<Message>,
}

pub struct Room {
    pub game: Game,
    password_hash: String,
    conns: HashMap<u64, Conn>,
    pub last_active: Instant,
    msg_limiter: HashMap<u64, VecDeque<Instant>>,
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

pub struct AppState {
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
    pub fn new(scenarios: Vec<Scenario>, internal_token: Option<String>, secure_cookies: bool, dev_origin: Option<String>) -> Arc<Self> {
        Arc::new(AppState {
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

    fn room(&self, name: &str) -> Option<Arc<Mutex<Room>>> {
        self.rooms.lock().unwrap().get(name).cloned()
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

fn client_ip(headers: &HeaderMap, addr: &SocketAddr) -> String {
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

fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

fn error(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinBody {
    password: Option<String>,
    display_name: Option<String>,
    role: Option<String>,
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
        "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400{}",
        cookie_name(room),
        if state.secure_cookies { "; Secure" } else { "" }
    );
    let mut res = Json(json!({ "room": room, "playerId": player.id, "role": player.role })).into_response();
    res.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    res
}

// ---- handlers ----------------------------------------------------------------------------------

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
    // load tests present the internal token to skip the per-IP limit
    let trusted = state.internal_token.as_ref().is_some_and(|t| headers.get("x-omcp-internal").and_then(|v| v.to_str().ok()) == Some(t.as_str()));
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
    let (pref, spectate) = seat_choice(&body.role);
    let player = game.add_player(body.display_name.as_deref().unwrap_or("Player"), pref, spectate);
    rooms.insert(
        name.clone(),
        Arc::new(Mutex::new(Room { game, password_hash: hash, conns: HashMap::new(), last_active: Instant::now(), msg_limiter: HashMap::new() })),
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
    joined(&state, &name, &player)
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
    writer.abort();
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

pub fn router(state: Arc<AppState>, static_dir: &std::path::Path) -> Router {
    let api = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/rooms", get(list_rooms).post(create_room))
        .route("/api/rooms/{name}/join", post(join_room))
        .route("/ws/{name}", get(ws_handler));
    let index = static_dir.join("404.html");
    let files = ServeDir::new(static_dir).append_index_html_on_directories(true).not_found_service(ServeFile::new(index));
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
