//! Where games live between servers. Every change to a room is written here, so a deploy (or a
//! crash) can replace the server under a live game: the next server loads the room on demand.
//!
//! One record per room, with a version. A write only succeeds if the stored version is the one
//! this server last saw, so if two servers ever touch the same game at once (the few seconds a
//! deploy overlaps), the one that's behind reloads instead of overwriting the other.
//!
//! Backends: DynamoDB in production (`ROOMS_TABLE`), a directory for local runs and tests
//! (`ROOMS_DIR`), or off.

use crate::engine::Game;
use crate::scenario::Scenario;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Games idle longer than this are gone (also the DynamoDB TTL).
pub const KEEP_MS: i64 = 6 * 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub room: String,
    pub password_hash: String,
    /// gzip'd JSON of the Game
    pub game: Vec<u8>,
    pub version: u64,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Debug, PartialEq)]
pub enum SaveError {
    /// someone else saved a newer version first
    Conflict,
    Failed(String),
}

pub trait Backend: Send + Sync {
    fn name(&self) -> &'static str;
    fn get(&self, room: &str) -> Result<Option<Record>, String>;
    /// Write `rec` if the stored version is `base` (0 = must not exist yet).
    fn put(&self, rec: &Record, base: u64) -> Result<(), SaveError>;
    fn delete(&self, room: &str) -> Result<(), String>;
    /// Rooms updated after `since_ms`.
    fn recent(&self, since_ms: i64) -> Result<Vec<Record>, String>;
}

pub fn encode(game: &Game) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(game).map_err(|e| e.to_string())?;
    let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    z.write_all(&json).map_err(|e| e.to_string())?;
    z.finish().map_err(|e| e.to_string())
}

pub fn decode(bytes: &[u8], scenarios: Arc<Vec<Scenario>>) -> Result<Game, String> {
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(bytes).read_to_end(&mut json).map_err(|e| e.to_string())?;
    let mut g: Game = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
    g.scenarios = scenarios;
    Ok(g)
}

/// From the environment: `ROOMS_TABLE` (DynamoDB) or `ROOMS_DIR` (files), else none.
pub fn from_env() -> Option<Arc<dyn Backend>> {
    if let Ok(table) = std::env::var("ROOMS_TABLE").map(|t| t.trim().to_string()).and_then(|t| if t.is_empty() { Err(std::env::VarError::NotPresent) } else { Ok(t) }) {
        let region = std::env::var("AWS_REGION").or_else(|_| std::env::var("AWS_DEFAULT_REGION")).unwrap_or_else(|_| "us-east-1".into());
        return Some(Arc::new(Dynamo::new(table, region)));
    }
    if let Ok(dir) = std::env::var("ROOMS_DIR") {
        if !dir.trim().is_empty() {
            return Some(Arc::new(Dir::new(PathBuf::from(dir))));
        }
    }
    None
}

// ---------- files (local runs and tests) ----------

