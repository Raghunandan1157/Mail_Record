/**
 * _shared/tools.ts
 * OpenAI-compatible tool schemas + handler dispatch for the AI chat loop.
 * All tools are read-only. Handlers return plain JSON (≤200 rows).
 */

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
} from "./db.ts";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// ---------------------------------------------------------------------------
// Tool schemas (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "today",
      description: "Returns the current ISO date (YYYY-MM-DD). Use for date-relative queries.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_complaints",
      description:
        "List complaint records with optional filters. Returns up to 200 rows including branch, department, subject, status, raised_by, and timestamps.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "in_progress", "resolved", "escalated", "rejected"],
            description: "Filter by complaint status.",
          },
          dept_code: {
            type: "string",
            description: "Filter by department_id (e.g. 'admin', 'it').",
          },
          branch: {
            type: "string",
            description: "Filter by branch/location name.",
          },
          date_from: {
            type: "string",
            description: "ISO date (YYYY-MM-DD) — include complaints on or after this date.",
          },
          date_to: {
            type: "string",
            description: "ISO date (YYYY-MM-DD) — include complaints on or before this date.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_complaint_log",
      description:
        "Get the full activity history for a specific complaint by its numeric ID.",
      parameters: {
        type: "object",
        properties: {
          complaint_id: {
            type: "integer",
            description: "The numeric ID of the complaint record.",
          },
        },
        required: ["complaint_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_mail",
      description:
        "List mail records (inward and/or outward). Returns up to 200 rows with date, type, department, location, documents, particular, and courier_status.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["inward", "outward"],
            description: "Filter by mail direction.",
          },
          branch: {
            type: "string",
            description: "Filter by branch/location name.",
          },
          department: {
            type: "string",
            description: "Filter by department name.",
          },
          date_from: {
            type: "string",
            description: "ISO date (YYYY-MM-DD) — include mail on or after this date.",
          },
          date_to: {
            type: "string",
            description: "ISO date (YYYY-MM-DD) — include mail on or before this date.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mail_edit_log",
      description:
        "Get the edit history for mail records. If mail_id is provided, returns edits for that specific record; otherwise returns the most recent 200 edits across all records.",
      parameters: {
        type: "object",
        properties: {
          mail_id: {
            type: "integer",
            description: "Optional: restrict to edits for a specific mail record ID.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stock_summary",
      description:
        "Aggregate stock levels by item and branch. Returns net_qty (in minus out), total_in, total_out, and category for each (branch, item) pair. Set low_stock_only=true to see items at or below zero.",
      parameters: {
        type: "object",
        properties: {
          branch: {
            type: "string",
            description: "Optional: restrict summary to a single branch.",
          },
          low_stock_only: {
            type: "boolean",
            description: "If true, return only items with net_qty <= 0.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stock_edit_log",
      description:
        "Return recent stock edits and deletions. Returns two arrays: 'edits' (quantity/type changes) and 'deletions' (removed entries). Optionally filter by date range.",
      parameters: {
        type: "object",
        properties: {
          date_from: {
            type: "string",
            description: "ISO date — include events on or after this date.",
          },
          date_to: {
            type: "string",
            description: "ISO date — include events on or before this date.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_employees",
      description: "List all employees. Optionally filter by branch or role.",
      parameters: {
        type: "object",
        properties: {
          branch: {
            type: "string",
            description: "Filter by branch/location name.",
          },
          role: {
            type: "string",
            description: "Filter by role (e.g. 'Admin Executive').",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dept_config",
      description:
        "Return all complaint department configurations including dept_key, name, icon, problems list, and sort order.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "count_by",
      description:
        "Generic aggregation: count rows in an allowlisted table grouped by a column. Use for quick pivot summaries like 'count complaints by status' or 'count mail by location'. Allowed tables: mail_records, complaint_records, stock_entries, mail_edit_log, employees, complaint_dept_config.",
      parameters: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description:
              "Table to query. Must be one of: mail_records, mail_edit_log, complaint_records, complaint_log, complaint_dept_config, stock_entries, edit_log, deletion_log, employees, app_config.",
          },
          group_by: {
            type: "string",
            description: "Column name to group and count by.",
          },
          filters: {
            type: "object",
            description:
              "Optional key/value equality filters (e.g. {\"status\": \"pending\"}).",
            additionalProperties: { type: "string" },
          },
        },
        required: ["table", "group_by"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handler dispatch
// ---------------------------------------------------------------------------

export async function dispatchTool(
  name: string,
  rawArgs: string
): Promise<unknown> {
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
      if (!Number.isInteger(id) || id <= 0)
        throw new Error("get_complaint_log requires a positive integer complaint_id");
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
      return queryEmployees({
        branch: args.branch as string | undefined,
        role: args.role as string | undefined,
      });

    case "get_dept_config":
      return queryDeptConfig();

    case "count_by": {
      const table = args.table as string;
      const group = args.group_by as string;
      if (!table || !group)
        throw new Error("count_by requires 'table' and 'group_by'");
      if (!isAllowedTable(table))
        throw new Error(
          `Table '${table}' is not in the allowlist. Allowed tables: mail_records, mail_edit_log, complaint_records, complaint_log, complaint_dept_config, stock_entries, edit_log, deletion_log, employees, app_config.`
        );
      const filters = (args.filters as Record<string, string>) ?? {};
      return queryCountBy(table, group, filters);
    }

    default:
      throw new Error(`Unknown tool: '${name}'`);
  }
}

// ---------------------------------------------------------------------------
// Auth helpers (shared between edge functions)
// ---------------------------------------------------------------------------

/** Compute SHA-256 of a string, return hex string. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Validate the admin token sent by the browser.
 * Browser computes: sha256(admin_otp + YYYY-MM-DD).
 * Edge fn fetches admin_otp from DB and recomputes the same.
 */
export async function validateAdminToken(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const otp = await fetchAdminOtp();
    const today = new Date().toISOString().slice(0, 10);
    const expected = await sha256Hex(otp + today);
    return token === expected;
  } catch {
    return false;
  }
}
