#!/usr/bin/env node
/**
 * vibe-history-capture.cjs
 *
 * SessionEnd / PreCompact hook entry point.
 * Reads the session's JSONL transcript, converts it to a filtered Markdown
 * digest (via lib/vibe-history-markdown-builder.cjs) with YAML frontmatter, and
 * writes ONE file per session — `vibe-history/<project>/YYMMDD-HHMM-<id8>.md`
 * (date/time from the session's FIRST message, Saigon-local, so the name is
 * stable per session) — fully regenerated and overwritten on every firing.
 * Deliberately NOT multiple timestamped snapshots: each firing re-parses the
 * WHOLE transcript from the start, so keeping every past snapshot would just
 * accumulate files whose content is a strict subset of the next one (superseded
 * design; single always-current file avoids that redundancy entirely). Semantic
 * frontmatter fields already present in the file are PRESERVED across re-capture
 * (readExistingFrontmatter) so a separate enrich step is never clobbered.
 * Never blocks the session, never throws uncaught, always exits 0.
 *
 * NOTE: intentionally no secret-scrubbing here. Locked decision from the
 * original planning conversation — this is a local-only capture directory,
 * scrubbing was explicitly not wanted. Not an oversight; don't "fix" it.
 *
 * Exit Codes:
 *   0 - Always (fail-open; a bug here must never disrupt /clear, /exit, /compact)
 */

// Crash wrapper — mirrors dev-rules-reminder.cjs's double try/catch so even a
// `require()` failure (e.g. a syntax error introduced in the builder module)
// can never surface to the user or block their session lifecycle event.
try {
  const fs = require('fs');
  const path = require('path');
  const { createHookTimer, logHookCrash } = require('../core/hook-logger.cjs');
  const { isEnabled } = require('../core/vibe-history-config.cjs');
  const { parseDigest, renderDigest, readExistingFrontmatter } = require('../core/vibe-history-markdown-builder.cjs');
  const { VIBE_HISTORY_ROOT, deriveProjectName, sanitizeSegment, buildSessionFilename } = require('../core/vibe-history-project-utils.cjs');

  // Early exit if capture disabled via config.json (`enabled: false`) or
  // $VIBE_HISTORY_ENABLED=false. Defaults to enabled. See vibe-history-config.cjs.
  if (!isEnabled()) {
    process.exit(0);
  }

  async function main() {
    const timer = createHookTimer('vibe-history-capture', {});
    let payload;

    try {
      const stdin = fs.readFileSync(0, 'utf-8').trim();
      if (!stdin) {
        timer.end({ status: 'skip', exit: 0, note: 'empty-stdin' });
        process.exit(0);
      }
      payload = JSON.parse(stdin);
    } catch (error) {
      logHookCrash('vibe-history-capture', error, { note: 'stdin-parse-failed' });
      timer.end({ status: 'crash', exit: 0, note: 'stdin-parse-failed' });
      process.exit(0);
      return;
    }

    const sessionId = payload.session_id || payload.sessionId || 'unknown-session';
    const transcriptPath = payload.transcript_path || payload.transcriptPath || null;
    const cwd = payload.cwd || process.cwd();
    const hookEvent = payload.hook_event_name || payload.hookEventName || 'UnknownEvent';
    const reasonOrTrigger = payload.reason || payload.trigger || 'unknown';

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      logHookCrash('vibe-history-capture', new Error('transcript_path missing or file does not exist'), {
        event: hookEvent, note: 'no-transcript', target: transcriptPath || ''
      });
      timer.end({ status: 'skip', exit: 0, event: hookEvent, note: 'no-transcript' });
      process.exit(0);
      return;
    }

    try {
      const projectName = deriveProjectName(cwd);
      // The derived projectName is sanitized before use as a path segment —
      // defense-in-depth against a malformed/unexpected value producing a
      // path-traversal-shaped segment (e.g. `cwd` ending in `/..`, which makes
      // deriveProjectName's path.basename fallback return the literal string
      // ".."). The RAW projectName is still used in the header/frontmatter
      // metadata — only the path segment is sanitized. The filename's id8 is
      // sanitized inside buildSessionFilename.
      const projectNameSlug = sanitizeSegment(projectName, 'unknown-project');
      const destDir = path.join(VIBE_HISTORY_ROOT, projectNameSlug);
      fs.mkdirSync(destDir, { recursive: true });

      const generatedAt = new Date().toISOString();
      const digestMeta = { sessionId, hookEvent, reasonOrTrigger, projectName, cwd, generatedAt, source: 'claude' };

      // Phase 1: parse first — the filename needs the session's first message
      // time. Phase 5: `YYMMDD-HHMM-<id8>.md` (Saigon-local, stable per session
      // so re-captures overwrite in place, not duplicate). Phase 2: preserve
      // any prior semantic enrichment before regenerating the file in full.
      const { turns, extracted } = await parseDigest(transcriptPath);
      const filename = buildSessionFilename(extracted.firstTs, sessionId, generatedAt);
      const destPath = path.join(destDir, filename);
      const preserved = readExistingFrontmatter(destPath);
      const markdown = renderDigest(turns, extracted, digestMeta, preserved);

      fs.writeFileSync(destPath, markdown, 'utf-8');

      timer.end({ status: 'ok', exit: 0, event: hookEvent, target: destPath });
      process.exit(0);
    } catch (error) {
      logHookCrash('vibe-history-capture', error, { event: hookEvent, target: sessionId });
      timer.end({ status: 'crash', exit: 0, event: hookEvent });
      process.exit(0);
    }
  }

  main().catch((error) => {
    try {
      logHookCrash('vibe-history-capture', error, { note: 'unhandled-main-rejection' });
    } catch (_) { /* never let logging failure escape */ }
    process.exit(0);
  });
} catch (e) {
  try {
    const { logHookCrash } = require('../core/hook-logger.cjs');
    logHookCrash('vibe-history-capture', e, { note: 'top-level-require-failure' });
  } catch (_) { /* logger itself unavailable — still fail open */ }
  process.exit(0); // fail-open
}
