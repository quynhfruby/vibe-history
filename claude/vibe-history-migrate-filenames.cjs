#!/usr/bin/env node
'use strict';

/**
 * vibe-history-migrate-filenames.cjs
 *
 * One-time migration: rename existing capture files from the old
 * `<session_id>.md` scheme to the new `YYMMDD-HHMM-<id8>.md` scheme (Saigon
 * local time), matching what the live hook + backfill now produce.
 *
 * Content is NOT modified — only the filename. Idempotent (files already in the
 * new format are skipped) and safe (never overwrites a different existing file).
 *
 * Usage:
 *   node vibe-history-migrate-filenames.cjs --dry   # preview, no changes
 *   node vibe-history-migrate-filenames.cjs         # perform the rename
 */

const fs = require('fs');
const path = require('path');
const { VIBE_HISTORY_ROOT, buildSessionFilename } = require('../core/vibe-history-project-utils.cjs');

const DRY = process.argv.includes('--dry');

// A filename already in the new scheme: YYMMDD-HHMM-<id8>.md
const NEW_FORMAT_RE = /^\d{6}-\d{4}-.+\.md$/;
const HEADER_ID_RE = /^# Session\s+(\S+)\s+—/m;
const FM_SESSION_ID_RE = /^session_id:\s*(.+)$/m;
const HEADER_GENERATED_RE = /·\s*generated:\s*([0-9T:.\-Z+]+)/;
const FIRST_TURN_TS_RE = /^###\s+(?:User|Assistant)\s+—\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)/m;

/**
 * Extract session id + a usable first-message timestamp from an existing digest.
 * @param {string} content - file content
 * @param {string} filenameStem - basename without `.md` (last-resort id)
 * @returns {{sessionId: string, firstTs: string|null, fallbackTs: string|null}}
 */
function extractIdentity(content, filenameStem) {
  // The `# Session <id>` header is present in EVERY digest and always the true
  // session id — prefer it. Only then fall back to `session_id:` scoped to the
  // leading frontmatter block (never the body — a `/m` match on the whole file
  // can hit a `session_id:` line inside the captured conversation text).
  const hdr = content.match(HEADER_ID_RE);
  let fmId = null;
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      const m = content.slice(0, end).match(FM_SESSION_ID_RE);
      if (m) fmId = m[1].trim();
    }
  }
  const sessionId = (hdr && hdr[1].trim()) || fmId || filenameStem;

  const firstTurn = content.match(FIRST_TURN_TS_RE);
  const generated = content.match(HEADER_GENERATED_RE);
  return {
    sessionId,
    firstTs: firstTurn ? firstTurn[1] : null,
    fallbackTs: generated ? generated[1] : null
  };
}

function main() {
  let renamed = 0, skippedNew = 0, skippedConflict = 0, errors = 0;
  const plan = [];

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(VIBE_HISTORY_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  } catch (e) {
    console.error(`Cannot read VIBE_HISTORY_ROOT: ${e.message}`);
    process.exit(1);
  }

  for (const dir of projectDirs) {
    // skip the tooling dirs, not session captures
    if (dir.name === 'plans' || dir.name === 'docs') continue;
    const projectPath = path.join(VIBE_HISTORY_ROOT, dir.name);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter(f => f.endsWith('.md'));
    } catch (_) { continue; }

    for (const file of files) {
      if (NEW_FORMAT_RE.test(file)) { skippedNew++; continue; }
      const srcPath = path.join(projectPath, file);
      try {
        const content = fs.readFileSync(srcPath, 'utf8');
        const { sessionId, firstTs, fallbackTs } = extractIdentity(content, file.replace(/\.md$/, ''));
        const newName = buildSessionFilename(firstTs, sessionId, fallbackTs);
        if (newName === file) { skippedNew++; continue; }
        const destPath = path.join(projectPath, newName);
        if (fs.existsSync(destPath)) {
          console.warn(`CONFLICT (skip): ${dir.name}/${file} -> ${newName} (target exists)`);
          skippedConflict++;
          continue;
        }
        plan.push({ dir: dir.name, from: file, to: newName });
        if (!DRY) { fs.renameSync(srcPath, destPath); renamed++; }
      } catch (e) {
        console.error(`ERROR ${dir.name}/${file}: ${e.message}`);
        errors++;
      }
    }
  }

  if (DRY) {
    for (const p of plan.slice(0, 40)) console.log(`${p.dir}/${p.from}  ->  ${p.to}`);
    if (plan.length > 40) console.log(`... and ${plan.length - 40} more`);
    console.log(`\n[DRY] would rename=${plan.length} skip(new)=${skippedNew} skip(conflict)=${skippedConflict} errors=${errors}`);
  } else {
    console.log(`renamed=${renamed} skip(new)=${skippedNew} skip(conflict)=${skippedConflict} errors=${errors}`);
  }
}

main();
