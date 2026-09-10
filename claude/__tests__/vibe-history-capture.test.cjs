#!/usr/bin/env node
/**
 * Tests for vibe-history-capture.cjs (SessionEnd/PreCompact hook entry point).
 * Run: node --test $HOME/.claude/hooks/__tests__/vibe-history-capture.test.cjs
 *
 * VIBE_HISTORY_ROOT is a fixed, hardcoded path (not env-var-driven, by design —
 * see the hook's own top-of-file comment). Tests that exercise the full
 * happy-path necessarily write under that real path; every test that creates a
 * project directory there removes it again in a `finally` block so no test
 * artifacts are left behind.
 *
 * Covers: git-repo cwd -> project name from git root basename, non-git cwd ->
 * basename(cwd) fallback, missing/malformed stdin -> exit 0 no crash,
 * hooks.vibe-history-capture=false -> exit 0 with no file written, and
 * sessionId sanitization (Fix 3) so a malformed session_id can't escape its
 * project directory as a path-traversal-shaped segment.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'vibe-history-capture.cjs');
// Hermetic store: an isolated temp root injected into every spawned hook via
// $VIBE_HISTORY_ROOT (see core/vibe-history-config.cjs), so tests never touch the
// user's real capture store.
const VIBE_HISTORY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-capture-store-'));

/**
 * Run vibe-history-capture.cjs with given stdin payload (or raw string) and options.
 * @param {Object|string|null} inputData - JSON payload object, raw string, or null/empty for empty stdin
 * @param {Object} [options]
 * @param {Object} [options.env] - extra env vars merged over process.env
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function runHook(inputData, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      cwd: options.cwd || process.cwd(),
      // Default the store to the hermetic temp root; a test may still override
      // via options.env (e.g. the kill-switch test points VIBE_HISTORY_CONFIG).
      env: { ...process.env, VIBE_HISTORY_ROOT, ...options.env }
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    if (inputData !== null && inputData !== undefined) {
      proc.stdin.write(typeof inputData === 'string' ? inputData : JSON.stringify(inputData));
    }
    proc.stdin.end();

    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', reject);

    setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Hook execution timed out'));
    }, 10000);
  });
}

/** Create a fresh temp dir for one test's fixtures. */
function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a minimal, parseable transcript JSONL file with one user turn. */
function writeMinimalTranscript(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ type: 'user', timestamp: '2026-07-04T10:00:00.000Z', message: { content: 'hello' } }) + '\n',
    'utf8'
  );
  return filePath;
}

/** Recursively remove a directory tree under VIBE_HISTORY_ROOT created by a test. Never throws. */
function cleanupCaptureDir(projectName) {
  try {
    const projectDir = path.join(VIBE_HISTORY_ROOT, projectName);
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup — never fail the test suite over it
  }
}

/** List all files recursively under a directory (empty array if it doesn't exist). */
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

