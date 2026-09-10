#!/usr/bin/env node
'use strict';

/**
 * vibe-history-backfill.cjs
 *
 * One-time, manual CLI: converts ALL pre-hook session transcripts under
 * `~/.claude/projects/` into the same `vibe-history/<project>/<session_id>.md`
 * format the live SessionEnd/PreCompact hook (vibe-history-capture.cjs)
 * already produces going forward. Reuses buildMarkdownDigest in-process (no
 * subprocess spawn per file) via lib/vibe-history-backfill-runner.cjs.
 *
 * Not a hook, not scheduled — run manually: `node vibe-history-backfill.cjs`.
 * Safe to re-run any time (every write is a deterministic full regenerate,
 * same idempotency guarantee as the live hook).
 *
 * Unlike the live hook, this is a human-run tool with no session lifecycle
 * to protect — per-file errors are still isolated (one bad transcript must
 * never abort the whole batch), but a genuine top-level bug is allowed to
 * throw/exit non-zero since a human is watching the output.
 */

const os = require('os');
const path = require('path');
const { VIBE_HISTORY_ROOT } = require('../core/vibe-history-project-utils.cjs');
const { runBackfill } = require('../core/vibe-history-backfill-runner.cjs');

// Portable — this is Claude Code's own standard transcripts location
// (unlike VIBE_HISTORY_ROOT, which stays hardcoded per the live hook's
// existing single-machine design).
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

async function main() {
  const startedAt = Date.now();
  const result = await runBackfill({
    projectsRoot: PROJECTS_ROOT,
    outputRoot: VIBE_HISTORY_ROOT,
    onProgress: (i, total, f) => {
      console.log(`[${i}/${total}] ${f.projectDirName}/${f.sessionId} (${(f.sizeBytes / 1024).toFixed(0)}KB)`);
    }
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\nDone in ${elapsedSec}s — ${result.succeeded}/${result.total} succeeded, ${result.skipped.length} skipped`);
  if (result.skipped.length) {
    console.log('Skipped:');
    for (const s of result.skipped) console.log(`  ${s.transcriptPath}: ${s.reason}`);
  }
}

main().catch((error) => {
  console.error('Fatal error during backfill run:', error);
  process.exit(1);
});
