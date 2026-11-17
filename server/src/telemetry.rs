//! Telemetry: the same places jdetle.com reports to, so breakage shows up where it is watched.
//!
//! - s10 (first-party observability on Azure): `kind=event|metric|bug` envelopes, NDJSON,
//!   `POST {S10_INGEST_URL}/v2/envelopes` with a bearer key, batched by a background thread.
//! - Sentry: errors and panics as Sentry envelopes (no SDK; one small POST per event).
//! - Two same-origin proxies for the browser: `/_s10/*` (the server adds the key) and
//!   `/monitoring` (Sentry's tunnel, accepted only for our own DSN). Ad-blockers and CORS
//!   then can't hide a broken page from us.
//!
//! Everything is a no-op when its settings are unset (local dev, tests, forks).

use std::sync::OnceLock;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

pub const DEFAULT_S10_URL: &str = "https://ca-s10-ingest.purplewave-fe0ae338.eastus2.azurecontainerapps.io";
const SERVICE: &str = "oauth-mcp-cards";

#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub s10_url: String,
    pub s10_key: Option<String>,
    pub sentry_dsn: Option<String>,
    pub environment: String,
    pub release: String,
}

impl Settings {
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Settings {
            s10_url: get("S10_INGEST_URL").unwrap_or_else(|| DEFAULT_S10_URL.to_string()),
            s10_key: get("S10_INGEST_KEY"),
            sentry_dsn: get("SENTRY_DSN"),
            environment: get("TELEMETRY_ENV").unwrap_or_else(|| "production".into()),
            release: get("RELEASE").unwrap_or_else(|| env!("CARGO_PKG_VERSION").into()),
        }
    }
}

/// A parsed Sentry DSN: `https://<key>@<host>/<project>`.
#[derive(Clone, Debug, PartialEq)]
pub struct Dsn {
    pub key: String,
    pub host: String,
    pub project: String,
}

impl Dsn {
    pub fn parse(dsn: &str) -> Option<Dsn> {
        let rest = dsn.trim().strip_prefix("https://")?;
        let (key, rest) = rest.split_once('@')?;
        let (host, project) = rest.split_once('/')?;
        let project = project.trim_end_matches('/');
        let ok = !key.is_empty()
            && key.bytes().all(|b| b.is_ascii_alphanumeric())
            && (host == "sentry.io" || host.ends_with(".sentry.io"))
            && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && !project.is_empty()
            && project.bytes().all(|b| b.is_ascii_digit());
        ok.then(|| Dsn { key: key.into(), host: host.into(), project: project.into() })
    }
    pub fn envelope_url(&self) -> String {
        format!("https://{}/api/{}/envelope/", self.host, self.project)
    }
    pub fn auth_header(&self) -> String {
        format!("Sentry sentry_version=7, sentry_key={}, sentry_client={SERVICE}/1", self.key)
    }
}

enum Msg {
    S10(Value),
    Sentry(String),
}

struct Telemetry {
    settings: Settings,
    dsn: Option<Dsn>,
    tx: Sender<Msg>,
    session: String,
}

static T: OnceLock<Telemetry> = OnceLock::new();

/// Start the background sender. Call once at startup; later calls are ignored.
pub fn init(settings: Settings) {
    let dsn = settings.sentry_dsn.as_deref().and_then(Dsn::parse);
    if settings.sentry_dsn.is_some() && dsn.is_none() {
        eprintln!("telemetry: SENTRY_DSN is not a sentry.io DSN; Sentry off");
    }
    let (tx, rx) = channel();
    let t = Telemetry { settings: settings.clone(), dsn: dsn.clone(), tx, session: ulid() };
    if T.set(t).is_err() {
        return;
    }
    let (url, key) = (format!("{}/v2/envelopes", settings.s10_url.trim_end_matches('/')), settings.s10_key.clone());
    std::thread::Builder::new()
        .name("telemetry".into())
        .spawn(move || sender(rx, url, key, dsn))
        .ok();
    install_panic_hook();
    eprintln!(
        "telemetry: s10 {} · Sentry {}",
        if settings.s10_key.is_some() { "on" } else { "off (set S10_INGEST_KEY)" },
        if T.get().and_then(|t| t.dsn.as_ref()).is_some() { "on" } else { "off (set SENTRY_DSN)" },
    );
}

/// The server's s10 key and ingest URL, for the browser proxy.
pub fn s10_target() -> Option<(String, String)> {
    let t = T.get()?;
    Some((format!("{}/v2/envelopes", t.settings.s10_url.trim_end_matches('/')), t.settings.s10_key.clone()?))
}

pub fn dsn() -> Option<Dsn> {
    T.get()?.dsn.clone()
}

/// A named event: `event("room.created", json!({"scenario": "obo"}))`.
pub fn event(name: &str, attrs: Value) {
    send_s10("event", name, attrs, None, None);
}

