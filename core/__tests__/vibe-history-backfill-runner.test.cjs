#!/usr/bin/env node
/**
 * Tests for vibe-history-backfill-runner.cjs
 * Run: node --test $HOME/.claude/hooks/lib/__tests__/vibe-history-backfill-runner.test.cjs
 *
 * Covers: discoverSessionFiles (top-level .jsonl only, subagents/ + non-jsonl
 * siblings ignored), extractCwdFromTranscript (early-exit on first match,
 * null when absent), runBackfill end-to-end (real-shaped fixtures, real
 * buildMarkdownDigest, real fs writes to temp dirs only), the same-basename
 * project-merge case, per-file error isolation, and idempotency.
 *
 * All fixtures live under fs.mkdtempSync(os.tmpdir()) — never the real
 * VIBE_HISTORY_ROOT or real ~/.claude/projects/.
 */

// Pin the capture timezone so the Saigon-local filename assertions are
// deterministic regardless of the machine's local TZ. MUST precede the requires
// below (CAPTURE_TIMEZONE is resolved once at module load, transitively).
process.env.VIBE_HISTORY_TZ = 'Asia/Ho_Chi_Minh';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  discoverSessionFiles,
  extractCwdFromTranscript,
  runBackfill
} = require('../vibe-history-backfill-runner.cjs');
const { buildSessionFilename } = require('../vibe-history-project-utils.cjs');

// -- Test helpers ------------------------------------------------------------

// All fixtures' first user message uses this timestamp; digest filenames are
// `YYMMDD-HHMM-<id8>.md` derived from it (Saigon-local). Compute expected names
// via the real helper so the test stays correct regardless of TZ math.
const FIXTURE_TS = '2026-04-01T10:00:00.000Z';
const expName = (sessionId) => buildSessionFilename(FIXTURE_TS, sessionId);

/** Create a fresh temp dir for one test's fixtures. */
function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write an array of entry objects (or raw strings) as a JSONL file. */
function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = entries.map(e => (typeof e === 'string' ? e : JSON.stringify(e)));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

/** Real-shaped user turn entry, optionally carrying a top-level `cwd` field. */
function userEntry(content, cwd, extra = {}) {
  const entry = { type: 'user', timestamp: '2026-04-01T10:00:00.000Z', message: { content }, ...extra };
  if (cwd !== undefined) entry.cwd = cwd;
  return entry;
}

/** Real-shaped assistant turn entry with a single text block. */
function assistantEntry(messageId, text, cwd, extra = {}) {
  const entry = {
    type: 'assistant',
    timestamp: '2026-04-01T10:01:00.000Z',
    requestId: `req_${messageId}`,
    message: { id: messageId, content: [{ type: 'text', text }] },
    ...extra
  };
  if (cwd !== undefined) entry.cwd = cwd;
  return entry;
}

/** Read a directory tree recursively into a flat list of file paths. */
function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

// -- discoverSessionFiles -----------------------------------------------------

