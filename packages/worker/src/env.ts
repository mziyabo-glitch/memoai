const PUBLIC_SERVICE_ROLE = [
  "EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "EXPO_PUBLIC_OPENAI_API_KEY",
  "NEXT_PUBLIC_OPENAI_API_KEY",
];

export type ServerEnv = {
  openaiApiKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  workerSecret: string;
  transcribeModel: string;
  notesModel: string;
};

export function providerCallAllowed(env: Record<string, string | undefined>): boolean {
  return env.MEMOAI_ALLOW_PROVIDER === "1" && Boolean(env.OPENAI_API_KEY) && !publicSecret(env);
}

export function readServerEnv(env: Record<string, string | undefined>): ServerEnv | null {
  if (publicSecret(env) || !providerCallAllowed(env)) {
    return null;
  }
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const workerSecret = env.MEMOAI_WORKER_SECRET;
  const openaiApiKey = env.OPENAI_API_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey || !workerSecret || !openaiApiKey) {
    return null;
  }
  return {
    openaiApiKey,
    supabaseUrl,
    supabaseServiceRoleKey,
    workerSecret,
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe",
    notesModel: env.OPENAI_NOTES_MODEL || "gpt-4.1-mini",
  };
}

export function publicSecret(env: Record<string, string | undefined>): boolean {
  return PUBLIC_SERVICE_ROLE.some((name) => Boolean(env[name]));
}
