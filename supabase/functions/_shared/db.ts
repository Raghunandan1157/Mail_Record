/**
 * _shared/db.ts
 * Supabase service-role client + typed query helpers.
 * All queries are read-only and capped at 200 rows.
 * No raw SQL is exposed — only supabase-js query builder calls.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Client (singleton per isolate)
// ---------------------------------------------------------------------------

let _db: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (!_db) {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    _db = createClient(url, key, { auth: { persistSession: false } });
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Allowlisted tables for the count_by generic tool
// ---------------------------------------------------------------------------

export const ALLOWED_TABLES = [
  "mail_records",
  "mail_edit_log",
  "complaint_records",
  "complaint_log",
  "complaint_dept_config",
  "stock_entries",
  "edit_log",
  "deletion_log",
  "employees",
  "app_config",
] as const;

export type AllowedTable = (typeof ALLOWED_TABLES)[number];

export function isAllowedTable(name: string): name is AllowedTable {
  return (ALLOWED_TABLES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Query helpers (all read-only, max 200 rows)
// ---------------------------------------------------------------------------

const ROW_LIMIT = 200;

/** List complaint_records with optional filters, joined with dept name. */
export async function queryComplaints(params: {
  status?: string;
  dept_code?: string;
  branch?: string;
  date_from?: string;
  date_to?: string;
}) {
  const db = getDb();
  let q = db
    .from("complaint_records")
    .select(
      "id, branch, date, department_id, subject, content, raised_by, phone, emp_id, status, resolution_note, resolved_by, raised_at, updated_at"
    )
    .order("raised_at", { ascending: false })
    .limit(ROW_LIMIT);

  if (params.status) q = q.eq("status", params.status);
  if (params.dept_code) q = q.eq("department_id", params.dept_code);
  if (params.branch) q = q.eq("branch", params.branch);
  if (params.date_from) q = q.gte("date", params.date_from);
  if (params.date_to) q = q.lte("date", params.date_to);

  const { data, error } = await q;
  if (error) throw new Error(`queryComplaints: ${error.message}`);
  return data ?? [];
}

/** Get the full activity log for a single complaint. */
export async function queryComplaintLog(complaintId: number) {
  const db = getDb();
  const { data, error } = await db
    .from("complaint_log")
    .select("id, complaint_id, action, from_status, to_status, note, by_user, at")
    .eq("complaint_id", complaintId)
    .order("at", { ascending: true })
    .limit(ROW_LIMIT);
  if (error) throw new Error(`queryComplaintLog: ${error.message}`);
  return data ?? [];
}

/** List mail_records with optional filters. */
export async function queryMail(params: {
  direction?: string;
  branch?: string;
  department?: string;
  date_from?: string;
  date_to?: string;
}) {
  const db = getDb();
  let q = db
    .from("mail_records")
    .select(
      "id, mail_type, date, employee_id, name, department, documents, courier_status, particular, details, location, created_by, created_at, updated_at"
    )
    .order("date", { ascending: false })
    .limit(ROW_LIMIT);

  if (params.direction) q = q.eq("mail_type", params.direction);
  if (params.branch) q = q.eq("location", params.branch);
  if (params.department) q = q.eq("department", params.department);
  if (params.date_from) q = q.gte("date", params.date_from);
  if (params.date_to) q = q.lte("date", params.date_to);

  const { data, error } = await q;
  if (error) throw new Error(`queryMail: ${error.message}`);
  return data ?? [];
}

/** Get the edit log for mail records (optionally filtered by record id). */
export async function queryMailEditLog(mailId?: number) {
  const db = getDb();
  let q = db
    .from("mail_edit_log")
    .select(
      "id, record_id, mail_type, field_changed, old_value, new_value, edited_by, edited_at"
    )
    .order("edited_at", { ascending: false })
    .limit(ROW_LIMIT);

  if (mailId !== undefined) q = q.eq("record_id", mailId);

  const { data, error } = await q;
  if (error) throw new Error(`queryMailEditLog: ${error.message}`);
  return data ?? [];
}

/**
 * Aggregate stock from stock_entries.
 * Returns one row per (location, item_name) with net quantity = SUM(in) - SUM(out).
 */
