// Build-time guard for the PUBLIC_KARAOKE_API_BASE_URL client env var.
//
// Astro bakes `import.meta.env.PUBLIC_KARAOKE_API_BASE_URL` into the client
// bundle at build time; the app's Browse search then fetches `<base>/api/*`.
// On 2026-07-04 a production Cloudflare Pages build ran under Git Bash, where
// MSYS/MSYS2 path conversion rewrote the exported value `/` into the Git
// install path (`C:/Program Files/Git`) BEFORE Node ever saw it. The build
// succeeded, but the live site fetched `file:///C:/Program Files/Git/api/*`
// and search silently fell back to the bundled offline subset (masked by the
// FallbackBackend). This guard makes such corruption fail the build loudly.
//
// Allowed values (matches the app's supported deploy modes):
//   - unset / empty      -> offline-only build (bundled MiniSearch index)
//   - "/"                -> same-origin API (Cloudflare Pages Functions proxy)
//   - "/path"            -> root-relative API path (e.g. "/api")
//   - "https://host..."  -> absolute http(s) API origin
// Anything else (a Windows drive path, file:// URL, bare host, "//" etc.) is
// rejected. Unset/empty stays allowed so the offline-only build mode that CI
// exercises is not broken.

const API_BASE_URL_ENV = 'PUBLIC_KARAOKE_API_BASE_URL';

// `/` exactly, OR a root-relative path (`/x`, not the protocol-relative `//`),
// OR an absolute http(s) origin. Deliberately stricter than the runtime
// resolver in src/lib/search.ts (which also tolerates `./`/`../`): those forms
// are never used for a deploy, and rejecting them keeps the corruption surface
// small.
const ALLOWED = /^(\/$|\/[^/]|https?:\/\/)/u;

/** Returns true when `raw` is a legal API base (including unset/empty). */
export function isValidApiBaseUrl(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return true;
  }
  return ALLOWED.test(raw.trim());
}

/** Builds an actionable, multi-line failure message for an invalid value. */
export function apiBaseUrlErrorMessage(raw: string | undefined | null): string {
  return [
    `${API_BASE_URL_ENV} is set to an invalid value:`,
    '',
    `    ${JSON.stringify(raw)}`,
    '',
    'Allowed values:',
    '  - unset / empty        offline-only build (bundled MiniSearch index)',
    '  - "/"                  same-origin API (Cloudflare Pages Functions proxy)',
    '  - "/path"              root-relative API path (e.g. "/api")',
    '  - "https://host[...]"  absolute http(s) API origin',
    '',
    'A value like "C:/Program Files/Git" is the fingerprint of MSYS / Git Bash',
    'path conversion: under Git Bash a value of "/" (or any "/rooted" value) is',
    'rewritten into a Windows path before Node sees it, so the site ends up',
    'fetching file:///C:/Program Files/Git/api/* and search silently falls back',
    'to the offline subset. Re-run the build so MSYS does not mangle the value:',
    '',
    `  PowerShell:  $env:${API_BASE_URL_ENV}='/'; corepack pnpm --filter @karaoke/web build`,
    `  Git Bash:    MSYS2_ENV_CONV_EXCL='${API_BASE_URL_ENV}' corepack pnpm --filter @karaoke/web build`,
    '               (equivalently MSYS_NO_PATHCONV=1, or write the value as "//")',
  ].join('\n');
}

/** Throws with an actionable message when `raw` is not a legal API base. */
export function assertValidApiBaseUrl(raw: string | undefined | null): void {
  if (!isValidApiBaseUrl(raw)) {
    throw new Error(apiBaseUrlErrorMessage(raw));
  }
}