pub struct Dir {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Dir {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Dir { dir, lock: Mutex::new(()) }
    }
    fn path(&self, room: &str) -> PathBuf {
        self.dir.join(format!("{}.json", room.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_")))
    }
    fn read(&self, path: &std::path::Path) -> Option<Record> {
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        Some(Record {
            room: v["room"].as_str()?.into(),
            password_hash: v["pw"].as_str()?.into(),
            game: hex::decode(v["game"].as_str()?).ok()?,
            version: v["version"].as_u64()?,
            created_ms: v["created"].as_i64()?,
            updated_ms: v["updated"].as_i64()?,
        })
    }
}

impl Backend for Dir {
    fn name(&self) -> &'static str {
        "files"
    }
    fn get(&self, room: &str) -> Result<Option<Record>, String> {
        let _g = self.lock.lock().unwrap();
        Ok(self.read(&self.path(room)))
    }
    fn put(&self, rec: &Record, base: u64) -> Result<(), SaveError> {
        let _g = self.lock.lock().unwrap();
        let path = self.path(&rec.room);
        let stored = self.read(&path).map(|r| r.version).unwrap_or(0);
        if stored != base {
            return Err(SaveError::Conflict);
        }
        let v = serde_json::json!({ "room": rec.room, "pw": rec.password_hash, "game": hex::encode(&rec.game), "version": rec.version, "created": rec.created_ms, "updated": rec.updated_ms });
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, v.to_string()).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| SaveError::Failed(e.to_string()))
    }
    fn delete(&self, room: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        match std::fs::remove_file(self.path(room)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
    fn recent(&self, since_ms: i64) -> Result<Vec<Record>, String> {
        let _g = self.lock.lock().unwrap();
        let mut out = Vec::new();
        for e in std::fs::read_dir(&self.dir).map_err(|e| e.to_string())?.flatten() {
            if e.path().extension().is_some_and(|x| x == "json") {
                if let Some(r) = self.read(&e.path()).filter(|r| r.updated_ms > since_ms) {
                    out.push(r);
                }
            }
        }
        Ok(out)
    }
}

// ---------- DynamoDB (no SDK: one signed JSON POST per call) ----------

#[derive(Clone)]
struct Creds {
    key: String,
    secret: String,
    token: Option<String>,
    /// refresh after this (ms since epoch); i64::MAX for static keys
    until_ms: i64,
}

pub struct Dynamo {
    table: String,
    region: String,
    host: String,
    agent: ureq::Agent,
    creds: Mutex<Option<Creds>>,
}

impl Dynamo {
    pub fn new(table: String, region: String) -> Self {
        let host = format!("dynamodb.{region}.amazonaws.com");
        Dynamo { table, region, host, agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build(), creds: Mutex::new(None) }
    }

    /// Fargate task role (container credentials endpoint), else static keys from the environment.
    fn creds(&self) -> Result<Creds, String> {
        let now = crate::engine::now_ms();
        if let Some(c) = self.creds.lock().unwrap().clone().filter(|c| c.until_ms > now) {
            return Ok(c);
        }
        let c = if let Ok(rel) = std::env::var("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") {
            let v: serde_json::Value = self
                .agent
                .get(&format!("http://169.254.170.2{rel}"))
                .call()
                .map_err(|e| format!("credentials: {e}"))?
                .into_json()
                .map_err(|e| format!("credentials: {e}"))?;
            Creds {
                key: v["AccessKeyId"].as_str().ok_or("credentials: no key")?.into(),
                secret: v["SecretAccessKey"].as_str().ok_or("credentials: no secret")?.into(),
                token: v["Token"].as_str().map(str::to_string),
                // refresh well before they expire (they last hours; 10 min is plenty of margin)
                until_ms: now + 10 * 60 * 1000,
            }
        } else {
            Creds {
                key: std::env::var("AWS_ACCESS_KEY_ID").map_err(|_| "no AWS credentials")?,
                secret: std::env::var("AWS_SECRET_ACCESS_KEY").map_err(|_| "no AWS credentials")?,
                token: std::env::var("AWS_SESSION_TOKEN").ok(),
                until_ms: i64::MAX,
            }
        };
        *self.creds.lock().unwrap() = Some(c.clone());
        Ok(c)
    }

    fn call(&self, op: &str, body: serde_json::Value) -> Result<serde_json::Value, (u16, String)> {
        let creds = self.creds().map_err(|e| (0, e))?;
        let body = body.to_string();
        let target = format!("DynamoDB_20120810.{op}");
        let amz = amz_date(crate::engine::now_ms());
        let auth = sigv4_dynamo(&creds, &self.region, &self.host, &target, &amz, &body);
        let mut req = self
            .agent
            .post(&format!("https://{}/", self.host))
            .set("content-type", "application/x-amz-json-1.0")
            .set("x-amz-date", &amz)
            .set("x-amz-target", &target)
            .set("authorization", &auth);
        if let Some(t) = &creds.token {
            req = req.set("x-amz-security-token", t);
        }
        match req.send_string(&body) {
            Ok(r) => r.into_json().map_err(|e| (0, e.to_string())),
            Err(ureq::Error::Status(code, r)) => {
                if code == 403 {
                    // maybe expired credentials: fetch fresh ones next time
                    *self.creds.lock().unwrap() = None;
                }
                Err((code, r.into_string().unwrap_or_default()))
            }
            Err(e) => Err((0, e.to_string())),
        }
    }

    fn item(rec: &Record) -> serde_json::Value {
        use base64::Engine;
        serde_json::json!({
            "room": { "S": rec.room },
            "pw": { "S": rec.password_hash },
            "game": { "B": base64::engine::general_purpose::STANDARD.encode(&rec.game) },
            "version": { "N": rec.version.to_string() },
            "created": { "N": rec.created_ms.to_string() },
            "updated": { "N": rec.updated_ms.to_string() },
            "expires": { "N": ((rec.updated_ms + KEEP_MS) / 1000).to_string() },
        })
    }

    fn record(item: &serde_json::Value) -> Option<Record> {
        use base64::Engine;
        let n = |k: &str| item[k]["N"].as_str()?.parse::<i64>().ok();
        Some(Record {
            room: item["room"]["S"].as_str()?.into(),
            password_hash: item["pw"]["S"].as_str()?.into(),
            game: base64::engine::general_purpose::STANDARD.decode(item["game"]["B"].as_str()?).ok()?,
            version: n("version")? as u64,
            created_ms: n("created")?,
            updated_ms: n("updated")?,
        })
    }
}

impl Backend for Dynamo {
    fn name(&self) -> &'static str {
        "DynamoDB"
    }
    fn get(&self, room: &str) -> Result<Option<Record>, String> {
        let v = self
            .call("GetItem", serde_json::json!({ "TableName": self.table, "Key": { "room": { "S": room } }, "ConsistentRead": true }))
            .map_err(|(c, e)| format!("GetItem {c}: {e}"))?;
        Ok(v.get("Item").and_then(Self::record).filter(|r| r.updated_ms + KEEP_MS > crate::engine::now_ms()))
    }
    fn put(&self, rec: &Record, base: u64) -> Result<(), SaveError> {
        let mut body = serde_json::json!({ "TableName": self.table, "Item": Self::item(rec) });
        if base == 0 {
            body["ConditionExpression"] = "attribute_not_exists(room)".into();
        } else {
            body["ConditionExpression"] = "version = :base".into();
            body["ExpressionAttributeValues"] = serde_json::json!({ ":base": { "N": base.to_string() } });
        }
        match self.call("PutItem", body) {
            Ok(_) => Ok(()),
            Err((400, e)) if e.contains("ConditionalCheckFailed") => Err(SaveError::Conflict),
            Err((c, e)) => Err(SaveError::Failed(format!("PutItem {c}: {e}"))),
        }
    }
    fn delete(&self, room: &str) -> Result<(), String> {
        self.call("DeleteItem", serde_json::json!({ "TableName": self.table, "Key": { "room": { "S": room } } }))
            .map(|_| ())
            .map_err(|(c, e)| format!("DeleteItem {c}: {e}"))
    }
    fn recent(&self, since_ms: i64) -> Result<Vec<Record>, String> {
        let mut out = Vec::new();
        let mut start: Option<serde_json::Value> = None;
        for _ in 0..50 {
            let mut body = serde_json::json!({
                "TableName": self.table,
                "FilterExpression": "updated > :since",
                "ExpressionAttributeValues": { ":since": { "N": since_ms.to_string() } },
            });
            if let Some(k) = start.take() {
                body["ExclusiveStartKey"] = k;
            }
            let v = self.call("Scan", body).map_err(|(c, e)| format!("Scan {c}: {e}"))?;
            out.extend(v["Items"].as_array().into_iter().flatten().filter_map(Self::record));
            match v.get("LastEvaluatedKey") {
                Some(k) if !k.is_null() => start = Some(k.clone()),
                _ => break,
            }
        }
        Ok(out)
    }
}

