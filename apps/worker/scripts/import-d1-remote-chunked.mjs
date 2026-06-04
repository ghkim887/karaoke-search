#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { main as assertRemoteD1Guard } from './guard-remote-d1.mjs';

const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DATABASE_NAME = 'karaoke-songs';
const DEFAULT_SQL_PATH = join(WORKER_ROOT, '.wrangler', 'import', 'songs-d1.sql');
const DEFAULT_CHUNKS_DIR = join(WORKER_ROOT, '.wrangler', 'import', 'remote-chunks');
const MAX_REMOTE_D1_EXECUTE_FILE_BYTES = 512_000;
const PARTIAL_REPLACE_ENV = 'KARAOKE_D1_REMOTE_PARTIAL_REPLACE_OK';

export function assertRemoteChunkedImportAllowed(env = process.env) {
  if (env[PARTIAL_REPLACE_ENV] !== '1') {
    throw new Error(
      `Refusing chunked remote D1 import: this replacement is not atomic. Set ${PARTIAL_REPLACE_ENV}=1 only after accepting the partial-import recovery procedure.`,
    );
  }
}

export function splitSqlStatements(sqlText) {
  const statements = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < sqlText.length; index += 1) {
    const character = sqlText[index];
    current += character;
    if (character === "'") {
      if (inString && sqlText[index + 1] === "'") {
        current += sqlText[index + 1];
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && character === ';') {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = '';
    }
  }

  const trailingStatement = current.trim();
  if (trailingStatement.length > 0) {
    throw new Error('D1 import SQL contains a trailing statement without a terminating semicolon.');
  }
  for (const statement of statements) {
    if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(statement)) {
      throw new Error(
        'D1 remote chunked import refuses transaction control statements; chunks execute independently.',
      );
    }
  }
  return statements;
}

export function splitSqlIntoChunks({ sqlPath, chunksDir, maxBytes }) {
  if (!existsSync(sqlPath)) {
    throw new Error(`D1 import SQL file does not exist: ${sqlPath}`);
  }

  rmSync(chunksDir, { recursive: true, force: true });
  mkdirSync(chunksDir, { recursive: true });

  const sql = readFileSync(sqlPath, 'utf8');
  const statements = splitSqlStatements(sql);

  const chunks = [];
  let current = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const index = chunks.length + 1;
    const chunkPath = join(chunksDir, `chunk-${String(index).padStart(4, '0')}.sql`);
    const content = `${current.join('\n')}\n`;
    writeFileSync(chunkPath, content, 'utf8');
    chunks.push({ path: chunkPath, statements: current.length, bytes: Buffer.byteLength(content) });
    current = [];
    currentBytes = 0;
  };

  for (const statement of statements) {
    const statementLine = `${statement}\n`;
    const statementBytes = Buffer.byteLength(statementLine);
    if (statementBytes > maxBytes) {
      throw new Error(
        `D1 import statement is ${statementBytes} bytes, exceeding remote chunk limit ${maxBytes}. Lower the SQL statement batch size before remote import.`,
      );
    }
    if (current.length > 0 && currentBytes + statementBytes > maxBytes) {
      flush();
    }
    current.push(statement);
    currentBytes += statementBytes;
  }
  flush();

  return { sourceBytes: statSync(sqlPath).size, sourceStatements: statements.length, chunks };
}

export function wranglerInvocation(args) {
  if (process.platform !== 'win32') {
    return { command: 'wrangler', args };
  }
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', 'wrangler', ...args],
  };
}

export function executeChunk({ databaseName, chunk, index, total }) {
  console.log(
    `[${index}/${total}] importing ${chunk.path} (${chunk.bytes} bytes, ${chunk.statements} statements)`,
  );
  const invocation = wranglerInvocation([
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--file',
    chunk.path,
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: WORKER_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed for ${chunk.path} with exit code ${result.status}`);
  }
}

export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    args.set(arg.slice(2), next);
    i += 1;
  }
  return {
    databaseName: args.get('database') ?? DEFAULT_DATABASE_NAME,
    sqlPath: args.get('file') ?? DEFAULT_SQL_PATH,
    chunksDir: args.get('chunks-dir') ?? DEFAULT_CHUNKS_DIR,
    maxBytes: Number(args.get('max-bytes') ?? MAX_REMOTE_D1_EXECUTE_FILE_BYTES),
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  assertRemoteD1Guard([], env);
  assertRemoteChunkedImportAllowed(env);
  const options = parseArgs(argv);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`Invalid --max-bytes value: ${options.maxBytes}`);
  }

  const plan = splitSqlIntoChunks({
    sqlPath: options.sqlPath,
    chunksDir: options.chunksDir,
    maxBytes: options.maxBytes,
  });

  console.log(
    `Prepared ${plan.chunks.length} remote D1 import chunks from ${plan.sourceStatements} statements ` +
      `(${plan.sourceBytes} bytes, max chunk ${options.maxBytes} bytes).`,
  );

  plan.chunks.forEach((chunk, index) => {
    executeChunk({
      databaseName: options.databaseName,
      chunk,
      index: index + 1,
      total: plan.chunks.length,
    });
  });

  console.log('Remote D1 chunked import complete.');
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
