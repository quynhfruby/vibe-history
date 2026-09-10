#!/usr/bin/env node
/**
 * Tests for vibe-history-project-utils.cjs
 * Run: node --test $HOME/.claude/hooks/lib/__tests__/vibe-history-project-utils.test.cjs
 *
 * Direct unit tests (no spawning — this module has no I/O side effects beyond
 * `execFileSync('git', ...)`, which these tests exercise against real temp
 * dirs, real `git init` repos, and real `git` invocations).
 */

// Pin the capture timezone so date/filename assertions are deterministic
// regardless of the machine's local TZ. MUST precede the project-utils require
// (CAPTURE_TIMEZONE is resolved once at module load).
process.env.VIBE_HISTORY_TZ = 'Asia/Ho_Chi_Minh';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  VIBE_HISTORY_ROOT,
  deriveProjectName,
  sanitizeSegment,
  formatLocalDate,
  buildSessionFilename,
  localTimeParts
} = require('../vibe-history-project-utils.cjs');

/** Create a fresh temp dir for one test's fixtures. */
function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('vibe-history-project-utils.cjs', () => {
  describe('VIBE_HISTORY_ROOT', () => {
    it('is a fixed, non-empty absolute path string', () => {
      assert.strictEqual(typeof VIBE_HISTORY_ROOT, 'string');
      assert.ok(path.isAbsolute(VIBE_HISTORY_ROOT));
    });
  });

  describe('deriveProjectName', () => {
    it('derives project name from git root basename when cwd is a git repo', () => {
      const parentDir = createTempDir('vibe-project-utils-git-');
      const repoName = `some-repo-${Date.now()}`;
      const repoDir = path.join(parentDir, repoName);
      fs.mkdirSync(repoDir, { recursive: true });
      execSync('git init -q', { cwd: repoDir });

      try {
        assert.strictEqual(deriveProjectName(repoDir), repoName);
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    });

    it('derives project name from git root basename even when cwd is a subdirectory of the repo', () => {
      const parentDir = createTempDir('vibe-project-utils-git-sub-');
      const repoName = `some-repo-${Date.now()}`;
      const repoDir = path.join(parentDir, repoName);
      const subDir = path.join(repoDir, 'src', 'nested');
      fs.mkdirSync(subDir, { recursive: true });
      execSync('git init -q', { cwd: repoDir });

      try {
        assert.strictEqual(deriveProjectName(subDir), repoName);
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    });

    it('attributes a linked worktree to the MAIN repo, not the worktree folder', () => {
      const parentDir = createTempDir('vibe-project-utils-wt-');
      const repoName = `main-repo-${Date.now()}`;
      const repoDir = path.join(parentDir, repoName);
      fs.mkdirSync(repoDir, { recursive: true });
      execSync('git init -q', { cwd: repoDir });
      execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: repoDir });
      const wtDir = path.join(parentDir, 'throwaway-worktree');
      execSync(`git worktree add -q "${wtDir}" -b wt-branch`, { cwd: repoDir });

      try {
        // cwd is the worktree folder, but the project is the main repo's name.
        assert.strictEqual(deriveProjectName(wtDir), repoName);
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    });

    it('falls back to basename(cwd) when cwd is not a git repo', () => {
      const nonGitDir = createTempDir('vibe-project-utils-nongit-');
      // Guard against ambient parent .git dirs (e.g. os.tmpdir() nested in a repo)
      let isGitRepo = true;
      try {
        execSync('git rev-parse --show-toplevel', { cwd: nonGitDir, stdio: ['ignore', 'ignore', 'ignore'] });
      } catch (_) {
        isGitRepo = false;
      }
      assert.strictEqual(isGitRepo, false, 'test precondition: temp dir must not be inside a git repo');

      try {
        assert.strictEqual(deriveProjectName(nonGitDir), path.basename(nonGitDir));
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it("falls back to 'unknown-project' for missing/empty cwd", () => {
      assert.strictEqual(deriveProjectName(''), 'unknown-project');
      assert.strictEqual(deriveProjectName(undefined), 'unknown-project');
      assert.strictEqual(deriveProjectName(null), 'unknown-project');
    });
  });

  describe('sanitizeSegment', () => {
    it('strips path-traversal-shaped characters', () => {
      assert.strictEqual(sanitizeSegment('../../../etc/passwd', 'fallback'), '..-..-..-etc-passwd');
    });

    it('strips reserved/control filename characters', () => {
      const raw = 'a<b>c:d"e/f\\g|h?i*j\x01k';
      const result = sanitizeSegment(raw, 'fallback');
      assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(result), 'no reserved characters should remain');
      assert.strictEqual(result, 'a-b-c-d-e-f-g-h-i-j-k');
    });

    it('falls back when value is empty/null/undefined', () => {
      assert.strictEqual(sanitizeSegment('', 'my-fallback'), 'my-fallback');
      assert.strictEqual(sanitizeSegment(null, 'my-fallback'), 'my-fallback');
      assert.strictEqual(sanitizeSegment(undefined, 'my-fallback'), 'my-fallback');
    });

    it("falls back to 'unknown' when both value and fallback are empty", () => {
      assert.strictEqual(sanitizeSegment('', ''), 'unknown');
      assert.strictEqual(sanitizeSegment(null, null), 'unknown');
    });

    it('trims whitespace and returns fallback if only whitespace remains after cleaning', () => {
      assert.strictEqual(sanitizeSegment('   ', 'my-fallback'), 'my-fallback');
    });

    it('leaves an already-safe value unchanged', () => {
      assert.strictEqual(sanitizeSegment('safe-session-id-123', 'fallback'), 'safe-session-id-123');
    });
  });

  describe('formatLocalDate (Asia/Ho_Chi_Minh, UTC+7)', () => {
    it('returns the local date for a daytime UTC timestamp', () => {
      assert.strictEqual(formatLocalDate('2026-07-10T05:50:29.002Z'), '2026-07-10');
    });

    it('rolls to the NEXT local day for a late-evening UTC timestamp', () => {
      // 2026-07-23T17:05Z is 2026-07-24 00:05 in Saigon → date must be the 24th.
      assert.strictEqual(formatLocalDate('2026-07-23T17:05:00.000Z'), '2026-07-24');
    });

    it('returns empty string for missing/invalid input', () => {
      assert.strictEqual(formatLocalDate(''), '');
      assert.strictEqual(formatLocalDate('not-a-date'), '');
      assert.strictEqual(formatLocalDate(null), '');
    });
  });

  describe('localTimeParts', () => {
    it('normalizes midnight to 00 (never 24)', () => {
      // 2026-07-23T17:00Z == 2026-07-24 00:00 Saigon
      const p = localTimeParts('2026-07-23T17:00:00.000Z');
      assert.strictEqual(p.hour, '00');
      assert.strictEqual(p.day, '24');
    });
  });

  describe('buildSessionFilename', () => {
    it('builds YYMMDD-HHMM-<id8>.md in Saigon local time', () => {
      // 2026-07-10T01:00Z == 08:00 Saigon
      assert.strictEqual(
        buildSessionFilename('2026-07-10T01:00:00.000Z', 'f808860b-446d-456f-bbb8-c538e2b0d89d'),
        '260710-0800-f808860b.md'
      );
    });

    it('uses the late-evening rollover date + time from Saigon', () => {
      // 2026-07-23T13:03Z == 20:03 Saigon (the user's real evening case)
      assert.strictEqual(
        buildSessionFilename('2026-07-23T13:03:00.000Z', 'abcd1234-ef'),
        '260723-2003-abcd1234.md'
      );
    });

    it('falls back to fallbackTs when firstTs is missing', () => {
      assert.strictEqual(
        buildSessionFilename(null, 'abcd1234-ef', '2026-07-10T01:00:00.000Z'),
        '260710-0800-abcd1234.md'
      );
    });

    it('falls back to bare <id8>.md when no timestamp is usable', () => {
      assert.strictEqual(buildSessionFilename(null, 'abcd1234-ef'), 'abcd1234.md');
    });

    it('sanitizes an unsafe session id before truncating to 8 chars', () => {
      // '/' is stripped by sanitizeSegment; first 8 chars of 'ab/cd123...' → 'ab-cd123'
      assert.strictEqual(
        buildSessionFilename('2026-07-10T01:00:00.000Z', 'ab/cd1234xyz'),
        '260710-0800-ab-cd123.md'
      );
    });
  });
});