/// A measurement set: `metric("rooms.active", json!({"rooms": 3}), json!({}))`.
pub fn metric(name: &str, measurements: Value, attrs: Value) {
    send_s10("metric", name, attrs, Some(measurements), None);
}

/// Something broke: goes to s10 as a `bug` and to Sentry as an error.
pub fn error(message: &str, attrs: Value) {
    report_error("error", message, None, attrs);
}

fn report_error(kind: &str, message: &str, stack: Option<String>, attrs: Value) {
    send_s10("bug", message, attrs.clone(), None, Some(json!({ "stack": stack, "kind": kind })));
    let Some(t) = T.get() else { return };
    if let Some(dsn) = &t.dsn {
        let ev = sentry_event(message, kind, stack.as_deref(), &attrs, &t.settings);
        let _ = t.tx.send(Msg::Sentry(sentry_envelope(&ev, dsn)));
    }
}

fn send_s10(kind: &str, name: &str, attrs: Value, measurements: Option<Value>, bug: Option<Value>) {
    let Some(t) = T.get() else { return };
    if t.settings.s10_key.is_none() {
        return;
    }
    let mut env = envelope(kind, name, attrs, &t.settings, &t.session);
    if let Some(m) = measurements {
        env["measurements"] = m;
    }
    if let Some(b) = bug {
        env["category"] = json!("error");
        env["bug"] = b;
    }
    let _ = t.tx.send(Msg::S10(env));
}

/// One s10 v2 SignalEnvelope.
pub fn envelope(kind: &str, name: &str, attrs: Value, s: &Settings, session: &str) -> Value {
    let attrs = match attrs {
        Value::Object(m) => Value::Object(m),
        Value::Null => Value::Object(Map::new()),
        other => json!({ "value": other }),
    };
    json!({
        "schema_version": "s10/2",
        "signal_id": ulid(),
        "occurred_at": iso_now(),
        "kind": kind,
        "name": name,
        "attributes": attrs,
        "identity": { "anonymous_id": session, "session_id": session },
        "resource": { "service_name": SERVICE, "environment": s.environment, "service_version": s.release },
    })
}

pub fn sentry_event(message: &str, kind: &str, stack: Option<&str>, attrs: &Value, s: &Settings) -> Value {
    json!({
        "event_id": uuid_hex(),
        "timestamp": now_secs_f64(),
        "platform": "native",
        "level": "error",
        "logger": SERVICE,
        "server_name": SERVICE,
        "environment": s.environment,
        "release": format!("{SERVICE}@{}", s.release),
        "tags": { "surface": "server", "kind": kind },
        "exception": { "values": [{ "type": kind, "value": message }] },
        "extra": { "attributes": attrs, "backtrace": stack },
    })
}

pub fn sentry_envelope(event: &Value, dsn: &Dsn) -> String {
    let head = json!({ "event_id": event["event_id"], "sent_at": iso_now(), "dsn": format!("https://{}@{}/{}", dsn.key, dsn.host, dsn.project) });
    format!("{head}\n{{\"type\":\"event\"}}\n{event}\n")
}

fn sender(rx: Receiver<Msg>, s10_url: String, s10_key: Option<String>, dsn: Option<Dsn>) {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build();
    let mut batch: Vec<String> = Vec::new();
    let flush = |batch: &mut Vec<String>| {
        if batch.is_empty() {
            return;
        }
        if let Some(key) = &s10_key {
            let body = batch.join("\n") + "\n";
            let r = agent
                .post(&s10_url)
                .set("authorization", &format!("Bearer {key}"))
                .set("content-type", "application/x-ndjson")
                .send_string(&body);
            if let Err(e) = r {
                eprintln!("telemetry: s10 send failed: {e}");
            }
        }
        batch.clear();
    };
    loop {
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Msg::S10(v)) => {
                batch.push(v.to_string());
                if batch.len() >= 32 {
                    flush(&mut batch);
                }
            }
            Ok(Msg::Sentry(body)) => {
                if let Some(d) = &dsn {
                    let r = agent
                        .post(&d.envelope_url())
                        .set("x-sentry-auth", &d.auth_header())
                        .set("content-type", "application/x-sentry-envelope")
                        .send_string(&body);
                    if let Err(e) = r {
                        eprintln!("telemetry: Sentry send failed: {e}");
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => flush(&mut batch),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                flush(&mut batch);
                return;
            }
        }
    }
}

/// Send whatever is queued now and wait briefly (shutdown, after a panic).
pub fn flush_blocking() {
    // the sender drains every 2 s; give it one cycle
    if T.get().is_some() {
        std::thread::sleep(Duration::from_millis(2500));
    }
}

fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        report_error("panic", &format!("panic: {msg}"), Some(bt), json!({ "location": at }));
        prev(info);
    }));
}

