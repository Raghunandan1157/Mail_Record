import {
  fetchAdminOtp,
  isAllowedTable,
  queryComplaints,
  queryComplaintLog,
  queryCountBy,
  queryDeptConfig,
  queryEmployees,
  queryMail,
  queryMailEditLog,
  queryStockEditLog,
  queryStockSummary,
} from "./db";

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  { type: "function", function: { name: "today", description: "Returns current ISO date YYYY-MM-DD.", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "list_complaints",
      description: "List complaint records with optional filters. Up to 200 rows.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "in_progress", "resolved", "escalated", "rejected"] },
          dept_code: { type: "string" },
          branch: { type: "string" },
          date_from: { type: "string", description: "YYYY-MM-DD" },
          date_to: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_complaint_log",
      description: "Get full activity history for a complaint by ID.",
      parameters: { type: "object", properties: { complaint_id: { type: "integer" } }, required: ["complaint_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_mail",
      description: "List mail records (inward/outward) with optional filters. Up to 200 rows.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["inward", "outward"] },
          branch: { type: "string" },
          department: { type: "string" },
          date_from: { type: "string" },
          date_to: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mail_edit_log",
      description: "Mail edit history. Optional mail_id filter.",
      parameters: { type: "object", properties: { mail_id: { type: "integer" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "stock_summary",
      description: "Aggregate stock levels per (branch, item). Returns net_qty, total_in, total_out.",
      parameters: {
        type: "object",
        properties: { branch: { type: "string" }, low_stock_only: { type: "boolean" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stock_edit_log",
      description: "Recent stock edits + deletions. Returns {edits, deletions}.",
      parameters: { type: "object", properties: { date_from: { type: "string" }, date_to: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "list_employees",
      description: "List employees with optional branch/role filters.",
      parameters: { type: "object", properties: { branch: { type: "string" }, role: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dept_config",
      description: "Return all complaint department configs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "count_by",
      description: "Count rows in allowlisted table grouped by column. Allowed tables: mail_records, complaint_records, stock_entries, mail_edit_log, employees, complaint_dept_config, complaint_log, edit_log, deletion_log, app_config.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string" },
          group_by: { type: "string" },
          filters: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["table", "group_by"],
      },
    },
  },
];

export async function dispatchTool(name: string, rawArgs: string): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    throw new Error(`Invalid JSON arguments for tool '${name}': ${rawArgs}`);
  }

  switch (name) {
    case "today":
      return { today: new Date().toISOString().slice(0, 10) };
    case "list_complaints":
      return queryComplaints({
        status: args.status as string | undefined,
        dept_code: args.dept_code as string | undefined,
        branch: args.branch as string | undefined,
        date_from: args.date_from as string | undefined,
        date_to: args.date_to as string | undefined,
      });
    case "get_complaint_log": {
      const id = Number(args.complaint_id);
      if (!Number.isInteger(id) || id <= 0) throw new Error("get_complaint_log requires positive integer complaint_id");
      return queryComplaintLog(id);
    }
    case "list_mail":
      return queryMail({
        direction: args.direction as string | undefined,
        branch: args.branch as string | undefined,
        department: args.department as string | undefined,
        date_from: args.date_from as string | undefined,
        date_to: args.date_to as string | undefined,
      });
    case "get_mail_edit_log": {
      const mid = args.mail_id !== undefined ? Number(args.mail_id) : undefined;
      return queryMailEditLog(mid);
    }
    case "stock_summary":
      return queryStockSummary({
        branch: args.branch as string | undefined,
        low_stock_only: args.low_stock_only as boolean | undefined,
      });
    case "stock_edit_log":
      return queryStockEditLog({
        date_from: args.date_from as string | undefined,
        date_to: args.date_to as string | undefined,
      });
    case "list_employees":
      return queryEmployees({ branch: args.branch as string | undefined, role: args.role as string | undefined });
    case "get_dept_config":
      return queryDeptConfig();
    case "count_by": {
      const table = args.table as string;
      const group = args.group_by as string;
      if (!table || !group) throw new Error("count_by requires 'table' and 'group_by'");
      if (!isAllowedTable(table)) throw new Error(`Table '${table}' not allowlisted.`);
      const filters = (args.filters as Record<string, string>) ?? {};
      return queryCountBy(table, group, filters);
    }
    default:
      throw new Error(`Unknown tool: '${name}'`);
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateAdminToken(token: string): Promise<boolean> {
  return (await validateAdminTokenDetailed(token)).ok;
}

export async function validateAdminTokenDetailed(token: string): Promise<{ ok: boolean; reason?: string }> {
  if (!token) return { ok: false, reason: "missing_token" };
  try {
    const otp = await fetchAdminOtp();
    const today = new Date().toISOString().slice(0, 10);
    const expected = await sha256Hex(otp + today);
    if (token !== expected) {
      return { ok: false, reason: `token_mismatch (otp_len=${otp.length}, today=${today}, expected_prefix=${expected.slice(0, 8)}, got_prefix=${token.slice(0, 8)})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `validate_error: ${String(err)}` };
  }
}