describe('discoverSessionFiles', () => {
  it('finds top-level .jsonl files and ignores subagents/ and non-.jsonl siblings', () => {
    const projectsRoot = createTempDir('vibe-backfill-discover-');
    try {
      // proj-a: one top-level session + a subagents/ sibling dir + a memory/ dir
      writeJsonl(path.join(projectsRoot, 'proj-a', 'sess1.jsonl'), [userEntry('hi', '/tmp/proj-a')]);
      writeJsonl(path.join(projectsRoot, 'proj-a', 'sess1', 'subagents', 'agent-x.jsonl'), [userEntry('sub hi', '/tmp/proj-a')]);
      fs.mkdirSync(path.join(projectsRoot, 'proj-a', 'memory'), { recursive: true });
      fs.writeFileSync(path.join(projectsRoot, 'proj-a', 'memory', 'foo.json'), '{}');

      // proj-b: one top-level session, nothing else
      writeJsonl(path.join(projectsRoot, 'proj-b', 'sess2.jsonl'), [userEntry('hello', '/tmp/proj-b')]);

      const results = discoverSessionFiles(projectsRoot);
      assert.strictEqual(results.length, 2, 'should find exactly the 2 top-level session files');

      const sessionIds = results.map(r => r.sessionId).sort();
      assert.deepStrictEqual(sessionIds, ['sess1', 'sess2']);

      for (const r of results) {
        assert.ok(!r.transcriptPath.includes('subagents'), 'must never point into a subagents/ dir');
        assert.ok(!r.transcriptPath.includes('memory'), 'must never point into a memory/ dir');
        assert.ok(r.sizeBytes > 0);
      }
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty array when projectsRoot does not exist', () => {
    const results = discoverSessionFiles(path.join(os.tmpdir(), 'vibe-backfill-does-not-exist-' + Date.now()));
    assert.deepStrictEqual(results, []);
  });
});

// -- extractCwdFromTranscript --------------------------------------------------

describe('extractCwdFromTranscript', () => {
  it('returns the first cwd found, skipping earlier lines without one', async () => {
    const dir = createTempDir('vibe-backfill-cwd-found-');
    try {
      const file = writeJsonl(path.join(dir, 's.jsonl'), [
        { type: 'user', timestamp: '2026-04-01T10:00:00.000Z', message: { content: 'no cwd line 1' } },
        { type: 'assistant', timestamp: '2026-04-01T10:00:01.000Z', message: { id: 'm1', content: [] } },
        userEntry('has cwd', '/Users/tester/my-project')
      ]);
      const cwd = await extractCwdFromTranscript(file);
      assert.strictEqual(cwd, '/Users/tester/my-project');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no cwd field exists anywhere in the file', async () => {
    const dir = createTempDir('vibe-backfill-cwd-missing-');
    try {
      const file = writeJsonl(path.join(dir, 's.jsonl'), [
        { type: 'user', timestamp: '2026-04-01T10:00:00.000Z', message: { content: 'line 1' } },
        { type: 'assistant', timestamp: '2026-04-01T10:00:01.000Z', message: { id: 'm1', content: [{ type: 'text', text: 'reply' }] } }
      ]);
      const cwd = await extractCwdFromTranscript(file);
      assert.strictEqual(cwd, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips malformed JSON lines without throwing and keeps scanning', async () => {
    const dir = createTempDir('vibe-backfill-cwd-malformed-');
    try {
      const file = writeJsonl(path.join(dir, 's.jsonl'), [
        '{not valid json,,,',
        'also not json at all',
        userEntry('finally valid', '/Users/tester/recovered-project')
      ]);
      const cwd = await extractCwdFromTranscript(file);
      assert.strictEqual(cwd, '/Users/tester/recovered-project');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up after maxLines when no cwd is found within the cap', async () => {
    const dir = createTempDir('vibe-backfill-cwd-cap-');
    try {
      const lines = [];
      for (let i = 0; i < 10; i++) {
        lines.push({ type: 'user', timestamp: '2026-04-01T10:00:00.000Z', message: { content: `line ${i}` } });
      }
      // cwd appears only past the (small, test-configured) cap.
      lines.push(userEntry('too late', '/Users/tester/late-project'));
      const file = writeJsonl(path.join(dir, 's.jsonl'), lines);

      const cwd = await extractCwdFromTranscript(file, { maxLines: 5 });
      assert.strictEqual(cwd, null, 'cwd found past the cap should not be returned');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -- runBackfill ----------------------------------------------------------------

describe('runBackfill', () => {
  it('converts 2 sessions from different project dirs into correct .md digests', async () => {
    const projectsRoot = createTempDir('vibe-backfill-run-basic-projects-');
    const outputRoot = createTempDir('vibe-backfill-run-basic-output-');
    try {
      writeJsonl(path.join(projectsRoot, '-Users-tester-proj-alpha', 'sess-alpha-1.jsonl'), [
        userEntry('question about alpha', '/Users/tester/proj-alpha'),
        assistantEntry('m1', 'alpha answer', '/Users/tester/proj-alpha')
      ]);
      writeJsonl(path.join(projectsRoot, '-Users-tester-proj-beta', 'sess-beta-1.jsonl'), [
        userEntry('question about beta', '/Users/tester/proj-beta'),
        assistantEntry('m2', 'beta answer', '/Users/tester/proj-beta')
      ]);

      const progressCalls = [];
      const result = await runBackfill({
        projectsRoot,
        outputRoot,
        onProgress: (i, total, f) => progressCalls.push({ i, total, sessionId: f.sessionId })
      });

      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.succeeded, 2);
      assert.strictEqual(result.skipped.length, 0);
      assert.strictEqual(progressCalls.length, 2, 'onProgress should be called once per discovered file');

      const alphaFile = path.join(outputRoot, 'proj-alpha', expName('sess-alpha-1'));
      const betaFile = path.join(outputRoot, 'proj-beta', expName('sess-beta-1'));
      assert.ok(fs.existsSync(alphaFile), 'alpha digest should exist at the expected path');
      assert.ok(fs.existsSync(betaFile), 'beta digest should exist at the expected path');

      const alphaContent = fs.readFileSync(alphaFile, 'utf8');
      assert.match(alphaContent, /Session sess-alpha-1 — Backfill \(historical-import\)/);
      assert.match(alphaContent, /project: proj-alpha/);
      assert.match(alphaContent, /cwd: \/Users\/tester\/proj-alpha/);
      assert.match(alphaContent, /question about alpha/);
      assert.match(alphaContent, /alpha answer/);

      const betaContent = fs.readFileSync(betaFile, 'utf8');
      assert.match(betaContent, /Session sess-beta-1 — Backfill \(historical-import\)/);
      assert.match(betaContent, /question about beta/);
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it('merges two differently-encoded project dirs whose cwd basenames match (same-basename merge)', async () => {
    const projectsRoot = createTempDir('vibe-backfill-run-merge-projects-');
    const outputRoot = createTempDir('vibe-backfill-run-merge-output-');
    try {
      // Two distinct encoded source dirs, differing cwd path prefixes, but
      // both resolve to the same path.basename() -> must land in one folder.
      // Distinct session ids (real session files are UUID-named; their first 8
      // chars — the filename id8 — differ, so no collision).
      writeJsonl(path.join(projectsRoot, '-Users-tester-Documents-acme-products-my-hub', 'hub-a-1.jsonl'), [
        userEntry('first side session', '/Users/tester/Documents/acme/products/my-hub')
      ]);
      writeJsonl(path.join(projectsRoot, '-Users-tester-Documents-work-acme-products-my-hub', 'hub-b-2.jsonl'), [
        userEntry('second side session', '/Users/tester/Documents/work/acme/products/my-hub')
      ]);

      const result = await runBackfill({ projectsRoot, outputRoot });

      assert.strictEqual(result.succeeded, 2);
      assert.strictEqual(result.skipped.length, 0);

      const mergedDir = path.join(outputRoot, 'my-hub');
      assert.ok(fs.existsSync(mergedDir), 'merged project dir should exist');
      const files = fs.readdirSync(mergedDir).sort();
      assert.deepStrictEqual(files, [expName('hub-a-1'), expName('hub-b-2')].sort(), 'both sessions land in the same single output project dir');
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it('skips a transcript with no discoverable cwd so the batch continues (no-cwd-found branch)', async () => {
    const projectsRoot = createTempDir('vibe-backfill-run-errors-projects-');
    const outputRoot = createTempDir('vibe-backfill-run-errors-output-');
    try {
      writeJsonl(path.join(projectsRoot, 'proj-good-1', 'sess-good-1.jsonl'), [
        userEntry('good session one', '/Users/tester/good-1')
      ]);
      // Deliberately corrupted: not valid JSONL at all, zero lines carry cwd,
      // so extraction returns null -> should be skipped with 'no-cwd-found',
      // NOT crash the run. This hits the early `if (!cwd) continue` branch,
      // NOT the `catch` block below (see the next test for that).
      writeJsonl(path.join(projectsRoot, 'proj-corrupt', 'sess-corrupt.jsonl'), [
        '{{{ not json at all ]][[',
        'garbage garbage garbage',
        'still no valid json or cwd here'
      ]);
      writeJsonl(path.join(projectsRoot, 'proj-good-2', 'sess-good-2.jsonl'), [
        userEntry('good session two', '/Users/tester/good-2')
      ]);

      const result = await runBackfill({ projectsRoot, outputRoot });

      assert.strictEqual(result.total, 3);
      assert.strictEqual(result.succeeded, 2, 'the 2 good files should still succeed despite the corrupt one');
      assert.strictEqual(result.skipped.length, 1);
      assert.match(result.skipped[0].transcriptPath, /sess-corrupt\.jsonl$/);
      assert.strictEqual(result.skipped[0].reason, 'no-cwd-found');

      assert.ok(fs.existsSync(path.join(outputRoot, 'good-1', expName('sess-good-1'))));
      assert.ok(fs.existsSync(path.join(outputRoot, 'good-2', expName('sess-good-2'))));
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it('isolates a genuine thrown error (not just a no-cwd skip) so the batch continues', async () => {
    const projectsRoot = createTempDir('vibe-backfill-run-throw-projects-');
    const outputRoot = createTempDir('vibe-backfill-run-throw-output-');
    try {
      // This file has a valid cwd (passes the `if (!cwd)` branch) but its
      // derived project dir is pre-blocked by a plain FILE below, so
      // `fs.mkdirSync(destDir, { recursive: true })` genuinely throws
      // (ENOTDIR/EEXIST) — this exercises the `catch (error)` block itself,
      // not the earlier no-cwd early-exit.
      writeJsonl(path.join(projectsRoot, 'proj-blocked', 'sess-blocked.jsonl'), [
        userEntry('this session cannot be written', '/Users/tester/blocked-project')
      ]);
      writeJsonl(path.join(projectsRoot, 'proj-good', 'sess-good.jsonl'), [
        userEntry('good session', '/Users/tester/good-project')
      ]);

      // Pre-create a FILE (not a directory) at the exact path runBackfill
      // will try to mkdirSync into.
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, 'blocked-project'), 'i am a file, not a directory', 'utf8');

      const result = await runBackfill({ projectsRoot, outputRoot });

      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.succeeded, 1, 'the good file must still succeed despite the other throwing');
      assert.strictEqual(result.skipped.length, 1);
      assert.match(result.skipped[0].transcriptPath, /sess-blocked\.jsonl$/);
      assert.notStrictEqual(result.skipped[0].reason, 'no-cwd-found', 'must be attributed to the real fs error, not misreported as a cwd-extraction skip');
      assert.ok(result.skipped[0].reason.length > 0, 'a real error message must be recorded');

      assert.ok(fs.existsSync(path.join(outputRoot, 'good-project', expName('sess-good'))), 'the unrelated good file must still be written');
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it('is idempotent: running twice against the same fixtures produces byte-identical output', async () => {
    const projectsRoot = createTempDir('vibe-backfill-run-idempotent-projects-');
    const outputRoot = createTempDir('vibe-backfill-run-idempotent-output-');
    try {
      writeJsonl(path.join(projectsRoot, 'proj-idem', 'sess-idem-1.jsonl'), [
        userEntry('first run content', '/Users/tester/idem-project'),
        assistantEntry('m1', 'first run reply', '/Users/tester/idem-project')
      ]);

      const result1 = await runBackfill({ projectsRoot, outputRoot });
      assert.strictEqual(result1.succeeded, 1);
      const destPath = path.join(outputRoot, 'idem-project', expName('sess-idem-1'));
      const firstContent = fs.readFileSync(destPath, 'utf8');

      const result2 = await runBackfill({ projectsRoot, outputRoot });
      assert.strictEqual(result2.succeeded, 1);
      const secondContent = fs.readFileSync(destPath, 'utf8');

      assert.strictEqual(secondContent, firstContent, 'second run must produce byte-identical output from the same source transcript');

      const allFiles = listFilesRecursive(outputRoot);
      assert.strictEqual(allFiles.length, 1, 're-running must overwrite in place, not accumulate a second file');
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
