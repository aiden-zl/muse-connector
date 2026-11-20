// WebCrypto helpers (work in Workers and Node >= 20).

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 24): string {
  const u = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison (hash both sides first so length isn't leaked). */
export async function ctEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Password charset safe for the `security -i` tokenizer (no quotes, backslashes, whitespace).
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "_.!@#-";
export const PASSWORD_RE = /^[A-Za-z0-9_.!@#-]+$/;

function pick(set: string): string {
  // rejection sampling to avoid modulo bias
  const lim = 256 - (256 % set.length);
  for (;;) {
    const [r] = crypto.getRandomValues(new Uint8Array(1));
    if (r < lim) return set[r % set.length];
  }
}

/** 20-char password: >=2 of each class, first char a letter (some portals reject leading symbols). */
export function generatePassword(len = 20): string {
  const all = LOWER + UPPER + DIGIT + SYMBOL;
  const chars = [pick(LOWER), pick(LOWER), pick(UPPER), pick(UPPER), pick(DIGIT), pick(DIGIT), pick(SYMBOL), pick(SYMBOL)];
  while (chars.length < len - 1) chars.push(pick(all));
  // Fisher-Yates
  for (let i = chars.length - 1; i > 0; i--) {
    const lim = 256 - (256 % (i + 1));
    let r: number;
    do { [r] = crypto.getRandomValues(new Uint8Array(1)); } while (r >= lim);
    const j = r % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return pick(LOWER + UPPER) + chars.join("");
}

const keyCache = new Map<string, CryptoKey>();

export async function importCredKey(b64Key: string): Promise<CryptoKey> {
  const cached = keyCache.get(b64Key);
  if (cached) return cached;
  const raw = unb64(b64Key);
  if (raw.length !== 32) throw new Error("CRED_KEY must be 32 bytes base64");
  const k = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  keyCache.set(b64Key, k);
  return k;
}

function aad(siteKey: string, rowId: number, keyVersion: number): Uint8Array {
  return enc.encode(`${siteKey}|${rowId}|${keyVersion}`);
}

export async function encryptSecret(key: CryptoKey, plaintext: string, siteKey: string, rowId: number, keyVersion = 1) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(siteKey, rowId, keyVersion) },
    key,
    enc.encode(plaintext),
  );
  return { ciphertext: b64(ct), iv: b64(iv) };
}

export async function decryptSecret(key: CryptoKey, ciphertext: string, iv: string, siteKey: string, rowId: number, keyVersion = 1) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv), additionalData: aad(siteKey, rowId, keyVersion) },
    key,
    unb64(ciphertext),
  );
  return dec.decode(pt);
}
