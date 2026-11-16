// Portable, synchronous crypto (works in Bun, browsers and the PartyKit/workerd runtime).
import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export interface KeyPair {
  secretKey: string; // hex
  publicKey: string; // hex
}

export function newKeyPair(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey: bytesToHex(secretKey), publicKey: bytesToHex(publicKey) };
}

export function edSign(message: string, secretKeyHex: string): string {
  return bytesToHex(ed25519.sign(utf8ToBytes(message), hexToBytes(secretKeyHex)));
}

export function edVerify(message: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), utf8ToBytes(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export function hmacHex(key: string | Uint8Array, message: string): string {
  return bytesToHex(hmacBytes(key, message));
}

export function hmacBytes(key: string | Uint8Array, message: string): Uint8Array {
  return hmac(sha256, typeof key === "string" ? utf8ToBytes(key) : key, utf8ToBytes(message));
}

export function randomHex(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

export function randomId(): string {
  return randomHex(12);
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function hashPassword(password: string, saltHex = randomHex(16)): string {
  const out = scrypt(utf8ToBytes(password), hexToBytes(saltHex), { N: 2 ** 14, r: 8, p: 1, dkLen: 32 });
  return `${saltHex}:${bytesToHex(out)}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const again = hashPassword(password, salt).split(":")[1] ?? "";
  return safeEqual(again, hash);
}

/** Session tokens: `<playerId>.<hmac>` signed with the room's secret. */
export function signSession(playerId: string, secret: string): string {
  return `${playerId}.${hmacHex(secret, `session:${playerId}`)}`;
}

export function verifySession(token: string | null | undefined, secret: string): string | null {
  if (!token || typeof token !== "string" || token.length > 200) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const expected = signSession(id, secret);
  return safeEqual(expected, token) ? id : null;
}
