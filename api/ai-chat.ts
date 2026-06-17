import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

type Scope = { isAdmin: boolean; location: string | null };
type MailRow = { customers?: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function getDb(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Distinct customer names across the mail rows, so the model can map a
// misspelled name in the question to a real one. Handles the new shape
// [{name, particular}] and legacy ["name"] rows.
function customerNameIndex(mailRows: MailRow[]): string[] {
  const names = new Set<string>();
  for (const r of mailRows) {
    let custs = r.customers as unknown;
    if (typeof custs === "string") { try { custs = JSON.parse(custs); } catch { custs = []; } }
    if (!Array.isArray(custs)) continue;
    for (const c of custs) {
      const nm = c && typeof c === "object" ? (c as { name?: unknown }).name : c;
      if (nm) names.add(String(nm).trim());
    }
  }
  return [...names].filter(Boolean).sort();
}

// Branch sessions see only their own location; admins see everything.
async function buildContext(scope: Scope): Promise<string> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const loc = scope.isAdmin ? null : (scope.location || null);

  const mailQ = db.from("mail_records")
    .select("id, mail_type, date, name, department, employee_id, particular, docket_number, courier_status, customers, location")
    .order("date", { ascending: false }).limit(400);
  const complaintsQ = db.from("complaint_records")
    .select("id, branch, date, department_id, subject, status").order("raised_at", { ascending: false }).limit(100);
  const stockQ = db.from("stock_entries").select("item_name, entry_type, quantity, location").limit(300);
  const employeesQ = db.from("employees").select("emp_id, name, role, location").limit(200);
  const deptsQ = db.from("complaint_dept_config").select("dept_key, name, active").limit(30);

  const [mail, complaints, stock, employees, depts] = await Promise.all([
    loc ? mailQ.eq("location", loc) : mailQ,
    loc ? complaintsQ.eq("branch", loc) : complaintsQ,
    loc ? stockQ.eq("location", loc) : stockQ,
    loc ? employeesQ.eq("location", loc) : employeesQ,
    deptsQ,
  ]);

  const mailRows = (mail.data ?? []) as MailRow[];
  const stockRows = (stock.data ?? []) as { location: string; item_name: string; entry_type: string; quantity: number }[];

  const stockAgg = new Map<string, { branch: string; item: string; net: number }>();
  for (const r of stockRows) {
    const key = `${r.location}||${r.item_name}`;
    if (!stockAgg.has(key)) stockAgg.set(key, { branch: r.location, item: r.item_name, net: 0 });
    stockAgg.get(key)!.net += (r.entry_type === "in" ? 1 : -1) * (Number(r.quantity) || 0);
  }
  const stockList = Array.from(stockAgg.values()).filter(s => s.net !== 0).slice(0, 150);

  const idx = customerNameIndex(mailRows);
  const scopeLine = scope.isAdmin
    ? "Scope: ADMIN — data covers ALL branches."
    : `Scope: BRANCH "${scope.location}" — data is limited to this branch only.`;

  return `Today: ${today}
${scopeLine}

KNOWN CUSTOMER NAMES (${idx.length}) — use this list to resolve misspelled names in the question to the correct customer:
${JSON.stringify(idx)}

MAIL RECORDS (${mailRows.length}) — each row: mail_type (inward/outward), date, name (to/from), department, employee_id, particular (union), docket_number, courier_status, customers (array of {name, particular} — the per-customer particulars), location:
${JSON.stringify(mailRows)}

COMPLAINTS (${complaints.data?.length ?? 0}):
${JSON.stringify(complaints.data ?? [])}

STOCK NET BY BRANCH+ITEM (${stockList.length}):
${JSON.stringify(stockList)}

EMPLOYEES (${employees.data?.length ?? 0}):
${JSON.stringify(employees.data ?? [])}

COMPLAINT DEPARTMENTS:
${JSON.stringify(depts.data ?? [])}`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { messages?: { role: string; content: string }[]; isAdmin?: boolean; location?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return json({ error: "messages array required" }, 400);

  // Role-based scope (no admin OTP gate). Branch session is restricted to its
  // own location; admin sees everything. From the signed-in client session.
  const isAdmin = body.isAdmin === true;
  const location = typeof body.location === "string" && body.location.trim() ? body.location.trim() : null;
  if (!isAdmin && !location) return json({ error: "Missing branch location for non-admin session" }, 401);

  const deepseekKey = process.env.DEEPSEEK_KEY;
  if (!deepseekKey) return json({ error: "DEEPSEEK_KEY not configured" }, 500);

  // v4-flash by default: v4-pro's reasoning latency overruns the serverless
  // timeout for this lookup workload. Override via DEEPSEEK_MODEL if needed.
  const VALID_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"];
  const envModel = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const model = VALID_MODELS.includes(envModel) ? envModel : "deepseek-v4-flash";

  let context: string;
  try {
    context = await buildContext({ isAdmin, location });
  } catch (err) {
    return json({ error: "Failed to load data snapshot", detail: String(err) }, 500);
  }

  const systemPrompt = `You are the AI assistant for the Mail Record system. You answer questions about mail records (inward & outward), the customers on each mail and their individual particulars (documents/items), dockets, departments, employees, complaints, and stationary stock — using ONLY the data snapshot below.

Rules:
- Answer directly and briefly. Do not over-deliberate; this is a lookup assistant, not a puzzle.
- Be concise. Use Markdown (bold, bullets) for clarity. Cite actual numbers/dates from the data.
- Spelling tolerance: the user may misspell a customer or term. Match against KNOWN CUSTOMER NAMES and the data; if you infer a correction, state which name you used (e.g. "Assuming you mean **Ramesh**").
- For a customer question, list their mail records: direction (inward/outward), date, docket, department, and that customer's particulars.
- If the answer is not in the snapshot, say so plainly — do not invent records.
- Respect scope: if this is a branch session, the data is only for that branch; do not claim to know other branches.

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
