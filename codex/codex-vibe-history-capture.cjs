#!/usr/bin/env node
'use strict';

/**
 * codex-vibe-history-capture.cjs
 *
 * Codex-CLI counterpart to vibe-history-capture.cjs. Reads a Codex "rollout"
 * transcript, converts it to the SAME filtered Markdown digest (reusing
 * renderDigest + project-utils + frontmatter-preserve) and writes ONE file per
 * session into the shared store — `vibe-history/<project>/YYMMDD-HHMM-<id8>.md`
 * — fully regenerated + overwritten on every firing (stable filename per
 * session, so Codex + Claude sessions coexist in the same store, and any
 * enrich-added semantic frontmatter is preserved across re-capture).
 *
 * Invoked via config.toml `notify` (codex-vibe-history-notify.cjs) after each
 * turn.
 *
 * Rollout resolution: takes an explicit path as argv[2] when given, else finds
 * the newest-mtime `rollout-*.jsonl` under ~/.codex/sessions (the file Codex is
 * actively appending is the just-written one right after a turn ends).
 *
 * Never blocks Codex, never throws uncaught, ALWAYS exits 0 (fail-open).
 */

try {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { isEnabled } = require('../core/vibe-history-config.cjs');
  const { renderDigest, readExistingFrontmatter } = require('../core/vibe-history-markdown-builder.cjs');
  const { parseCodexRollout } = require('../core/vibe-history-codex-parser.cjs');
  const {
    VIBE_HISTORY_ROOT, deriveProjectName, sanitizeSegment, buildSessionFilename
  } = require('../core/vibe-history-project-utils.cjs');

  // Early exit if capture disabled via config.json (`enabled: false`) or
  // $VIBE_HISTORY_ENABLED=false. Defaults to enabled. See vibe-history-config.cjs.
  if (!isEnabled()) {
    process.exit(0);
  }

  const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

  /**
   * Newest-mtime rollout file under ~/.codex/sessions/**. Shallow-recursive
   * over the YYYY/MM/DD layout; returns null if none found.
   */
  function findNewestRollout(root) {
    let best = null;
    let bestM = -1;
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
          try {
            const m = fs.statSync(full).mtimeMs;
            if (m > bestM) { bestM = m; best = full; }
          } catch (_) { /* skip unreadable */ }
        }
      }
    };
    walk(root);
    return best;
  }

  async function main() {
    // Optional explicit rollout path (used by /done); else newest session.
    const explicit = process.argv[2] && process.argv[2].trim() ? process.argv[2].trim() : null;
    const reason = process.argv[3] && process.argv[3].trim() ? process.argv[3].trim() : 'codex-notify';
    const rolloutPath = explicit || findNewestRollout(CODEX_SESSIONS_ROOT);

    if (!rolloutPath || !fs.existsSync(rolloutPath)) {
      process.exit(0);
      return;
    }

    const { turns, extracted, sessionId } = await parseCodexRollout(rolloutPath);

    // Nothing worth writing (empty/early session) — skip silently.
    if (!turns.length && extracted.userMessageCount === 0) {
      process.exit(0);
      return;
    }

    const cwd = extracted.cwd || process.cwd();
    const sid = sessionId || 'codex-unknown';
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
      hookEvent: 'CodexCapture',
      reasonOrTrigger: reason,
      projectName,
      cwd,
      generatedAt,
      source: 'codex'
    };
    const markdown = renderDigest(turns, extracted, digestMeta, preserved);
    fs.writeFileSync(destPath, markdown, 'utf-8');

    process.exit(0);
  }

  main().catch(() => process.exit(0));
} catch (_) {
  process.exit(0); // fail-open — never disrupt Codex
}
