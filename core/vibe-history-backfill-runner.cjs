#!/usr/bin/env node
'use strict';

/**
 * vibe-history-backfill-runner.cjs
 *
 * Core, testable logic for the one-time backfill CLI
 * (vibe-history-backfill.cjs). Converts pre-existing (pre-hook) Claude Code
 * session transcripts under `~/.claude/projects/` into the same
 * `vibe-history/<project>/YYMMDD-HHMM-<id8>.md` digests the live SessionEnd/
 * PreCompact hook already produces going forward.
 *
 * Exports: discoverSessionFiles, extractCwdFromTranscript, runBackfill.
 *
 * @module vibe-history-backfill-runner
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseDigest, renderDigest, readExistingFrontmatter } = require('./vibe-history-markdown-builder.cjs');
const { deriveProjectName, sanitizeSegment, buildSessionFilename } = require('./vibe-history-project-utils.cjs');

/**
 * Discover all top-level session transcript files under a Claude Code
 * `projects` root. Non-recursive per-project-dir scan: subagent files live
 * one directory deeper (`<sessionId>/subagents/*.jsonl`) and are naturally
 * never seen by this scan — no exclusion filter needed beyond "don't
 * recurse" + "only .jsonl files".
 * @param {string} projectsRoot - e.g. `~/.claude/projects`
 * @returns {Array<{projectDirName: string, sessionId: string, transcriptPath: string, sizeBytes: number}>}
 */
function discoverSessionFiles(projectsRoot) {
  const results = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch (_) {
    return results; // projectsRoot missing/unreadable — nothing to discover
  }

  for (const dirent of projectDirs) {
    const projectDirName = dirent.name;
    const fullDir = path.join(projectsRoot, projectDirName);
    let entries;
    try {
      entries = fs.readdirSync(fullDir, { withFileTypes: true });
    } catch (_) {
      continue; // permissions/race — skip this project dir
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const transcriptPath = path.join(fullDir, e.name);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(transcriptPath).size;
      } catch (_) {
        continue; // file vanished between readdir and stat — skip
      }
      results.push({
        projectDirName,
        sessionId: e.name.replace(/\.jsonl$/, ''),
        transcriptPath,
        sizeBytes
      });
    }
  }
  return results;
}

/**
 * Stream a transcript file line-by-line looking for the first line whose
 * parsed JSON carries a non-empty string `cwd` field. Stops reading as soon
 * as a match is found (closes the stream early). Bounded by `maxLines` as a
 * safety valve against a pathological file that never has `cwd` — avoids a
 * full multi-MB read for nothing. Never throws on malformed JSON lines
 * (skipped, scanning continues).
 * @param {string} transcriptPath
 * @param {Object} [opts]
 * @param {number} [opts.maxLines=500] - scan cap
 * @returns {Promise<string|null>} the cwd value, or null if none found within the cap
 */
function extractCwdFromTranscript(transcriptPath, opts = {}) {
  const { maxLines = 500 } = opts;
  return new Promise((resolve) => {
    let linesRead = 0;
    let settled = false;
    let rl;
    let stream;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { rl && rl.close(); } catch (_) { /* ignore */ }
      try { stream && stream.destroy(); } catch (_) { /* ignore */ }
      resolve(value);
    };

    try {
      stream = fs.createReadStream(transcriptPath);
    } catch (_) {
      resolve(null);
      return;
    }
    stream.on('error', () => finish(null));

    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (settled) return;
      linesRead++;
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry.cwd === 'string' && entry.cwd) {
            finish(entry.cwd);
            return;
          }
        } catch (_) {
          // malformed JSON line — skip, keep scanning
        }
      }
      if (linesRead >= maxLines) finish(null);
    });

    rl.on('close', () => finish(null));
    rl.on('error', () => finish(null));
  });
}

/**
 * Convert every discovered session transcript into a `vibe-history`
 * Markdown digest, in-process (no subprocess spawn per file). Per-file
 * errors are isolated (caught, recorded, skipped) so one bad transcript
 * never aborts the batch. Idempotent by construction — every write is a
 * deterministic full regenerate from the same source transcript, matching
 * the live hook's "not multiple snapshots" design.
 * @param {Object} options
 * @param {string} options.projectsRoot - e.g. `~/.claude/projects`
 * @param {string} options.outputRoot - e.g. VIBE_HISTORY_ROOT
 * @param {(i: number, total: number, file: Object) => void} [options.onProgress]
 * @returns {Promise<{total: number, succeeded: number, skipped: Array<{transcriptPath: string, reason: string}>}>}
 */
async function runBackfill({ projectsRoot, outputRoot, onProgress = () => {} }) {
  const files = discoverSessionFiles(projectsRoot);
  const skipped = [];
  let succeeded = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress(i + 1, files.length, f);
    try {
      const cwd = await extractCwdFromTranscript(f.transcriptPath);
      if (!cwd) {
        skipped.push({ transcriptPath: f.transcriptPath, reason: 'no-cwd-found' });
        continue;
      }

      const projectName = deriveProjectName(cwd);
      // Sanitized only for the path segment — defense-in-depth against a
      // historical `cwd` value whose path.basename fallback resolves to a
      // traversal-shaped literal (e.g. "..", if `cwd` ended in `/..`). The
      // RAW projectName is still used in the markdown header metadata below.
      const destDir = path.join(outputRoot, sanitizeSegment(projectName, 'unknown-project'));
      fs.mkdirSync(destDir, { recursive: true });

      // Use the transcript's own mtime (≈ last activity in that session) as
      // `generatedAt` rather than "now" — avoids misleadingly stamping a
      // historical session with today's date in its header. This makes
      // output deterministic ONLY while the source transcript is unmodified
      // between runs — not an inherent guarantee if Claude Code ever
      // reopens/appends to an old transcript (e.g. via --resume) later.
      const mtime = fs.statSync(f.transcriptPath).mtime.toISOString();
      const digestMeta = {
        sessionId: f.sessionId,
        hookEvent: 'Backfill',
        reasonOrTrigger: 'historical-import',
        projectName,
        cwd,
        generatedAt: mtime
      };
      // Same two-phase flow + date-based filename as the live hook, so backfill
      // and live capture produce identical filenames for the same session.
      const { turns, extracted } = await parseDigest(f.transcriptPath);
      const destPath = path.join(destDir, buildSessionFilename(extracted.firstTs, f.sessionId, mtime));
      const preserved = readExistingFrontmatter(destPath);
      const markdown = renderDigest(turns, extracted, digestMeta, preserved);
      fs.writeFileSync(destPath, markdown, 'utf-8');
      succeeded++;
    } catch (error) {
      skipped.push({ transcriptPath: f.transcriptPath, reason: error.message || String(error) });
    }
  }

  return { total: files.length, succeeded, skipped };
}

module.exports = { discoverSessionFiles, extractCwdFromTranscript, runBackfill };
