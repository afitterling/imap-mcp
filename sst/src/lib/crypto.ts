import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual, scryptSync, createHash } from "node:crypto";
import { Resource } from "sst";

function key(): Buffer {
  // Accept a raw 32-byte base64 key, or derive one from any passphrase.
  const raw = Resource.EncryptionKey.value;
  const buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : scryptSync(raw, "webmail-mcp", 32);
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** Keyed hash for values that must be looked up but never recovered (codes, tokens). */
export function hmac(value: string, purpose: string): string {
  return createHmac("sha256", key()).update(`${purpose}\0${value}`).digest("base64url");
}

/** Unkeyed hash for high-entropy secrets that are looked up by hash (access tokens). */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