/// `20261116T182109Z`
pub fn amz_date(ms: i64) -> String {
    let iso = crate::telemetry::iso_from_ms(ms); // 2026-11-16T18:21:09.123Z
    format!("{}{}{}T{}{}{}Z", &iso[0..4], &iso[5..7], &iso[8..10], &iso[11..13], &iso[14..16], &iso[17..19])
}

fn sha256_hex(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

/// The Authorization header for a DynamoDB JSON request (AWS Signature Version 4).
fn sigv4_dynamo(c: &Creds, region: &str, host: &str, target: &str, amz: &str, body: &str) -> String {
    let date = &amz[..8];
    let mut headers = vec![
        ("content-type", "application/x-amz-json-1.0".to_string()),
        ("host", host.to_string()),
        ("x-amz-date", amz.to_string()),
        ("x-amz-target", target.to_string()),
    ];
    if let Some(t) = &c.token {
        headers.push(("x-amz-security-token", t.clone()));
    }
    headers.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{}\n", v.trim())).collect();
    let signed: Vec<&str> = headers.iter().map(|(k, _)| *k).collect();
    let signed = signed.join(";");
    let canonical = format!("POST\n/\n\n{canonical_headers}\n{signed}\n{}", sha256_hex(body));
    let scope = format!("{date}/{region}/dynamodb/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}", sha256_hex(&canonical));
    let k = crate::crypto::hmac_bytes(format!("AWS4{}", c.secret).as_bytes(), date);
    let k = crate::crypto::hmac_bytes(&k, region);
    let k = crate::crypto::hmac_bytes(&k, "dynamodb");
    let k = crate::crypto::hmac_bytes(&k, "aws4_request");
    let sig = crate::crypto::hmac_hex(&k, &to_sign);
    format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={sig}", c.key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(room: &str, v: u64) -> Record {
        Record { room: room.into(), password_hash: "salt:hash".into(), game: vec![1, 2, 3], version: v, created_ms: 1, updated_ms: crate::engine::now_ms() }
    }

    #[test]
    fn dir_store_versions_guard_against_overwrites() {
        let dir = std::env::temp_dir().join(format!("omcp-store-{}", crate::crypto::random_hex(6)));
        let s = Dir::new(dir.clone());
        assert_eq!(s.get("amber-otter").unwrap(), None);
        assert_eq!(s.put(&rec("amber-otter", 1), 0), Ok(()));
        // a second server that thinks the room is new loses
        assert_eq!(s.put(&rec("amber-otter", 1), 0), Err(SaveError::Conflict));
        assert_eq!(s.put(&rec("amber-otter", 2), 1), Ok(()));
        // one that's behind loses
        assert_eq!(s.put(&rec("amber-otter", 2), 1), Err(SaveError::Conflict));
        assert_eq!(s.get("amber-otter").unwrap().unwrap().version, 2);
        assert_eq!(s.recent(0).unwrap().len(), 1);
        assert_eq!(s.recent(crate::engine::now_ms() + 1000).unwrap().len(), 0);
        s.delete("amber-otter").unwrap();
        s.delete("amber-otter").unwrap();
        assert_eq!(s.get("amber-otter").unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dynamo_items_round_trip() {
        let r = rec("calm-heron", 7);
        assert_eq!(Dynamo::record(&Dynamo::item(&r)), Some(r.clone()));
        assert_eq!(Dynamo::item(&r)["expires"]["N"], ((r.updated_ms + KEEP_MS) / 1000).to_string());
    }

    #[test]
    fn amz_dates() {
        assert_eq!(amz_date(1_763_317_269_123), "20251116T182109Z");
    }

    /// AWS's published SigV4 example values are for other services; this pins our canonical
    /// form so a refactor can't silently change what gets signed.
    #[test]
    fn sigv4_header_shape() {
        let c = Creds { key: "AKIDEXAMPLE".into(), secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(), token: Some("tok".into()), until_ms: i64::MAX };
        let a = sigv4_dynamo(&c, "us-east-1", "dynamodb.us-east-1.amazonaws.com", "DynamoDB_20120810.GetItem", "20261116T000000Z", "{}");
        assert!(a.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261116/us-east-1/dynamodb/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature="));
        assert_eq!(a.rsplit('=').next().unwrap().len(), 64);
        let b = sigv4_dynamo(&c, "us-east-1", "dynamodb.us-east-1.amazonaws.com", "DynamoDB_20120810.GetItem", "20261116T000000Z", "{ }");
        assert_ne!(a, b, "the body is signed");
    }
}
