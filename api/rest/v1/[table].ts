import { getScope, clientIp, rateLimit } from "../../_auth";

export const config = { runtime: "edge" };

const SUPA = process.env.SUPABASE_URL!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// app_config (admin OTP) and branch_credentials (passwords) are intentionally
// NOT reachable here — they are served only by /api/login and /api/branches.
const TABLES = new Set([
  "employees",
  "mail_records", "mail_edit_log",
  "complaint_records", "complaint_log", "complaint_dept_config",
  "stock_entries", "edit_log", "deletion_log",
  "received_date_log", "received_date_deletion_log",
  "shipments", "ai_chat_history",
  "audit_branch_months",
]);

type ScopeCfg =
  | { col: string }
  | { cols: string[] }
  | { via: { col: string; parent: string; parentCol: string } }
  | { global: true };

const SCOPE: Record<string, ScopeCfg> = {
  mail_records: { col: "location" },
  employees: { col: "location" },
  ai_chat_history: { col: "location" },
  stock_entries: { col: "location" },
  received_date_log: { col: "location" },
  received_date_deletion_log: { col: "location" },
  complaint_records: { col: "branch" },
  edit_log: { col: "branch" },
  deletion_log: { col: "branch" },
  audit_branch_months: { col: "branch" },
  shipments: { cols: ["from_branch", "to_branch"] },
  mail_edit_log: { via: { col: "record_id", parent: "mail_records", parentCol: "location" } },
  complaint_log: { via: { col: "complaint_id", parent: "complaint_records", parentCol: "branch" } },
  complaint_dept_config: { global: true },
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, prefer, range, range-unit",
};
const jerr = (msg: string, status: number) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, "content-type": "application/json" } });

function svcHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SVC, Authorization: `Bearer ${SVC}`, ...extra };
}

// Does parent row `id` belong to this branch? Used to scope via-tables.
async function ownsParent(parent: string, parentCol: string, id: string, loc: string): Promise<boolean> {
  const u = `${SUPA}/rest/v1/${parent}?select=id&id=eq.${encodeURIComponent(id)}&${parentCol}=eq.${encodeURIComponent(loc)}&limit=1`;
  const r = await fetch(u, { headers: svcHeaders() });
  if (!r.ok) return false;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows.length > 0;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const segs = url.pathname.split("/").filter(Boolean);
  const table = segs[segs.length - 1];
  if (!TABLES.has(table)) return jerr("Unknown table: " + table, 400);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return jerr("SESSION_SECRET not configured", 500);
  const scope = await getScope(req, secret);
  if (!scope) return jerr("Unauthorized", 401);
  if (!rateLimit("rest:" + clientIp(req), 600, 60000)) return jerr("Too many requests", 429);

  // Admins and auditors are unscoped (auditors legitimately review all branches).
  // Office accounts (Head Office / Corporate Office) are likewise authorized to see
  // every branch — they reach the all-branches Admin view via the Tab view-switch.
  const privileged = !!scope.adm || !!scope.aud || !!scope.off;
  const loc = scope.loc || "";
  const cfg = SCOPE[table];
  const method = req.method;

  // Build the forwarded query string, starting from the client's params.
  const sp = new URLSearchParams(url.searchParams);
  // Vercel injects the dynamic segment ([table]) as a "table" query param;
  // PostgREST would mis-read it as a column filter, so drop it.
  sp.delete("table");

  if (!privileged) {
    if (!cfg) return jerr("Forbidden", 403);
    if ("global" in cfg) {
      if (method !== "GET") return jerr("Forbidden", 403);
    } else if ("col" in cfg) {
      sp.append(cfg.col, `eq.${loc}`);
    } else if ("cols" in cfg) {
      sp.append("or", `(${cfg.cols.map((c) => `${c}.eq.${loc}`).join(",")})`);
    } else if ("via" in cfg) {
      // Require an eq filter on the via column and verify ownership of that parent.
      const raw = sp.get(cfg.via.col);
      const id = raw && raw.startsWith("eq.") ? raw.slice(3) : null;
      if (!id) return jerr("Forbidden", 403);
      if (!(await ownsParent(cfg.via.parent, cfg.via.parentCol, id, loc))) return jerr("Forbidden", 403);
    }
  }

  // Body handling: for non-privileged writes, force the branch column.
  let bodyText: string | undefined;
  if (method === "POST" || method === "PATCH") {
    const raw = await req.text();
    if (raw) {
      if (!privileged && cfg && "col" in cfg) {
        try {
          const parsed = JSON.parse(raw);
          const fix = (o: Record<string, unknown>) => { o[cfg.col] = loc; return o; };
          bodyText = JSON.stringify(Array.isArray(parsed) ? parsed.map(fix) : fix(parsed));
        } catch { bodyText = raw; }
      } else {
        bodyText = raw;
      }
    }
  }

  const target = `${SUPA}/rest/v1/${table}?${sp.toString()}`;
  const fwdHeaders: Record<string, string> = svcHeaders({ "Content-Type": "application/json" });
  for (const h of ["prefer", "range", "range-unit", "accept"]) {
    const v = req.headers.get(h);
    if (v) fwdHeaders[h] = v;
  }

  let res: Response;
  try {
    res = await fetch(target, { method, headers: fwdHeaders, body: bodyText });
  } catch (e) {
    return jerr("Upstream error: " + String((e as Error)?.message || e), 502);
  }

  const out = new Headers(cors);
  for (const h of ["content-type", "content-range", "range-unit", "prefer"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  const text = await res.text();
  return new Response(text, { status: res.status, headers: out });
}
