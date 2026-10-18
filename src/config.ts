export const DEFAULT_PORT = 4280;

/** Env lookup that treats an empty string the same as unset. */
export function envValue(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

/** Browser origins allowed to call the API with credentials. Loopback on the
 *  daemon port is always in; the public origin comes from BOTNOTE_PUBLIC_URL;
 *  BOTNOTE_CORS_ORIGINS appends extra entries verbatim. */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const port = envValue(env.BOTNOTE_PORT) ?? String(DEFAULT_PORT);
  const out = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const push = (origin: string) => {
    if (!out.includes(origin)) out.push(origin);
  };
  const publicUrl = envValue(env.BOTNOTE_PUBLIC_URL);
  if (publicUrl) {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      throw new Error(`BOTNOTE_PUBLIC_URL is not a valid URL: ${publicUrl}`);
    }
    if (parsed.origin === "null") {
      throw new Error(`BOTNOTE_PUBLIC_URL must be an http(s) URL: ${publicUrl}`);
    }
    push(parsed.origin);
  }
  for (const o of (env.BOTNOTE_CORS_ORIGINS ?? "").split(",")) {
    const t = o.trim();
    if (t) push(t);
  }
  return out;
}
