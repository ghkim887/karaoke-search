// Tests for scripts/lib/cli.mjs — the shared realpath-hardened CLI entrypoint
// guard. The critical regression it protects against: a plain
// `import.meta.url === pathToFileURL(process.argv[1]).href` comparison silently
// returns false when the script is invoked through a symlink (Node realpaths
// the ESM main module, so import.meta.url is the real path while argv[1] keeps
// the symlink path). A guarded CLI body would then no-op — exit 0 without doing
// anything, the worst failure mode for data tooling. isCliInvocation compares
// realpaths instead, so a symlinked invocation still runs.

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { isCliInvocation } from './lib/cli.mjs';

// isCliInvocation reads process.argv[1]; save/restore around each test so the
// mutation never leaks into other test files sharing the worker.
let savedArgv1;
beforeEach(() => {
  savedArgv1 = process.argv[1];
});
afterEach(() => {
  process.argv[1] = savedArgv1;
});

describe('isCliInvocation', () => {
  it('returns false when process.argv[1] is missing', () => {
    process.argv[1] = undefined;
    assert.equal(isCliInvocation('file:///whatever.mjs'), false);
  });

  it('returns true when argv[1] is the module path (direct node invocation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-guard-real-'));
    try {
      const target = join(dir, 'entry.mjs');
      writeFileSync(target, '// entry\n');
      // Node realpaths the main module for import.meta.url; mirror that.
      const moduleUrl = pathToFileURL(realpathSync(target)).href;
      process.argv[1] = target;
      assert.equal(isCliInvocation(moduleUrl), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when argv[1] points at a different file than the module', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-guard-other-'));
    try {
      const entry = join(dir, 'entry.mjs');
      const other = join(dir, 'other.mjs');
      writeFileSync(entry, '// entry\n');
      writeFileSync(other, '// other\n');
      process.argv[1] = other;
      assert.equal(isCliInvocation(pathToFileURL(realpathSync(entry)).href), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true for a symlinked invocation (realpath, not plain-URL, comparison)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-guard-symlink-'));
    try {
      const target = join(dir, 'entry.mjs');
      const link = join(dir, 'entry-link.mjs');
      writeFileSync(target, '// entry\n');
      try {
        symlinkSync(target, link);
      } catch (err) {
        // Windows without Developer Mode / admin cannot create file symlinks
        // (EPERM); some filesystems lack the syscall (ENOSYS). Skip rather than
        // fail — CI runs on Linux, where the regression is exercised.
        if (err.code === 'EPERM' || err.code === 'ENOSYS') return;
        throw err;
      }
      // Invoked via the symlink: argv[1] is the link, but import.meta.url is the
      // realpath'd target (what Node hands the module). The plain-URL comparison
      // this guard replaces would be false here (link URL !== target URL); the
      // realpath comparison must be true.
      process.argv[1] = link;
      assert.equal(isCliInvocation(pathToFileURL(realpathSync(link)).href), true);
      assert.notEqual(pathToFileURL(target).href, pathToFileURL(link).href);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
