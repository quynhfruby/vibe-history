#!/usr/bin/env node
'use strict';

/**
 * antigravity-vibe-history-capture.cjs
 *
 * Antigravity counterpart to vibe-history-capture.cjs / codex-vibe-history-
 * capture.cjs. Reads an Antigravity `transcript.jsonl` (see
 * vibe-history-antigravity-parser.cjs) and converts it to the SAME filtered
 * Markdown digest (reusing renderDigest + project-utils + frontmatter-
 * preserve) — one file per conversation in the shared store,
 * `vibe-history/<project>/YYMMDD-HHMM-<id8>.md`, fully regenerated and
 * overwritten on every firing (stable filename per session, so re-firing on
 * every Stop event is harmless — same idempotent-overwrite design as the
 * Claude/Codex captures).
 *
 * Invoked via the `Stop` hook, through antigravity-vibe-history-notify.cjs
 * (reads the hook payload's transcriptPath + workspacePaths and passes them
 * here). Can also be run directly with no path args — it then auto-resolves
 * the newest-mtime transcript.jsonl under ~/.gemini/antigravity/brain/*, and
 * cwd falls back to process.cwd() (the invoking shell's directory, i.e. the
 * project root).
 *
 * argv: [transcriptPath|'', cwd|'', reason]
 *
 * Never blocks Antigravity, never throws uncaught, ALWAYS exits 0 (fail-open).
 */

try {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { isEnabled } = require('../core/vibe-history-config.cjs');
  const { renderDigest, readExistingFrontmatter } = require('../core/vibe-history-markdown-builder.cjs');
  const { parseAntigravityTranscript } = require('../core/vibe-history-antigravity-parser.cjs');
  const {
    VIBE_HISTORY_ROOT, deriveProjectName, sanitizeSegment, buildSessionFilename
  } = require('../core/vibe-history-project-utils.cjs');

  // Early exit if capture disabled via config.json (`enabled: false`) or
  // $VIBE_HISTORY_ENABLED=false. Defaults to enabled. See vibe-history-config.cjs.
  if (!isEnabled()) {
    process.exit(0);
  }

  const BRAIN_ROOT = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

  /** Newest-mtime transcript.jsonl under ~/.gemini/antigravity/brain/*\/.system_generated/logs/. */
  function findNewestTranscript(root) {
    let best = null;
    let bestM = -1;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = path.join(root, e.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const m = fs.statSync(candidate).mtimeMs;
        if (m > bestM) { bestM = m; best = candidate; }
      } catch (_) { /* no transcript for this conversation yet */ }
    }
    return best;
  }

  async function main() {
    const explicitPath = process.argv[2] && process.argv[2].trim() ? process.argv[2].trim() : null;
    const explicitCwd = process.argv[3] && process.argv[3].trim() ? process.argv[3].trim() : null;
    const reason = process.argv[4] && process.argv[4].trim() ? process.argv[4].trim() : 'antigravity-stop';
    const transcriptPath = explicitPath || findNewestTranscript(BRAIN_ROOT);

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.exit(0);
      return;
    }

    const { turns, extracted, sessionId } = await parseAntigravityTranscript(transcriptPath, explicitCwd);

    // Nothing worth writing (empty/early session) — skip silently.
    if (!turns.length && extracted.userMessageCount === 0) {
      process.exit(0);
      return;
    }

    const cwd = extracted.cwd || explicitCwd || process.cwd();
    const sid = sessionId || 'antigravity-unknown';
    const projectName = deriveProjectName(cwd);
    const projectNameSlug = sanitizeSegment(projectName, 'unknown-project');
    const destDir = path.join(VIBE_HISTORY_ROOT, projectNameSlug);
    fs.mkdirSync(destDir, { recursive: true });

    const generatedAt = new Date().toISOString();
    const filename = buildSessionFilename(extracted.firstTs, sid, generatedAt);
    const destPath = path.join(destDir, filename);
    const preserved = readExistingFrontmatter(destPath);

    const digestMeta = {
      sessionId: sid,
      hookEvent: 'AntigravityCapture',
      reasonOrTrigger: reason,
      projectName,
      cwd,
      generatedAt,
      source: 'antigravity'
    };
    const markdown = renderDigest(turns, extracted, digestMeta, preserved);
    fs.writeFileSync(destPath, markdown, 'utf-8');

    process.exit(0);
  }

  main().catch(() => process.exit(0));
} catch (_) {
  process.exit(0); // fail-open — never disrupt Antigravity
}
