#!/usr/bin/env node
// Postbuild belt-and-suspenders for the PUBLIC_KARAOKE_API_BASE_URL guard.
// astro.config.mjs validates the ENV VALUE before the build; this scans the
// BUILT JS/HTML for the fingerprint of MSYS / Git-Bash path mangling that
// would bake a filesystem path (e.g. "C:/Program Files/Git") as the API base
// and silently fall back to the offline subset. See scripts/api-base-url-guard.mjs
// for the full incident writeup. Cheap; runs after check-bundle-size.mjs.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '..', 'dist');

if (!existsSync(distDir)) {
  console.error(`ERROR: ${distDir} does not exist. Run \`astro build\` first.`);
  process.exit(1);
}

// A drive-letter path ("C:/", "C:\") whose letter is NOT part of a longer word
// — the negative look-behind excludes the "p:/" / "s:/" that occur inside
// http:// / https:// — or an explicit file:// URL. Either is a corruption
// fingerprint that never appears in a clean build (verified against a valid
// `/` build). The `g` flag lets us report every hit.
const CORRUPTION = /(?<![A-Za-z])[A-Za-z]:[\\/]|file:\/\/\//g;

/** Recursively collect built JS/HTML (skips data/ JSON and binary fonts). */
function collect(dir) {
  const out = [];
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

const files = collect(distDir);
const violations = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const match = text.match(CORRUPTION);
  if (match !== null) {
    violations.push({ file, sample: [...new Set(match)].slice(0, 5).join(', ') });
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
  console.error("       or Git Bash: MSYS2_ENV_CONV_EXCL='PUBLIC_KARAOKE_API_BASE_URL' ... build");
  process.exit(1);
}

console.log(`OK: no API-base corruption signature in ${files.length} built JS/HTML files`);
process.exit(0);
