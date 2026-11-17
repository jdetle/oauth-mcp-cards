//! The few AWS calls this server makes (DynamoDB for rooms, ECS to put itself to sleep), as
//! signed JSON POSTs. No SDK: credentials from the Fargate task role, Signature Version 4.

use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone)]
struct Creds {
    key: String,
    secret: String,
    token: Option<String>,
    /// refresh after this (ms since epoch); i64::MAX for static keys
    until_ms: i64,
}

pub struct Aws {
    pub region: String,
    agent: ureq::Agent,
    creds: Mutex<Option<Creds>>,
}

impl Aws {
    pub fn new(region: String) -> Self {
        Aws { region, agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build(), creds: Mutex::new(None) }
    }

    pub fn from_env() -> Self {
        Self::new(std::env::var("AWS_REGION").or_else(|_| std::env::var("AWS_DEFAULT_REGION")).unwrap_or_else(|_| "us-east-1".into()))
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

    /// One JSON-protocol call, e.g. `call("dynamodb", "DynamoDB_20120810.GetItem", "application/x-amz-json-1.0", &body)`.
    pub fn call(&self, service: &str, target: &str, content_type: &str, body: &serde_json::Value) -> Result<serde_json::Value, (u16, String)> {
        let creds = self.creds().map_err(|e| (0, e))?;
        let host = format!("{service}.{}.amazonaws.com", self.region);
        let body = body.to_string();
        let amz = amz_date(crate::engine::now_ms());
        let auth = sigv4(&creds, &self.region, service, &host, target, content_type, &amz, &body);
        let mut req = self
            .agent
            .post(&format!("https://{host}/"))
            .set("content-type", content_type)
            .set("x-amz-date", &amz)
            .set("x-amz-target", target)
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

    pub fn get_json(&self, url: &str) -> Option<serde_json::Value> {
        self.agent.get(url).call().ok()?.into_json().ok()
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

/// The Authorization header for a JSON-protocol request (AWS Signature Version 4).
#[allow(clippy::too_many_arguments)]
fn sigv4(c: &Creds, region: &str, service: &str, host: &str, target: &str, content_type: &str, amz: &str, body: &str) -> String {
    let date = &amz[..8];
    let mut headers = vec![("content-type", content_type.to_string()), ("host", host.to_string()), ("x-amz-date", amz.to_string()), ("x-amz-target", target.to_string())];
    if let Some(t) = &c.token {
        headers.push(("x-amz-security-token", t.clone()));
    }
    headers.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{}\n", v.trim())).collect();
    let signed: Vec<&str> = headers.iter().map(|(k, _)| *k).collect();
    let signed = signed.join(";");
    let canonical = format!("POST\n/\n\n{canonical_headers}\n{signed}\n{}", sha256_hex(body));
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}", sha256_hex(&canonical));
    let k = crate::crypto::hmac_bytes(format!("AWS4{}", c.secret).as_bytes(), date);
    let k = crate::crypto::hmac_bytes(&k, region);
    let k = crate::crypto::hmac_bytes(&k, service);
    let k = crate::crypto::hmac_bytes(&k, "aws4_request");
    let sig = crate::crypto::hmac_hex(&k, &to_sign);
    format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={sig}", c.key)
}

/// Ask ECS to run zero copies of this service. The task then gets SIGTERM and exits; the edge
/// Worker starts it again when someone turns up. Cluster and service come from the task
/// metadata endpoint (or ECS_CLUSTER / ECS_SERVICE).
pub fn scale_self_to_zero() -> Result<(), String> {
    let aws = Aws::from_env();
    let meta = std::env::var("ECS_CONTAINER_METADATA_URI_V4").ok().and_then(|u| aws.get_json(&format!("{u}/task")));
    let pick = |env: &str, key: &str| std::env::var(env).ok().filter(|v| !v.is_empty()).or_else(|| meta.as_ref()?.get(key)?.as_str().map(str::to_string));
    let cluster = pick("ECS_CLUSTER", "Cluster").ok_or("don't know my cluster")?;
    let service = pick("ECS_SERVICE", "ServiceName").ok_or("don't know my service")?;
    aws.call(
        "ecs",
        "AmazonEC2ContainerServiceV20141113.UpdateService",
        "application/x-amz-json-1.1",
        &serde_json::json!({ "cluster": cluster, "service": service, "desiredCount": 0 }),
    )
    .map(|_| ())
    .map_err(|(c, e)| format!("UpdateService {c}: {}", e.chars().take(200).collect::<String>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amz_dates() {
        assert_eq!(amz_date(1_763_317_269_123), "20251116T182109Z");
    }

    /// Pins our canonical form so a refactor can't silently change what gets signed.
    #[test]
    fn sigv4_header_shape() {
        let c = Creds { key: "AKIDEXAMPLE".into(), secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(), token: Some("tok".into()), until_ms: i64::MAX };
        let sign = |body: &str| sigv4(&c, "us-east-1", "dynamodb", "dynamodb.us-east-1.amazonaws.com", "DynamoDB_20120810.GetItem", "application/x-amz-json-1.0", "20261116T000000Z", body);
        let a = sign("{}");
        assert!(a.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261116/us-east-1/dynamodb/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature="));
        assert_eq!(a.rsplit('=').next().unwrap().len(), 64);
        assert_ne!(a, sign("{ }"), "the body is signed");
    }
}
