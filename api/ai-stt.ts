import { validateAdminTokenDetailed } from "./_lib/tools";

export const config = { runtime: "edge" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return json({ error: "Failed to parse multipart form data", detail: String(err) }, 400);
  }

  const token = formData.get("token");
  if (!token || typeof token !== "string") return json({ error: "Missing admin token" }, 401);
  const auth = await validateAdminTokenDetailed(token);
  if (!auth.ok) return json({ error: "Unauthorized", reason: auth.reason }, 401);

  const audioFile = formData.get("audio");
  if (!audioFile || !(audioFile instanceof File)) return json({ error: "Missing 'audio' file field" }, 400);

  const maxBytes = 25 * 1024 * 1024;
  if (audioFile.size > maxBytes) return json({ error: "Audio exceeds 25 MB" }, 413);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json({ error: "OPENAI_API_KEY not configured" }, 500);

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
      headers: { Authorization: `Bearer ${apiKey}` },
      body: sttForm,
    });
  } catch (err) {
    return json({ error: "Failed to reach OpenAI STT API", detail: String(err) }, 502);
  }

  if (!sttRes.ok) {
    const errText = await sttRes.text();
    return json({ error: "OpenAI STT API error", detail: errText }, sttRes.status);
  }

  const sttJson = (await sttRes.json()) as { text?: string };
  return json({ transcript: sttJson.text ?? "" });
}
