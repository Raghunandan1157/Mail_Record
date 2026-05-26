import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function verifyOtp(otp: string): Promise<boolean> {
  const db = getDb();
  const { data, error } = await db.from("app_config").select("value").eq("key", "admin_otp").single();
  if (error || !data) return false;
  return String(data.value) === String(otp);
}

async function buildContext(): Promise<string> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const [complaints, mail, stock, employees, depts] = await Promise.all([
    db.from("complaint_records").select("id, branch, date, department_id, subject, status, raised_by").order("raised_at", { ascending: false }).limit(100),
    db.from("mail_records").select("id, mail_type, date, name, department, location, particular").order("date", { ascending: false }).limit(100),
    db.from("stock_entries").select("item_name, category, unit, entry_type, quantity, location, created_at").order("created_at", { ascending: false }).limit(200),
    db.from("employees").select("emp_id, name, role, location").limit(200),
    db.from("complaint_dept_config").select("dept_key, name, problems, active").limit(50),
  ]);

  const stockRows = stock.data ?? [];
  const stockAgg = new Map<string, { branch: string; item: string; net: number }>();
  for (const r of stockRows) {
    const key = `${r.location}||${r.item_name}`;
    if (!stockAgg.has(key)) stockAgg.set(key, { branch: r.location, item: r.item_name, net: 0 });
    const a = stockAgg.get(key)!;
    a.net += (r.entry_type === "in" ? 1 : -1) * (r.quantity ?? 0);
  }

  return `Today: ${today}. Data snapshot (last 30 days where applicable):

COMPLAINTS (${complaints.data?.length ?? 0} rows):
${JSON.stringify(complaints.data ?? [], null, 0)}

MAIL (${mail.data?.length ?? 0} rows):
${JSON.stringify(mail.data ?? [], null, 0)}

STOCK NET BY BRANCH+ITEM (${stockAgg.size} pairs):
${JSON.stringify(Array.from(stockAgg.values()), null, 0)}

EMPLOYEES (${employees.data?.length ?? 0}):
${JSON.stringify(employees.data ?? [], null, 0)}

COMPLAINT DEPARTMENTS:
${JSON.stringify(depts.data ?? [], null, 0)}`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { otp?: string; messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { otp, messages } = body;
  if (!otp) return json({ error: "Missing OTP" }, 401);
  if (!Array.isArray(messages) || messages.length === 0) return json({ error: "messages array required" }, 400);

  try {
    if (!(await verifyOtp(otp))) return json({ error: "Invalid OTP" }, 401);
  } catch (err) {
    return json({ error: "Auth check failed", detail: String(err) }, 500);
  }

  const deepseekKey = process.env.DEEPSEEK_KEY;
  if (!deepseekKey) return json({ error: "DEEPSEEK_KEY not configured" }, 500);
  const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

  let context: string;
  try {
    context = await buildContext();
  } catch (err) {
    return json({ error: "Failed to load data snapshot", detail: String(err) }, 500);
  }

  const systemPrompt = `You are an AI assistant for the Mail_Record admin system. You answer questions about mail records, complaints, stationary stock, and employees using the data snapshot provided below. Be concise. Use Markdown (bold, bullets) for clarity. Cite numbers from the data.

${context}`;

  const payload = {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    max_tokens: 2048,
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
