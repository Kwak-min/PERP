import crypto from "node:crypto";

const ITERATIONS = 120000;
const KEYLEN = 32;
const DIGEST = "sha256";
const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function hashPassword(password, salt = null) {
  const useSalt = salt ?? crypto.randomBytes(16).toString("hex");
  const digest = crypto.pbkdf2Sync(password, useSalt, ITERATIONS, KEYLEN, DIGEST).toString("hex");
  return `${useSalt}$${digest}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes("$")) return false;
  const [salt] = stored.split("$", 1);
  const computed = hashPassword(password, salt);
  const a = Buffer.from(computed);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const tokenFingerprint = (token) => crypto.createHash("sha256").update(token).digest("hex");
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const signPayload = (secret, payload) =>
  crypto.createHmac("sha256", secret).update(payload).digest("hex");

export function temporaryPassword(length = 12) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  }
  return out;
}
