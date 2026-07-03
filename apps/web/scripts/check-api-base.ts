#!/usr/bin/env node
// Postbuild belt-and-suspenders for the PUBLIC_KARAOKE_API_BASE_URL guard.
// astro.config.mjs validates the ENV VALUE before the build; this scans the
// BUILT JS/HTML for the fingerprint of MSYS / Git-Bash path mangling that
// would bake a filesystem path (e.g. "C:/Program Files/Git") as the API base
// and silently fall back to the offline subset. See scripts/api-base-url-guard.ts
// for the full incident writeup. Cheap; runs after check-bundle-size.mjs.
//
// Runs directly under Node (`.nvmrc` = 24, which strips TS types natively);
// the regex + detector are exported so they can be unit-tested.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The fingerprint MSYS/Git-Bash mangling actually bakes into the bundle: a
// file:// URL, OR a Windows drive path anchored to a real filesystem root
// segment (the Git install root, a user profile, the Windows dir). It is
// deliberately NOT a bare `letter:[\\/]` — that false-positives on common
// minified-JS shapes such as `{t:/[a-z]+/}`, `a?b:/x/`, `{a:1,z:/\d/}` (a
// single-letter identifier followed by a colon and a regex literal). Anchoring
// to a known root segment keeps the signal specific to the incident (the
// mangled value observed in production was "C:/Program Files/Git/"). The
// separator is `[\\/]+` so it matches both the forward-slash form MSYS emits
// and an escaped-backslash "C:\\Program Files\\Git" form in a JS string.
export const CORRUPTION_PATTERN =
  /file:\/\/\/|[A-Za-z]:[\\/]+(?:Program Files|Windows|Users|Git\b)/g;

/** Returns the distinct corruption signatures found in `text` (empty = clean). */
export function findCorruptionSignatures(text: string): string[] {
  const matches = text.match(CORRUPTION_PATTERN);
  return matches === null ? [] : [...new Set(matches)];
}

/** Recursively collect built JS/HTML (skips data/ JSON and binary fonts). */
function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full));
    } else if (full.endsWith('.js') || full.endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

  if (!existsSync(distDir)) {
    console.error(`ERROR: ${distDir} does not exist. Run \`astro build\` first.`);
    process.exit(1);
  }

  const files = collect(distDir);
  const violations: Array<{ file: string; sample: string }> = [];

  for (const file of files) {
    const signatures = findCorruptionSignatures(readFileSync(file, 'utf8'));
    if (signatures.length > 0) {
      violations.push({ file, sample: signatures.slice(0, 5).join(', ') });
    }
  }

  if (violations.length > 0) {
    console.error('ERROR: built assets contain a filesystem-path / file:// signature — the API');
    console.error('       base URL was likely corrupted by MSYS / Git-Bash path conversion');
    console.error('       (e.g. "/" rewritten to "C:/Program Files/Git"). Offending files:');
    for (const v of violations) {
      console.error(`         ${v.file}  [${v.sample}]`);
    }
    console.error(
      "       Rebuild with a clean base, e.g. PowerShell: $env:PUBLIC_KARAOKE_API_BASE_URL='/'",
    );
    console.error(
      "       or Git Bash: MSYS2_ENV_CONV_EXCL='PUBLIC_KARAOKE_API_BASE_URL' ... build",
    );
    process.exit(1);
  }

  console.log(`OK: no API-base corruption signature in ${files.length} built JS/HTML files`);
}

// Only scan (and exit) when executed as a script; importing for tests is a
// side-effect-free way to reach CORRUPTION_PATTERN / findCorruptionSignatures.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
