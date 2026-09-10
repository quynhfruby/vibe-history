#!/usr/bin/env node
'use strict';

/**
 * vibe-history-qmd-cli.cjs
 *
 * Thin zero-dep wrapper over the `qmd` (@tobilu/qmd) CLI, scoped to the
 * vibe-history capture store. Gives session history a recall layer:
 *   index   — (re)index VIBE_HISTORY_ROOT as the `vibe-history` collection
 *   embed   — build/refresh vector embeddings (needed for vsearch/query)
 *   search  — BM25 full-text (no LLM, instant)
 *   vsearch — vector similarity (needs embed)
 *   query   — hybrid expand+rerank (recommended; needs embed)
 *   status  — qmd health + this collection's stats
 *
 * Design: no deps beyond child_process. qmd is run with QMD_RUNTIME=node
 * (the @tobilu/qmd better-sqlite3 native module crashes under Bun's NAPI —
 * forcing node avoids that). Search output is streamed straight through so
 * the caller sees qmd's native formatting.
 *
 * Usage: node vibe-history-qmd-cli.cjs <cmd> [args]
 *
 * @module vibe-history-qmd-cli
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VIBE_HISTORY_ROOT } = require('./vibe-history-project-utils.cjs');

const COLLECTION = 'vibe-history';

const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();

// Candidate qmd locations beyond PATH — global npm / homebrew / bun / local bins
// so the wrapper works even when the caller's PATH is minimal (e.g. a hook
// subprocess). Platform-specific: unix bins on macOS/Linux, npm/.cmd on Windows.
const QMD_CANDIDATES = IS_WIN
  ? [
      path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'qmd.cmd'),
      path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'qmd'),
      path.join(HOME, '.bun', 'bin', 'qmd.exe'),
    ]
  : [
      '/opt/homebrew/bin/qmd',
      '/usr/local/bin/qmd',
      path.join(HOME, '.bun/bin/qmd'),
      path.join(HOME, '.local/bin/qmd'),
      path.join(HOME, '.npm-global/bin/qmd'),
    ];

/**
 * Locate the qmd executable: PATH lookup first (`which`/`where`), then known
 * install dirs. Cross-platform.
 * @returns {string|null} absolute path to qmd, or null if not found
 */
function findQmd() {
  try {
    // `where` (Windows) may return multiple lines — take the first.
    const out = execFileSync(IS_WIN ? 'where' : 'which', ['qmd'], { encoding: 'utf8' });
    const p = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (p) return p;
  } catch (_) { /* not on PATH — fall through to candidates */ }
  for (const c of QMD_CANDIDATES) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * Run qmd inheriting stdio (so results stream to the terminal). Forces
 * QMD_RUNTIME=node. Returns the child's exit code.
 * @param {string} qmd - qmd executable path
 * @param {string[]} args
 * @returns {number} exit code
 */
function runQmd(qmd, args) {
  const res = spawnSync(qmd, args, {
    stdio: 'inherit',
    env: { ...process.env, QMD_RUNTIME: 'node' },
  });
  return res.status == null ? 1 : res.status;
}

/** Parse an optional `-n N` (result count) out of args; returns {n, rest}. */
function extractCount(args) {
  const out = [];
  let n = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' && i + 1 < args.length) { n = args[++i]; continue; }
    out.push(args[i]);
  }
  return { n, rest: out };
}

function usage() {
  process.stderr.write(
    'vibe-history search CLI (qmd wrapper)\n\n' +
    'Usage: node vibe-history-qmd-cli.cjs <command> [args]\n\n' +
    '  index            (re)index the history store (BM25 ready immediately)\n' +
    '  embed            build/refresh vector embeddings (for vsearch/query)\n' +
    '  search "<q>" [-n N]   BM25 full-text (instant, no LLM)\n' +
    '  vsearch "<q>" [-n N]  vector similarity (needs embed)\n' +
    '  query "<q>" [-n N]    hybrid expand+rerank (recommended; needs embed)\n' +
    '  status           qmd health + collection stats\n'
  );
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') { usage(); process.exit(cmd ? 0 : 2); }

  const qmd = findQmd();
  if (!qmd) {
    process.stderr.write(
      'ERROR: qmd not found. Install it with:\n  npm i -g @tobilu/qmd\n' +
      '(if a native build error appears: npm rebuild better-sqlite3 -g)\n'
    );
    process.exit(127);
  }

  switch (cmd) {
    case 'index': {
      // First run: `collection add` registers the folder. On re-index qmd
      // refuses to re-add an existing collection, so fall back to `update`
      // (re-scans registered collections: new/updated/unchanged/removed).
      const added = runQmd(qmd, ['collection', 'add', VIBE_HISTORY_ROOT, '--name', COLLECTION]);
      process.exit(added === 0 ? 0 : runQmd(qmd, ['update']));
      break;
    }
    case 'embed':
      process.exit(runQmd(qmd, ['embed', '-c', COLLECTION]));
      break;
    case 'search':
    case 'vsearch':
    case 'query': {
      const { n, rest: q } = extractCount(rest);
      if (q.length === 0) { process.stderr.write(`ERROR: ${cmd} needs a query string\n`); process.exit(2); }
      const args = [cmd, ...q];
      if (n) args.push('-n', n);
      process.exit(runQmd(qmd, args));
      break;
    }
    case 'status':
      // qmd status (index health) + collection show (this collection's config).
      runQmd(qmd, ['status']);
      process.exit(runQmd(qmd, ['collection', 'show', COLLECTION]));
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { findQmd, runQmd, extractCount, COLLECTION };
