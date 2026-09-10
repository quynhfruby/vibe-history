#!/usr/bin/env node
'use strict';

/**
 * vibe-history-project-utils.cjs
 *
 * Shared project-naming utilities extracted from vibe-history-capture.cjs
 * (DRY fix — see plans/260704-2211-backfill-existing-sessions/phase-01-*.md).
 * Used by both the live SessionEnd/PreCompact hook and the one-time backfill
 * CLI so the two never drift on project-name/segment-sanitization logic.
 *
 * Verbatim extraction — no behavior change from the original inline code.
 *
 * @module vibe-history-project-utils
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { getHistoryRoot, getTimezone } = require('./vibe-history-config.cjs');

// Capture store root, resolved from $VIBE_HISTORY_ROOT / config.json / default
// (see vibe-history-config.cjs). Evaluated once at load — each capture runs in a
// fresh process, so a config/env change is always picked up on the next firing.
const VIBE_HISTORY_ROOT = getHistoryRoot();

/**
 * Derive a human-readable project name from the session's cwd.
 *
 * Uses the git **common dir** (`--git-common-dir`), not `--show-toplevel`, so a
 * session run inside a linked git WORKTREE is attributed to the main project
 * rather than the throwaway worktree folder. Example: a linked worktree at
 * `.../my-project/<worktree-name>` belongs to the repo checked out at
 * `.../my-project`; its common dir is `.../my-project/.git`, so the project is
 * `my-project` (not `<worktree-name>`). For a normal (non-worktree) repo this
 * yields the same name as the toplevel basename, so existing captures are
 * unaffected.
 *
 * Explicitly does NOT rely on process.cwd() — the hook process's own cwd is not
 * guaranteed to equal the session's cwd from the payload.
 * @param {string} cwd - Session cwd from the hook payload
 * @returns {string} Project name (main-worktree/repo basename, or cwd basename)
 */
function deriveProjectName(cwd) {
  // Empty/missing cwd: return the fallback directly. Never run `git -C ''`, which
  // would inspect the capture PROCESS's own cwd (meaningless here) and yield a
  // misleading project name when that happens to sit inside a git repo.
  if (!cwd || !String(cwd).trim()) return 'unknown-project';
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (commonDir) {
      // commonDir is the MAIN worktree's git dir, e.g. `/…/project/.git`
      // (or a bare repo dir). The project folder is its parent when it ends in
      // `.git`, else the dir itself.
      const dir = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
      const name = path.basename(dir);
      if (name && name !== '.') return name;
    }
  } catch (_) {
    // Not a git repo, git not installed, or cwd missing — fall through.
  }
  return path.basename(cwd || 'unknown-project');
}

/**
 * Sanitize a value for safe use as a single filename path segment. Strips
 * path-separator/reserved characters AND rejects bare "." / ".." (which
 * contain no such characters but are still traversal-shaped once passed to
 * `path.join` — e.g. a historical `cwd` of `/foo/bar/..` makes
 * `deriveProjectName` return the literal string ".." via `path.basename`).
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeSegment(value, fallback) {
  const str = (value || fallback || 'unknown').toString();
  const cleaned = str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback || 'unknown';
  return cleaned;
}

// Timezone for date/time stamping in filenames + frontmatter, resolved from
// $VIBE_HISTORY_TZ / config.json / the machine's local timezone (see
// vibe-history-config.cjs). Evaluated once at load — a fresh process per capture.
const CAPTURE_TIMEZONE = getTimezone();

/**
 * Convert an ISO timestamp to broken-down parts in CAPTURE_TIMEZONE via Intl
 * (robust cross-platform TZ conversion — no dependency on the host's local TZ).
 * @param {string} iso - ISO-8601 timestamp (e.g. `2026-07-10T05:50:29.002Z`)
 * @returns {{year,month,day,hour,minute}|null} 2-4 digit string parts, or null if unparseable
 */
function localTimeParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAPTURE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  if (!p.year) return null;
  // Some engines emit '24' for midnight under hour12:false — normalize to '00'.
  if (p.hour === '24') p.hour = '00';
  return p;
}

/**
 * Local date `YYYY-MM-DD` (Saigon) for frontmatter `date:`. Falls back to ''
 * when the timestamp is missing/unparseable.
 * @param {string} iso
 * @returns {string}
 */
function formatLocalDate(iso) {
  const p = localTimeParts(iso);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

/**
 * Build the capture filename `YYMMDD-HHMM-<id8>.md` (time in Saigon).
 * The timestamp is the session's FIRST message time (stable per session) so
 * re-captures overwrite the same file instead of spawning duplicates. Falls
 * back to `fallbackTs` (e.g. capture time), then to a bare `<id8>.md`.
 * @param {string} firstTs - session's first message ISO timestamp
 * @param {string} sessionId - full session id (first 8 chars used)
 * @param {string} [fallbackTs] - used when firstTs is missing/unparseable
 * @returns {string} filename ending in `.md`
 */
function buildSessionFilename(firstTs, sessionId, fallbackTs) {
  const id8 = sanitizeSegment((sessionId || 'unknown').toString().slice(0, 8), 'session');
  const p = localTimeParts(firstTs) || localTimeParts(fallbackTs);
  if (!p) return `${id8}.md`;
  const stamp = `${p.year.slice(2)}${p.month}${p.day}-${p.hour}${p.minute}`;
  return `${stamp}-${id8}.md`;
}

module.exports = {
  VIBE_HISTORY_ROOT,
  CAPTURE_TIMEZONE,
  deriveProjectName,
  sanitizeSegment,
  localTimeParts,
  formatLocalDate,
  buildSessionFilename
};