describe('vibe-history-capture.cjs', () => {
  describe('project name derivation', () => {
    it('derives project name from git root basename when cwd is a git repo', async () => {
      const gitDir = createTempDir('vibe-capture-git-');
      const projectName = `vibe-capture-test-git-${Date.now()}`;
      const repoDir = path.join(gitDir, projectName);
      fs.mkdirSync(repoDir, { recursive: true });
      execSync('git init -q', { cwd: repoDir });

      const transcriptPath = writeMinimalTranscript(path.join(gitDir, 'transcript.jsonl'));
      const sessionId = `sess-git-${Date.now()}`;

      try {
        const result = await runHook({
          session_id: sessionId,
          cwd: repoDir,
          transcript_path: transcriptPath,
          hook_event_name: 'SessionEnd',
          reason: 'other'
        });

        assert.strictEqual(result.exitCode, 0, 'hook should always exit 0');

        const files = listFilesRecursive(path.join(VIBE_HISTORY_ROOT, projectName));
        assert.strictEqual(files.length, 1, 'exactly one markdown snapshot should be written for the git-repo project');
        const content = fs.readFileSync(files[0], 'utf8');
        assert.match(content, new RegExp(`_project: ${projectName} ·`), 'digest header should record the git-root-derived project name');
      } finally {
        cleanupCaptureDir(projectName);
        fs.rmSync(gitDir, { recursive: true, force: true });
      }
    });

    it('falls back to basename(cwd) when cwd is not a git repo', async () => {
      const nonGitDir = createTempDir('vibe-capture-nongit-');
      // Guard against ambient parent .git dirs (e.g. os.tmpdir() nested in a repo)
      // by confirming git actually reports no repo here before asserting on it.
      let isGitRepo = true;
      try {
        execSync('git rev-parse --show-toplevel', { cwd: nonGitDir, stdio: ['ignore', 'ignore', 'ignore'] });
      } catch (_) {
        isGitRepo = false;
      }
      assert.strictEqual(isGitRepo, false, 'test precondition: temp dir must not be inside a git repo');

      const projectName = path.basename(nonGitDir);
      const transcriptPath = writeMinimalTranscript(path.join(nonGitDir, 'transcript.jsonl'));
      const sessionId = `sess-nongit-${Date.now()}`;

      try {
        const result = await runHook({
          session_id: sessionId,
          cwd: nonGitDir,
          transcript_path: transcriptPath,
          hook_event_name: 'SessionEnd',
          reason: 'other'
        });

        assert.strictEqual(result.exitCode, 0);

        const files = listFilesRecursive(path.join(VIBE_HISTORY_ROOT, projectName));
        assert.strictEqual(files.length, 1, 'exactly one markdown snapshot should be written under the basename(cwd) project dir');
        const content = fs.readFileSync(files[0], 'utf8');
        assert.match(content, new RegExp(`_project: ${projectName} ·`));
      } finally {
        cleanupCaptureDir(projectName);
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('malformed/missing stdin resilience', () => {
    it('exits 0 with no crash on empty stdin', async () => {
      const result = await runHook(null);
      assert.strictEqual(result.exitCode, 0);
    });

    it('exits 0 with no crash on malformed (non-JSON) stdin', async () => {
      const result = await runHook('{not valid json,,,');
      assert.strictEqual(result.exitCode, 0);
    });
  });

  describe('kill-switch (config.json enabled:false)', () => {
    it('exits 0 immediately and writes no file when config.json has enabled:false', async () => {
      const cfgDir = createTempDir('vibe-capture-cfg-');
      const cfgPath = path.join(cfgDir, 'config.json');
      fs.writeFileSync(cfgPath, JSON.stringify({ enabled: false }));

      const workDir = createTempDir('vibe-capture-disabled-work-');
      const projectName = `vibe-capture-test-disabled-${Date.now()}`;
      const cwdDir = path.join(workDir, projectName);
      fs.mkdirSync(cwdDir, { recursive: true });
      const transcriptPath = writeMinimalTranscript(path.join(workDir, 'transcript.jsonl'));

      try {
        const result = await runHook({
          session_id: `sess-disabled-${Date.now()}`,
          cwd: cwdDir,
          transcript_path: transcriptPath,
          hook_event_name: 'SessionEnd',
          reason: 'other'
        }, { env: { VIBE_HISTORY_CONFIG: cfgPath } });

        assert.strictEqual(result.exitCode, 0);
        assert.ok(
          !fs.existsSync(path.join(VIBE_HISTORY_ROOT, projectName)),
          'no capture directory should be created when capture is disabled'
        );
      } finally {
        cleanupCaptureDir(projectName);
        fs.rmSync(cfgDir, { recursive: true, force: true });
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  describe('sessionId sanitization (Fix 3)', () => {
    it('sanitizes a path-traversal-shaped session_id into a single safe filename', async () => {
      const workDir = createTempDir('vibe-capture-traversal-work-');
      const projectName = `vibe-capture-test-traversal-${Date.now()}`;
      const cwdDir = path.join(workDir, projectName);
      fs.mkdirSync(cwdDir, { recursive: true });
      const transcriptPath = writeMinimalTranscript(path.join(workDir, 'transcript.jsonl'));

      const maliciousSessionId = '../../../malicious-session';

      try {
        const result = await runHook({
          session_id: maliciousSessionId,
          cwd: cwdDir,
          transcript_path: transcriptPath,
          hook_event_name: 'SessionEnd',
          reason: 'other'
        });

        assert.strictEqual(result.exitCode, 0);

        // Traversal must not escape VIBE_HISTORY_ROOT/<projectName> — no
        // sibling "malicious-session" file/dir should appear directly under
        // the capture root (which would indicate the traversal succeeded).
        assert.ok(
          !fs.existsSync(path.join(VIBE_HISTORY_ROOT, 'malicious-session.md')),
          'sanitized session_id must not allow escaping the project directory'
        );
        assert.ok(
          !fs.existsSync(path.join(VIBE_HISTORY_ROOT, '..', 'malicious-session.md')),
          'sanitized session_id must not allow escaping above the capture root'
        );

        const projectDir = path.join(VIBE_HISTORY_ROOT, projectName);
        assert.ok(fs.existsSync(projectDir), 'project directory should still be created normally');
        const files = fs.readdirSync(projectDir, { withFileTypes: true })
          .filter(e => e.isFile())
          .map(e => e.name);
        assert.strictEqual(files.length, 1, 'exactly one sanitized session file should exist');
        assert.ok(!files[0].includes('/'), 'sanitized session filename must not contain a path separator');
        assert.ok(!files[0].includes('\\'), 'sanitized session filename must not contain a path separator');
      } finally {
        cleanupCaptureDir(projectName);
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  describe('single-file-per-session overwrite behavior', () => {
    it('firing the hook twice for the same session overwrites one file instead of accumulating two', async () => {
      const workDir = createTempDir('vibe-capture-overwrite-work-');
      const projectName = `vibe-capture-test-overwrite-${Date.now()}`;
      const cwdDir = path.join(workDir, projectName);
      fs.mkdirSync(cwdDir, { recursive: true });
      const transcriptPath = path.join(workDir, 'transcript.jsonl');
      const sessionId = `sess-overwrite-${Date.now()}`;

      try {
        // First firing: transcript has one user turn.
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify({ type: 'user', timestamp: '2026-07-04T10:00:00.000Z', message: { content: 'first message' } }) + '\n',
          'utf8'
        );
        const result1 = await runHook({
          session_id: sessionId,
          cwd: cwdDir,
          transcript_path: transcriptPath,
          hook_event_name: 'PreCompact',
          trigger: 'manual'
        });
        assert.strictEqual(result1.exitCode, 0);

        const filesAfterFirst = listFilesRecursive(path.join(VIBE_HISTORY_ROOT, projectName));
        assert.strictEqual(filesAfterFirst.length, 1, 'first firing should write exactly one file');
        assert.match(fs.readFileSync(filesAfterFirst[0], 'utf8'), /first message/);

        // Second firing: transcript grew with a new turn (simulates more conversation happening).
        fs.appendFileSync(
          transcriptPath,
          JSON.stringify({ type: 'user', timestamp: '2026-07-04T10:05:00.000Z', message: { content: 'second message' } }) + '\n',
          'utf8'
        );
        const result2 = await runHook({
          session_id: sessionId,
          cwd: cwdDir,
          transcript_path: transcriptPath,
          hook_event_name: 'SessionEnd',
          reason: 'clear'
        });
        assert.strictEqual(result2.exitCode, 0);

        const filesAfterSecond = listFilesRecursive(path.join(VIBE_HISTORY_ROOT, projectName));
        assert.strictEqual(filesAfterSecond.length, 1, 'second firing must overwrite, not add a second file');
        assert.strictEqual(filesAfterSecond[0], filesAfterFirst[0], 'the file path itself must be identical across firings');

        const finalContent = fs.readFileSync(filesAfterSecond[0], 'utf8');
        assert.match(finalContent, /first message/, 'regenerated content still includes earlier turns (full re-parse, not incremental)');
        assert.match(finalContent, /second message/, 'regenerated content includes the new turn');
      } finally {
        cleanupCaptureDir(projectName);
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});
