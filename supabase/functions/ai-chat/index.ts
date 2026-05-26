/**
 * ai-chat/index.ts
 * Supabase Edge Function — AI chat loop using DeepSeek V4 Pro.
 *
 * POST /functions/v1/ai-chat
 * Body (JSON):
 *   {
 *     "token":    string,              // admin session token
 *     "messages": ChatMessage[],       // [{ role, content }, ...]
 *     "session_id"?: string            // optional: correlate with past sessions
 *   }
 *
 * Returns (JSON):
 *   {
 *     "reply":    string,              // final assistant message (markdown)
 *     "session_id": string             // UUID for this conversation turn
 *   }
 *
 * Secrets required:
 *   DEEPSEEK_KEY              — DeepSeek API key
 *   DEEPSEEK_MODEL            — defaults to "deepseek-chat" (V4 Pro alias)
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { validateAdminToken, TOOL_SCHEMAS, dispatchTool, ToolCall } from "../_shared/tools.ts";
import { persistChatSession } from "../_shared/db.ts";

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

interface DeepSeekChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

interface DeepSeekResponse {
  choices: DeepSeekChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ---------------------------------------------------------------------------
// DeepSeek client
// ---------------------------------------------------------------------------

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const MAX_TOOL_ROUNDS = 8; // prevent runaway loops

async function callDeepSeek(
  messages: ChatMessage[],
  apiKey: string,
  model: string
): Promise<DeepSeekChoice> {
  const res = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: "auto",
      max_tokens: 4096,
      temperature: 0.2, // low temperature for factual Q&A
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as DeepSeekResponse;
  const choice = json.choices?.[0];
  if (!choice) throw new Error("DeepSeek returned no choices");
  return choice;
}

// ---------------------------------------------------------------------------
// System prompt factory
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are an AI assistant for the Mail_Record administration system.
You have read-only access to the following data modules via tools:
- Complaint management (complaint_records, complaint_log, complaint_dept_config)
- Mail management (mail_records, mail_edit_log)
- Stationary / Stock management (stock_entries, edit_log, deletion_log)
- Employee directory (employees)

Guidelines:
1. Always use tools to retrieve live data before answering. Do not make up figures.
2. After fetching data, cite row counts and specific values.
3. When the user asks for a "summary" or "report", call multiple tools to cover all modules.
4. Format responses in Markdown: use **bold** for key metrics, bullet lists for breakdowns.
5. If a question is outside the available data, say so clearly.
6. Today's date is ${today}. Use this for "this week", "today", "recent" queries.
7. Keep answers concise but complete. End with a brief observation or suggestion if relevant.`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ------------------------------------------------------------------
  // Parse request body
  // ------------------------------------------------------------------
  let body: { token?: string; messages?: ChatMessage[]; session_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------
  const { token, messages: incomingMessages, session_id: clientSessionId } = body;

  if (!token) {
    return jsonResponse({ error: "Missing admin token" }, 401);
  }
  const isValid = await validateAdminToken(token);
  if (!isValid) {
    return jsonResponse({ error: "Unauthorized: invalid or expired admin token" }, 401);
  }

  if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) {
    return jsonResponse({ error: "messages array is required and must not be empty" }, 400);
  }

  // ------------------------------------------------------------------
  // Validate API key
  // ------------------------------------------------------------------
  const deepseekKey = Deno.env.get("DEEPSEEK_KEY");
  if (!deepseekKey) {
    return jsonResponse({ error: "DEEPSEEK_KEY not configured" }, 500);
  }
  const model = Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-chat";

  // ------------------------------------------------------------------
  // Build message thread (system + history)
  // ------------------------------------------------------------------
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...incomingMessages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.name ? { name: m.name } : {}),
    })),
  ];

  // ------------------------------------------------------------------
  // Tool-calling loop
  // ------------------------------------------------------------------
  let finalReply = "";
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    let choice: DeepSeekChoice;
    try {
      choice = await callDeepSeek(messages, deepseekKey, model);
    } catch (err) {
      return jsonResponse({ error: "LLM call failed", detail: String(err) }, 502);
    }

    const { message, finish_reason } = choice;

    // Append the assistant turn to the thread
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    });

    // If no tool calls, we have the final answer
    if (!message.tool_calls || message.tool_calls.length === 0) {
      finalReply = message.content ?? "";
      break;
    }

    // Execute each requested tool call in parallel
    const toolResults = await Promise.allSettled(
      message.tool_calls.map(async (tc: ToolCall) => {
        let result: unknown;
        try {
          result = await dispatchTool(tc.function.name, tc.function.arguments);
        } catch (err) {
          result = { error: String(err) };
        }
        return { id: tc.id, name: tc.function.name, result };
      })
    );

    // Append tool results to the thread
    for (const settled of toolResults) {
      if (settled.status === "fulfilled") {
        const { id, name, result } = settled.value;
        messages.push({
          role: "tool",
          tool_call_id: id,
          name,
          content: JSON.stringify(result),
        });
      } else {
        // Settled as rejected (shouldn't happen given try/catch inside, but handle it)
        messages.push({
          role: "tool",
          tool_call_id: "unknown",
          content: JSON.stringify({ error: settled.reason }),
        });
      }
    }

    // If finish_reason is "stop" with no tool calls, we're done (defensive)
    if (finish_reason === "stop") {
      finalReply = message.content ?? "";
      break;
    }
  }

  if (!finalReply && rounds >= MAX_TOOL_ROUNDS) {
    finalReply = "I reached the maximum number of reasoning steps. Please refine your question.";
  }

  // ------------------------------------------------------------------
  // Persist transcript (best-effort, non-blocking)
  // ------------------------------------------------------------------
  const sessionId = clientSessionId ?? crypto.randomUUID();
  await persistChatSession({
    admin_id: "global_admin", // single global admin; expand if multi-tenant
    transcript: {
      session_id: sessionId,
      messages: messages.slice(1), // exclude system prompt from stored transcript
      final_reply: finalReply,
      rounds,
      timestamp: new Date().toISOString(),
    },
  });

  return jsonResponse({ reply: finalReply, session_id: sessionId });
});
