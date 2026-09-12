import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual, scryptSync } from "node:crypto";
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

/** Signed, expiring session cookie value for the admin UI. */
export function signSession(ttlMs = 12 * 60 * 60 * 1000): string {
  const exp = String(Date.now() + ttlMs);
  const sig = createHmac("sha256", key()).update(exp).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifySession(value: string | undefined): boolean {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig) return false;
  const expected = createHmac("sha256", key()).update(exp).digest("base64url");
  if (!safeEqual(sig, expected)) return false;
  return Number(exp) > Date.now();
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
