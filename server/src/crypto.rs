//! Crypto helpers: ed25519 signatures, HMAC-SHA256, scrypt passwords, randomness.
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hmac::{Hmac, KeyInit, Mac};
use rand::RngCore;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct KeyPair {
    pub secret_key: String,
    pub public_key: String,
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::thread_rng().fill_bytes(&mut b);
    b
}

pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

pub fn random_id() -> String {
    random_hex(12)
}

pub fn new_key_pair() -> KeyPair {
    let sk = SigningKey::from_bytes(&random_bytes::<32>());
    KeyPair { secret_key: hex::encode(sk.to_bytes()), public_key: hex::encode(sk.verifying_key().to_bytes()) }
}

pub fn ed_sign(message: &str, secret_hex: &str) -> String {
    let bytes: [u8; 32] = hex::decode(secret_hex).ok().and_then(|v| v.try_into().ok()).unwrap_or([0; 32]);
    hex::encode(SigningKey::from_bytes(&bytes).sign(message.as_bytes()).to_bytes())
}

pub fn ed_verify(message: &str, sig_hex: &str, public_hex: &str) -> bool {
    let Some(pk) = hex::decode(public_hex).ok().and_then(|v| <[u8; 32]>::try_from(v).ok()) else { return false };
    let Some(sig) = hex::decode(sig_hex).ok().and_then(|v| <[u8; 64]>::try_from(v).ok()) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    vk.verify(message.as_bytes(), &Signature::from_bytes(&sig)).is_ok()
}

pub fn hmac_bytes(key: &[u8], message: &str) -> Vec<u8> {
    let mut mac = <HmacSha256 as KeyInit>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

pub fn hmac_hex(key: &[u8], message: &str) -> String {
    hex::encode(hmac_bytes(key, message))
}

/// Constant-time comparison.
pub fn safe_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn hash_password(password: &str) -> String {
    hash_password_with(password, &random_hex(16))
}

fn hash_password_with(password: &str, salt_hex: &str) -> String {
    let salt = hex::decode(salt_hex).unwrap_or_default();
    let params = scrypt::Params::new(14, 8, 1).expect("valid scrypt params");
    let mut out = [0u8; 32];
    scrypt::scrypt(password.as_bytes(), &salt, &params, &mut out).expect("scrypt output length");
    format!("{salt_hex}:{}", hex::encode(out))
}

pub fn check_password(password: &str, stored: &str) -> bool {
    let Some((salt, hash)) = stored.split_once(':') else { return false };
    let again = hash_password_with(password, salt);
    safe_eq(again.split_once(':').map(|x| x.1).unwrap_or(""), hash)
}

/// Session tokens: `<playerId>.<hmac(secret, room:playerId)>`.
pub fn sign_session(room: &str, player_id: &str, secret: &[u8]) -> String {
    format!("{player_id}.{}", hmac_hex(secret, &format!("session:{room}:{player_id}")))
}

pub fn verify_session(room: &str, token: &str, secret: &[u8]) -> Option<String> {
    if token.len() > 200 {
        return None;
    }
    let (id, _) = token.split_once('.')?;
    if id.is_empty() {
        return None;
    }
    safe_eq(&sign_session(room, id, secret), token).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrips() {
        let kp = new_key_pair();
        let sig = ed_sign("hello", &kp.secret_key);
        assert!(ed_verify("hello", &sig, &kp.public_key));
        assert!(!ed_verify("hellO", &sig, &kp.public_key));
        assert!(!ed_verify("hello", "zz", &kp.public_key));
        let h = hash_password("pw-1234");
        assert!(check_password("pw-1234", &h));
        assert!(!check_password("pw-1235", &h));
        let s = sign_session("amber-falcon", "abc", b"secret");
        assert_eq!(verify_session("amber-falcon", &s, b"secret").as_deref(), Some("abc"));
        assert_eq!(verify_session("other-room", &s, b"secret"), None);
        assert_eq!(verify_session("amber-falcon", "abc.forged", b"secret"), None);
    }
}
