/**
 * Credential redaction for anything that gets logged.
 *
 * Xtream providers put the subscriber's credentials directly in the URL, in two
 * different shapes: as `?username=&password=` query params, and as
 * `/live/<user>/<pass>/<id>.ts` path segments. The relay additionally wraps a
 * whole provider URL inside `/api/stream?url=<percent-encoded>`, so a naive
 * scan of the top-level query string misses the nested copy.
 *
 * Its own module (no imports, no side effects) so it stays trivially testable
 * and can be reused by any future logging path — see redactUrl.test.ts.
 */

const SENSITIVE_PARAMS = new Set(["username", "password", "pass", "user", "token", "auth", "api_key"]);

/**
 * Replace credentials in `url` with `***`, recursing `depth` levels into
 * nested URLs carried in query params. Returns a placeholder rather than the
 * input if parsing fails — never echo back something we could not inspect.
 */
export const redactUrl = (raw: string, depth = 2): string => {
  try {
    const parsed = new URL(raw, "http://localhost");
    for (const key of [...parsed.searchParams.keys()]) {
      const value = parsed.searchParams.get(key) ?? "";
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) parsed.searchParams.set(key, "***");
      else if (depth > 0 && /^https?:\/\//i.test(value)) parsed.searchParams.set(key, redactUrl(value, depth - 1));
    }
    parsed.pathname = parsed.pathname.replace(
      /^\/(live|movie|series)\/[^/]+\/[^/]+\//i,
      (_match, kind: string) => `/${kind}/***/***/`,
    );
    // Keep relative inputs relative — the log shows app-relative paths as-is.
    return /^[a-z]+:\/\//i.test(raw) ? parsed.toString() : parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return "<unparseable url>";
  }
};
