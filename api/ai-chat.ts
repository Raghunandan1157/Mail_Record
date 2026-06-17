import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Edge required: the Web Request/Response handler hangs in this account's Node
// runtime. Coverage comes from the mail_context RPC (exact aggregates + a
// term-matched + recent sample), so the prompt stays small and lands under the
// edge cap even though the table has thousands of rows.
export const config = { runtime: "edge" };

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

type Msg = { role: string; content: string };
type Scope = { isAdmin: boolean; location: string | null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function getDb(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Significant words from the latest user question — used to pull matching mail
// rows (by name / department / docket / particular / customer) across ALL data,
// not just the most recent.
const STOP = new Set([
  "the", "and", "for", "how", "many", "much", "what", "did", "does", "send", "sent", "mail", "mails",
  "record", "records", "show", "list", "all", "give", "me", "of", "in", "to", "is", "are", "was", "were",
  "has", "have", "had", "my", "branch", "department", "dept", "total", "totals", "count", "number",
  "customer", "customers", "particular", "particulars", "docket", "inward", "outward", "name", "names",
  "about", "tell", "more", "any", "which", "who", "this", "that", "from", "with", "there", "their", "them",
  "please", "can", "you", "get", "find", "between", "and", "on", "by", "a", "an",
]);

function extractTerms(messages: Msg[]): string[] {
  const last = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
  const words = last.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 12);
}

async function buildContext(scope: Scope, terms: string[]): Promise<string> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const loc = scope.isAdmin ? null : (scope.location || null);

  const complaintsQ = db.from("complaint_records").select("id, branch, date, department_id, subject, status").order("raised_at", { ascending: false }).limit(60);
  const stockQ = db.from("stock_entries").select("item_name, entry_type, quantity, location").limit(40);
  const employeesQ = db.from("employees").select("emp_id, name, role, location").limit(60);
  const deptsQ = db.from("complaint_dept_config").select("dept_key, name, active").limit(30);

  const [ctxRes, complaints, stock, employees, depts] = await Promise.all([
    db.rpc("mail_context", { p_location: loc, p_terms: terms }),
    loc ? complaintsQ.eq("branch", loc) : complaintsQ,
    loc ? stockQ.eq("location", loc) : stockQ,
    loc ? employeesQ.eq("location", loc) : employeesQ,
    deptsQ,
  ]);

  const ctx = (ctxRes.data ?? {}) as {
    total?: number; inward?: number; outward?: number;
    by_department?: unknown; customer_count?: number; customer_names?: unknown;
    matched_rows?: { id: number }[]; recent_rows?: { id: number }[];
  };

  // Merge term-matched rows (relevant, may be old) with the most-recent sample.
  const rowMap = new Map<number, unknown>();
  for (const r of ctx.matched_rows ?? []) rowMap.set(r.id, r);
  for (const r of ctx.recent_rows ?? []) if (!rowMap.has(r.id)) rowMap.set(r.id, r);
  const rows = [...rowMap.values()].slice(0, 140);

  const stockRows = (stock.data ?? []) as { location: string; item_name: string; entry_type: string; quantity: number }[];
  const stockAgg = new Map<string, { branch: string; item: string; net: number }>();
  for (const r of stockRows) {
    const key = `${r.location}||${r.item_name}`;
    if (!stockAgg.has(key)) stockAgg.set(key, { branch: r.location, item: r.item_name, net: 0 });
    stockAgg.get(key)!.net += (r.entry_type === "in" ? 1 : -1) * (Number(r.quantity) || 0);
  }
  const stockList = Array.from(stockAgg.values()).filter(s => s.net !== 0).slice(0, 80);

  const scopeLine = scope.isAdmin
    ? "Scope: ADMIN — data covers ALL branches."
    : `Scope: BRANCH "${scope.location}" — data is limited to this branch only.`;

  return `Today: ${today}
${scopeLine}

EXACT MAIL TOTALS (computed over ALL records in scope — ALWAYS use these for any count/total question; never count the sample rows below):
- total: ${ctx.total ?? 0}
- inward: ${ctx.inward ?? 0}
- outward: ${ctx.outward ?? 0}
- by department: ${JSON.stringify(ctx.by_department ?? [])}

KNOWN CUSTOMER NAMES (${ctx.customer_count ?? 0}) — full distinct list across ALL records in scope; use to resolve a misspelled name to the real one:
${JSON.stringify(ctx.customer_names ?? [])}

MAIL ROWS (${rows.length}) — a RELEVANT + RECENT SAMPLE: rows matching your question's terms (across all dates) plus the most recent. This is NOT the full set — for any count use EXACT MAIL TOTALS above. Each row: mail_type (inward/outward), date, name (to/from), department, employee_id, particular, docket_number, courier_status, customers (array of {name, particular}), location:
${JSON.stringify(rows)}

COMPLAINTS (${complaints.data?.length ?? 0}):
${JSON.stringify(complaints.data ?? [])}

STOCK NET BY BRANCH+ITEM (${stockList.length}):
${JSON.stringify(stockList)}

EMPLOYEES sample (${employees.data?.length ?? 0}):
${JSON.stringify(employees.data ?? [])}

COMPLAINT DEPARTMENTS:
${JSON.stringify(depts.data ?? [])}`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { messages?: Msg[]; isAdmin?: boolean; location?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return json({ error: "messages array required" }, 400);

  const isAdmin = body.isAdmin === true;
  const location = typeof body.location === "string" && body.location.trim() ? body.location.trim() : null;
  if (!isAdmin && !location) return json({ error: "Missing branch location for non-admin session" }, 401);

  const deepseekKey = process.env.DEEPSEEK_KEY;
  if (!deepseekKey) return json({ error: "DEEPSEEK_KEY not configured" }, 500);

  const VALID_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"];
  const envModel = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const model = VALID_MODELS.includes(envModel) ? envModel : "deepseek-v4-flash";

  let context: string;
  try {
    context = await buildContext({ isAdmin, location }, extractTerms(messages));
  } catch (err) {
    return json({ error: "Failed to load data snapshot", detail: String(err) }, 500);
  }

  const systemPrompt = `You are the AI assistant for the Mail Record system. You answer questions about mail records (inward & outward), the customers on each mail and their individual particulars, dockets, departments, employees, complaints, and stationary stock — using ONLY the data snapshot below.

Rules:
- Answer directly and briefly. Do not over-deliberate; this is a lookup assistant.
- COUNTS: for any "how many / total / count" question, use EXACT MAIL TOTALS (and "by department") — these cover ALL records. NEVER count the MAIL ROWS sample, which is partial.
- ROWS: the MAIL ROWS list is a relevant + recent sample. Use it to answer about specific mails/customers. If a customer or item you'd expect is not in the sample but the question is specific, say it may be outside the recent/matched sample and suggest a more specific query.
- Spelling tolerance: match a misspelled name/term against KNOWN CUSTOMER NAMES and "by department"; state the correction you used.
- If the answer isn't in the snapshot, say so — do not invent records.
- Respect scope: a branch session only sees its own branch.

${context}`;

  const payload = {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    max_tokens: 4096,
    temperature: 0.3,
  };

  let res: Response;
  try {
    res = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${deepseekKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json({ error: "DeepSeek unreachable", detail: String(err) }, 502);
  }

  if (!res.ok) {
    const errText = await res.text();
    return json({ error: "DeepSeek API error", detail: errText }, res.status);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content ?? "(no reply)";
  return json({ reply });
}
