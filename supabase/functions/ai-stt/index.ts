/**
 * ai-stt/index.ts
 * Supabase Edge Function — Speech-to-Text via OpenAI gpt-4o-mini-transcribe.
 *
 * Accepts: multipart/form-data
 *   field "audio"  — audio file blob (webm, mp4, wav, m4a, etc.)
 *   field "token"  — admin session token (sha256(admin_otp + YYYY-MM-DD))
 *
 * Returns: { transcript: string }
 *
 * Secrets required:
 *   OPENAI_API_KEY         — from Coll_Db/server/.env
 *   SUPABASE_URL           — auto-injected by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected by Supabase
 */

import { validateAdminToken } from "../_shared/tools.ts";

// ---------------------------------------------------------------------------
// CORS headers for browser fetches
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
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ------------------------------------------------------------------
  // Parse multipart form data
  // ------------------------------------------------------------------
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return jsonResponse(
      { error: "Failed to parse multipart form data", detail: String(err) },
      400
    );
  }

  // ------------------------------------------------------------------
  // Auth: validate admin token
  // ------------------------------------------------------------------
  const token = formData.get("token");
  if (!token || typeof token !== "string") {
    return jsonResponse({ error: "Missing admin token" }, 401);
  }
  const isValid = await validateAdminToken(token);
  if (!isValid) {
    return jsonResponse({ error: "Unauthorized: invalid or expired admin token" }, 401);
  }

  // ------------------------------------------------------------------
  // Extract audio file
  // ------------------------------------------------------------------
  const audioFile = formData.get("audio");
  if (!audioFile || !(audioFile instanceof File)) {
    return jsonResponse({ error: "Missing 'audio' file field" }, 400);
  }

  const maxBytes = 25 * 1024 * 1024; // OpenAI STT limit: 25 MB
  if (audioFile.size > maxBytes) {
    return jsonResponse({ error: "Audio file exceeds 25 MB limit" }, 413);
  }

  // ------------------------------------------------------------------
  // Forward to OpenAI Whisper / gpt-4o-mini-transcribe
  // ------------------------------------------------------------------
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "OPENAI_API_KEY not configured" }, 500);
  }

  // Determine file extension from MIME type for the filename hint OpenAI needs
  const mimeToExt: Record<string, string> = {
    "audio/webm": "webm",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/flac": "flac",
  };
  const ext = mimeToExt[audioFile.type] ?? "webm";
  const filename = `audio.${ext}`;

  const sttForm = new FormData();
  sttForm.set("file", new File([await audioFile.arrayBuffer()], filename, { type: audioFile.type }));
  sttForm.set("model", "gpt-4o-mini-transcribe");
  sttForm.set("response_format", "json");

  let sttRes: Response;
  try {
    sttRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: sttForm,
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to reach OpenAI STT API", detail: String(err) }, 502);
  }

  if (!sttRes.ok) {
    const errText = await sttRes.text();
    return jsonResponse(
      { error: "OpenAI STT API error", detail: errText },
      sttRes.status
    );
  }

  const sttJson = await sttRes.json() as { text?: string };
  const transcript = sttJson.text ?? "";

  return jsonResponse({ transcript });
});