// ---------- ids and time ----------

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32 (26 chars).
pub fn ulid() -> String {
    use rand::RngCore;
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u128).unwrap_or(0) & ((1u128 << 48) - 1);
    let mut r = [0u8; 10];
    rand::thread_rng().fill_bytes(&mut r);
    let mut v: u128 = ms << 80;
    for (i, b) in r.iter().enumerate() {
        v |= (*b as u128) << (72 - 8 * i);
    }
    (0..26).rev().map(|i| CROCKFORD[((v >> (5 * i)) & 31) as usize] as char).collect()
}

fn uuid_hex() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

fn now_secs_f64() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// RFC 3339 UTC with milliseconds, e.g. 2026-11-16T18:21:09.123Z.
pub fn iso_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso_from_ms(d.as_millis() as i64)
}

pub fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

// ---------- browser proxies ----------

/// Is this Sentry envelope (from the browser) for our own project? Returns the upstream URL.
pub fn tunnel_target(body: &[u8], ours: &Dsn) -> Option<String> {
    let first = body.split(|b| *b == b'\n').next()?;
    let head: Value = serde_json::from_slice(first).ok()?;
    let theirs = Dsn::parse(head.get("dsn")?.as_str()?)?;
    (theirs.host == ours.host && theirs.project == ours.project).then(|| ours.envelope_url())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dsn() {
        let d = Dsn::parse("https://abc123@o1.ingest.us.sentry.io/456").unwrap();
        assert_eq!(d, Dsn { key: "abc123".into(), host: "o1.ingest.us.sentry.io".into(), project: "456".into() });
        assert_eq!(d.envelope_url(), "https://o1.ingest.us.sentry.io/api/456/envelope/");
        assert!(d.auth_header().contains("sentry_key=abc123"));
        assert!(Dsn::parse("http://abc@o1.ingest.sentry.io/1").is_none());
        assert!(Dsn::parse("https://abc@evil.example/1").is_none());
        assert!(Dsn::parse("https://abc@o1.ingest.sentry.io/x").is_none());
        assert!(Dsn::parse("https://@o1.ingest.sentry.io/1").is_none());
    }

    #[test]
    fn ulids_are_26_crockford_chars_and_sort_by_time() {
        let a = ulid();
        std::thread::sleep(Duration::from_millis(3));
        let b = ulid();
        assert_eq!(a.len(), 26);
        assert!(a.bytes().all(|c| CROCKFORD.contains(&c)));
        assert!(a[..10] < b[..10]);
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_763_317_269_123), "2025-11-16T18:21:09.123Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert!(iso_now().ends_with('Z'));
    }

    #[test]
    fn envelope_shape() {
        let s = Settings { environment: "test".into(), release: "1".into(), ..Default::default() };
        let e = envelope("event", "room.created", json!({"scenario": "obo"}), &s, "S");
        assert_eq!(e["schema_version"], "s10/2");
        assert_eq!(e["kind"], "event");
        assert_eq!(e["attributes"]["scenario"], "obo");
        assert_eq!(e["resource"]["service_name"], SERVICE);
        assert_eq!(e["identity"]["session_id"], "S");
        assert_eq!(envelope("event", "x", Value::Null, &s, "S")["attributes"], json!({}));
        assert_eq!(envelope("event", "x", json!(3), &s, "S")["attributes"]["value"], 3);
    }

    #[test]
    fn sentry_envelope_shape() {
        let s = Settings { environment: "test".into(), release: "1".into(), ..Default::default() };
        let d = Dsn::parse("https://k@o1.ingest.sentry.io/9").unwrap();
        let ev = sentry_event("boom", "error", Some("bt"), &json!({"a": 1}), &s);
        let body = sentry_envelope(&ev, &d);
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1], r#"{"type":"event"}"#);
        let parsed: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(parsed["exception"]["values"][0]["value"], "boom");
        assert_eq!(parsed["extra"]["backtrace"], "bt");
        assert_eq!(parsed["event_id"].as_str().unwrap().len(), 32);
    }

    #[test]
    fn tunnel_only_forwards_our_project() {
        let ours = Dsn::parse("https://k@o1.ingest.us.sentry.io/9").unwrap();
        let ok = b"{\"dsn\":\"https://k@o1.ingest.us.sentry.io/9\"}\n{\"type\":\"event\"}\n{}\n";
        assert_eq!(tunnel_target(ok, &ours).as_deref(), Some("https://o1.ingest.us.sentry.io/api/9/envelope/"));
        let other = b"{\"dsn\":\"https://k@o1.ingest.us.sentry.io/10\"}\n";
        assert!(tunnel_target(other, &ours).is_none());
        assert!(tunnel_target(b"not json\n", &ours).is_none());
        assert!(tunnel_target(b"{}\n", &ours).is_none());
    }

    #[test]
    fn disabled_is_a_no_op() {
        // never initialised in unit tests: every call returns quietly
        event("x", json!({}));
        metric("x", json!({"n": 1}), json!({}));
        error("x", json!({}));
        assert!(s10_target().is_none() && dsn().is_none());
    }
}
