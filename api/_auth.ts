// Shared auth helpers for the edge API: HMAC-signed session tokens + a
// best-effort per-instance rate limiter. Web Crypto only — no external deps.
// Files prefixed with "_" are bundled but NOT exposed as routes by Vercel.

const enc = new TextEncoder();
const dec = new TextDecoder();

// `off` = office account (Head Office / Corporate Office). These accounts default
// to their own office view client-side but are authorized to see ALL branches when
// they switch to Admin view, so the proxy treats them as privileged. Kept separate
// from `adm` so the client still defaults office accounts to the corporate/branch
// view instead of the full-admin identity.
export type Scope = { loc: string | null; adm: boolean; aud: boolean; off?: boolean; exp: number };

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str: string): Uint8Array {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlFromString = (s: string) => b64urlFromBytes(enc.encode(s));
const stringFromB64url = (s: string) => dec.decode(b64urlToBytes(s));
const nowSec = () => Math.floor(Date.now() / 1000);

// Cast Uint8Array -> BufferSource: TS 5.7+ lib types narrow to ArrayBuffer and
// reject the ArrayBufferLike-backed Uint8Array, though it is valid at runtime.
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(enc.encode(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signToken(payload: { loc: string | null; adm: boolean; aud?: boolean; off?: boolean }, secret: string, ttlSeconds = 2592000): Promise<string> {
  const body = { loc: payload.loc ?? null, adm: !!payload.adm, aud: !!payload.aud, off: !!payload.off, exp: nowSec() + ttlSeconds };
  const data = b64urlFromString(JSON.stringify(body));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf(enc.encode(data))));
  return data + "." + b64urlFromBytes(sig);
}

export async function verifyToken(token: string | null, secret: string): Promise<Scope | null> {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!data || !sig) return null;
  let ok = false;
  try {
    const key = await hmacKey(secret);
    ok = await crypto.subtle.verify("HMAC", key, buf(b64urlToBytes(sig)), buf(enc.encode(data)));
  } catch { return null; }
  if (!ok) return null;
  let body: Scope;
  try { body = JSON.parse(stringFromB64url(data)); } catch { return null; }
  if (!body || typeof body.exp !== "number" || body.exp < nowSec()) return null;
  return body;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function getScope(req: Request, secret: string): Promise<Scope | null> {
  if (!secret) return null;
  return verifyToken(bearer(req), secret);
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

// Best-effort per-instance sliding window (Fluid Compute reuses instances). The
// real gate is token auth; this only caps casual abuse.
const _buckets = new Map<string, { count: number; reset: number }>();
export function rateLimit(keyId: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let b = _buckets.get(keyId);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; _buckets.set(keyId, b); }
  b.count++;
  if (_buckets.size > 5000) { for (const [k, v] of _buckets) if (now > v.reset) _buckets.delete(k); }
  return b.count <= max;
}
