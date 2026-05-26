export const config = { runtime: "edge" };

export default async function handler(): Promise<Response> {
  const envStatus = {
    DEEPSEEK_KEY: !!process.env.DEEPSEEK_KEY,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? "(unset, default=deepseek-chat)",
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const allSet = envStatus.DEEPSEEK_KEY && envStatus.SUPABASE_URL && envStatus.SUPABASE_SERVICE_ROLE_KEY;

  return new Response(
    JSON.stringify({ ok: allSet, env: envStatus, time: new Date().toISOString() }, null, 2),
    { status: allSet ? 200 : 503, headers: { "Content-Type": "application/json" } }
  );
}
