import { createClient } from "@supabase/supabase-js";

// Public, read-only list of branch NAMES only — needed before login (branch
// dropdown / autocomplete) and for the recipient picker. Returns no
// credentials, so branch_credentials need not be client-reachable.
export const config = { runtime: "edge" };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
function db() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });

  const names = new Set<string>(["Head Office", "Corporate Office"]);
  try {
    const sb = db();
    const [emps, creds] = await Promise.all([
      sb.from("employees").select("location").not("location", "is", null),
      sb.from("branch_credentials").select("branch").not("branch", "is", null),
    ]);
    for (const e of (emps.data as { location: string }[] | null) || []) if (e.location) names.add(String(e.location).trim());
    for (const c of (creds.data as { branch: string }[] | null) || []) if (c.branch) names.add(String(c.branch).trim());
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }

  const list = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
  return new Response(JSON.stringify(list), { headers: { ...cors, "content-type": "application/json" } });
}
