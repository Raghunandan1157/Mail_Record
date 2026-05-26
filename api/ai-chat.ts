import { validateAdminTokenDetailed, TOOL_SCHEMAS, dispatchTool, ToolCall } from "./_lib/tools";
import { persistChatSession } from "./_lib/db";

export const config = { runtime: "edge" };

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const MAX_TOOL_ROUNDS = 8;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

interface DeepSeekChoice {
  message: { role: string; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function callDeepSeek(messages: ChatMessage[], apiKey: string, model: string): Promise<DeepSeekChoice> {
  const res = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools: TOOL_SCHEMAS, tool_choice: "auto", max_tokens: 4096, temperature: 0.2 }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("DeepSeek returned no choices");
  return choice;
}

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are an AI assistant for the Mail_Record administration system.
You have read-only access to: complaints, mail, stationary/stock, employees.

Guidelines:
1. Always use tools to retrieve live data. Never make up figures.
2. After fetching data, cite row counts and specific values.
3. For "summary" or "report" requests, call multiple tools across modules.
4. Format in Markdown: **bold** for key metrics, bullet lists for breakdowns.
5. If outside available data, say so.
6. Today is ${today}.
7. Keep answers concise but complete.`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { token?: string; messages?: ChatMessage[]; session_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { token, messages: incoming, session_id: clientSessionId } = body;
  if (!token) return json({ error: "Missing admin token" }, 401);
  const auth = await validateAdminTokenDetailed(token);
  if (!auth.ok) return json({ error: "Unauthorized: invalid or expired admin token", reason: auth.reason }, 401);
  if (!Array.isArray(incoming) || incoming.length === 0) return json({ error: "messages array required" }, 400);

  const deepseekKey = process.env.DEEPSEEK_KEY;
  if (!deepseekKey) return json({ error: "DEEPSEEK_KEY not configured" }, 500);
  const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...incoming.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.name ? { name: m.name } : {}),
    })),
  ];

  let finalReply = "";
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    let choice: DeepSeekChoice;
    try {
      choice = await callDeepSeek(messages, deepseekKey, model);
    } catch (err) {
      return json({ error: "LLM call failed", detail: String(err) }, 502);
    }
    const { message, finish_reason } = choice;
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    });
    if (!message.tool_calls || message.tool_calls.length === 0) {
      finalReply = message.content ?? "";
      break;
    }
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
    for (const settled of toolResults) {
      if (settled.status === "fulfilled") {
        const { id, name, result } = settled.value;
        messages.push({ role: "tool", tool_call_id: id, name, content: JSON.stringify(result) });
      } else {
        messages.push({ role: "tool", tool_call_id: "unknown", content: JSON.stringify({ error: settled.reason }) });
      }
    }
    if (finish_reason === "stop") {
      finalReply = message.content ?? "";
      break;
    }
  }

  if (!finalReply && rounds >= MAX_TOOL_ROUNDS) {
    finalReply = "I reached the maximum number of reasoning steps. Please refine your question.";
  }

  const sessionId = clientSessionId ?? crypto.randomUUID();
  await persistChatSession({
    admin_id: "global_admin",
    transcript: {
      session_id: sessionId,
      messages: messages.slice(1),
      final_reply: finalReply,
      rounds,
      timestamp: new Date().toISOString(),
    },
  });

  return json({ reply: finalReply, session_id: sessionId });
}