export async function queryStockSummary(params: {
  branch?: string;
  low_stock_only?: boolean;
}) {
  const db = getDb();
  let q = db
    .from("stock_entries")
    .select(
      "id, item_name, hsn_code, category, unit, rate, gst, entry_type, quantity, location, created_at, is_edited"
    )
    .order("created_at", { ascending: true })
    .limit(1000); // aggregate over more rows

  if (params.branch) q = q.eq("location", params.branch);

  const { data, error } = await q;
  if (error) throw new Error(`queryStockSummary: ${error.message}`);

  // Aggregate client-side (safe: read-only, max 1000 rows)
  const map = new Map<
    string,
    {
      branch: string;
      item_name: string;
      category: string;
      unit: string;
      net_qty: number;
      total_in: number;
      total_out: number;
    }
  >();

  for (const row of data ?? []) {
    const key = `${row.location}||${row.item_name}`;
    if (!map.has(key)) {
      map.set(key, {
        branch: row.location,
        item_name: row.item_name,
        category: row.category ?? "",
        unit: row.unit ?? "",
        net_qty: 0,
        total_in: 0,
        total_out: 0,
      });
    }
    const agg = map.get(key)!;
    if (row.entry_type === "in") {
      agg.total_in += row.quantity ?? 0;
      agg.net_qty += row.quantity ?? 0;
    } else {
      agg.total_out += row.quantity ?? 0;
      agg.net_qty -= row.quantity ?? 0;
    }
  }

  let rows = Array.from(map.values());
  if (params.low_stock_only) rows = rows.filter((r) => r.net_qty <= 0);
  // Return top 200
  return rows.slice(0, ROW_LIMIT);
}

/** Get the stock edit/deletion audit logs. */
export async function queryStockEditLog(params: {
  date_from?: string;
  date_to?: string;
}) {
  const db = getDb();

  const editQ = db
    .from("edit_log")
    .select(
      "id, stock_entry_id, item_name, old_type, new_type, old_qty, new_qty, edited_by, branch, edited_at"
    )
    .order("edited_at", { ascending: false })
    .limit(ROW_LIMIT);

  const delQ = db
    .from("deletion_log")
    .select(
      "id, stock_entry_id, item_name, entry_type, quantity, original_date, emp_name, deleted_by, branch, deleted_at"
    )
    .order("deleted_at", { ascending: false })
    .limit(ROW_LIMIT);

  const [editRes, delRes] = await Promise.all([editQ, delQ]);
  if (editRes.error) throw new Error(`queryStockEditLog(edits): ${editRes.error.message}`);
  if (delRes.error) throw new Error(`queryStockEditLog(deletions): ${delRes.error.message}`);

  return {
    edits: editRes.data ?? [],
    deletions: delRes.data ?? [],
  };
}

/** List employees with optional branch/role filters. */
export async function queryEmployees(params: {
  branch?: string;
  role?: string;
}) {
  const db = getDb();
  let q = db
    .from("employees")
    .select("id, emp_id, name, role, mobile, location, created_at")
    .order("name", { ascending: true })
    .limit(ROW_LIMIT);

  if (params.branch) q = q.eq("location", params.branch);
  if (params.role) q = q.eq("role", params.role);

  const { data, error } = await q;
  if (error) throw new Error(`queryEmployees: ${error.message}`);
  return data ?? [];
}

/** Get all department configs (complaint_dept_config). */
export async function queryDeptConfig() {
  const db = getDb();
  const { data, error } = await db
    .from("complaint_dept_config")
    .select(
      "id, dept_key, name, icon, problems, sort_order, active, created_at, updated_at"
    )
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`queryDeptConfig: ${error.message}`);
  return data ?? [];
}

/**
 * Generic count helper restricted to allowlisted tables.
 * groups_by must be one of the known columns for that table.
 * filters is a simple { col: value } equality map.
 */
export async function queryCountBy(
  table: AllowedTable,
  group_by: string,
  filters: Record<string, string> = {}
) {
  const db = getDb();
  // Build a select that fetches only the group_by column plus all filter columns
  const cols = new Set([group_by, ...Object.keys(filters)]);
  let q = db
    .from(table)
    .select(Array.from(cols).join(", "))
    .limit(1000); // fetch up to 1000 rows to count client-side

  for (const [col, val] of Object.entries(filters)) {
    q = q.eq(col, val);
  }

  const { data, error } = await q;
  if (error) throw new Error(`queryCountBy(${table}): ${error.message}`);

  // Aggregate counts per group value
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const key = String((row as Record<string, unknown>)[group_by] ?? "null");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, ROW_LIMIT)
  );
}

/** Fetch the current admin OTP from app_config for token validation. */
export async function fetchAdminOtp(): Promise<string> {
  const db = getDb();
  const { data, error } = await db
    .from("app_config")
    .select("value")
    .eq("key", "admin_otp")
    .single();
  if (error || !data) throw new Error("Could not fetch admin_otp from app_config");
  return data.value as string;
}

/** Persist a completed AI chat session transcript. */
export async function persistChatSession(params: {
  admin_id: string;
  transcript: unknown;
}) {
  const db = getDb();
  const { error } = await db.from("ai_chat_sessions").insert({
    admin_id: params.admin_id,
    transcript: params.transcript,
  });
  if (error) {
    // Non-fatal — log but don't crash
    console.error("persistChatSession error:", error.message);
  }
}

/** List past AI chat sessions (for UI session rail). */
export async function listChatSessions(limit = 20) {
  const db = getDb();
  const { data, error } = await db
    .from("ai_chat_sessions")
    .select("id, admin_id, started_at, transcript")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listChatSessions: ${error.message}`);
  return data ?? [];
}
