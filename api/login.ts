import { createClient } from "@supabase/supabase-js";
import { signToken, rateLimit, clientIp } from "./_auth";

export const config = { runtime: "edge" };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}
function db() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Branch login = username (branch name) + password vs branch_credentials.
// Admin login = OTP vs app_config. Password / OTP never leave the server; only a
// short-lived signed token is returned.
export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!rateLimit("login:" + clientIp(req), 20, 60000)) return json({ error: "Too many attempts. Wait a minute and try again." }, 429);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: "SESSION_SECRET not configured" }, 500);

  let body: { mode?: string; otp?: string; username?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  // ----- Admin (OTP) -----
  if (body && body.mode === "admin") {
    const otp = String(body.otp || "").trim();
    if (!otp) return json({ error: "OTP required" }, 400);
    const { data, error } = await db().from("app_config").select("value").eq("key", "admin_otp").limit(1).maybeSingle();
    if (error) return json({ error: "Login failed", detail: error.message }, 500);
    const real = data && String((data as { value: unknown }).value);
    if (!real || real !== otp) return json({ error: "Invalid OTP" }, 401);
    const token = await signToken({ loc: null, adm: true }, secret);
    return json({ token, isAdmin: true, location: null });
  }

  // ----- Branch (username + password) -----
  const username = String((body && body.username) || "").trim();
  const password = String((body && body.password) || "");
  if (!username || !password) return json({ error: "Branch and password are required" }, 400);

  // ilike (no wildcards) = case-insensitive exact match; the value is sent as a
  // bound parameter by supabase-js, so this is not an injection vector. For these
  // apps username == branch (only case differs), so matching username suffices.
  const { data, error } = await db()
    .from("branch_credentials")
    .select("branch, username, is_admin, is_auditor")
    .ilike("username", username)
    .eq("password", password)
    .limit(1)
    .maybeSingle();
  if (error) return json({ error: "Login failed", detail: error.message }, 500);
  if (!data) return json({ error: "Invalid branch or password" }, 401);

  const row = data as { branch: string; username: string; is_admin?: boolean; is_auditor?: boolean };
  const adm = !!row.is_admin;
  const aud = !!row.is_auditor;
  const loc = row.branch || row.username;
  // Office accounts (Head Office / Corporate Office) keep their own location + a
  // non-admin client identity, but are authorized to view ALL branches when they
  // switch to Admin view. `off` makes the proxy treat them as privileged without
  // flipping the client's default view to full-admin.
  const off = loc === "Head Office" || loc === "Corporate Office";
  const token = await signToken({ loc: adm ? null : loc, adm, aud, off }, secret);
  return json({ token, isAdmin: adm, isAuditor: aud, location: adm ? null : loc });
}
