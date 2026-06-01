#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PLACEHOLDER_DATABASE_ID = '00000000-0000-0000-0000-000000000000';

export function readD1DatabaseId(configText) {
  const match = /^\s*database_id\s*=\s*"([^"]+)"\s*$/m.exec(configText);
  return match?.[1];
}

export function assertRemoteD1WorkflowAllowed({ configText, env = process.env }) {
  const databaseId = readD1DatabaseId(configText);
  if (databaseId === undefined) {
    throw new Error('Refusing remote D1 command: wrangler.toml is missing database_id.');
  }
  if (databaseId === PLACEHOLDER_DATABASE_ID) {
    throw new Error(
      'Refusing remote D1 command: wrangler.toml still has the placeholder database_id.',
    );
  }
  if (env.KARAOKE_D1_REMOTE_OK !== '1') {
    throw new Error(
      'Refusing remote D1 command: set KARAOKE_D1_REMOTE_OK=1 after confirming the target database.',
    );
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const configPath = argv[0] ?? join(WORKER_ROOT, 'wrangler.toml');
  const configText = readFileSync(configPath, 'utf8');
  assertRemoteD1WorkflowAllowed({ configText, env });
  console.log(`Remote D1 guard passed for ${configPath}.`);
}

const entrypointPath = process.argv[1];
if (entrypointPath !== undefined && import.meta.url === pathToFileURL(entrypointPath).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
