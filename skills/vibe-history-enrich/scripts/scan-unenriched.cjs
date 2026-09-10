#!/usr/bin/env node
'use strict';

/**
 * Scan vibe-history for session .md files that still need semantic enrich.
 *
 * A file counts as ENRICHED only when its frontmatter carries `enriched: true`.
 * Everything else — new-schema stubs (`enriched: false`) AND legacy files (no
 * `enriched` key) — is reported as to-enrich, because the full-transcript pass
 * supersedes any shallow one.
 *
 * Output (stdout): one JSON object per line (JSONL), sorted by path:
 *   {"path","uuid","project","lines","schema","reason"}
 * Files WITHOUT frontmatter go to stderr as a warning (backfill them first).
 *
 * Flags:
 *   --project NAME      only this top-level project folder (repeatable)
 *   --limit N           cap number of to-enrich rows
 *   --include-enriched  also list files already enriched:true (for re-runs)
 *   --root PATH         override capture root (default: $VIBE_HISTORY_ROOT or ~/Documents/vibe-history)
 */

const fs = require('fs');
const path = require('path');
const { defaultHistoryRoot } = require('./_config.cjs');

const SKIP_TOP = new Set(['docs', 'plans']);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/;

/** Parse argv into { project:[], limit, includeEnriched, root }. */
function parseArgs(argv) {
  const out = { project: [], limit: 0, includeEnriched: false, root: defaultHistoryRoot() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project.push(argv[++i]);
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--include-enriched') out.includeEnriched = true;
    else if (a === '--root') out.root = argv[++i];
  }
  return out;
}

/** Top-level scalar frontmatter keys + has_fm + line count. */
function readFrontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const nLines = (text.match(/\n/g) || []).length + 1;
  if (!text.startsWith('---')) return { fm: {}, hasFm: false, nLines };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, hasFm: false, nLines };
  const block = text.slice(4, end);
  const fm = {};
  for (const line of block.split('\n')) {
    if (line[0] === ' ' || line[0] === '\t') continue; // list continuation
    const m = KEY_RE.exec(line);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, hasFm: true, nLines };
}

const isEnriched = (fm) => (fm.enriched || '').trim().toLowerCase() === 'true';
const schemaOf = (fm) => ('keywords' in fm ? 'new' : ('topics' in fm ? 'legacy' : 'bare'));

/** Walk the store, skipping docs/plans/dot dirs, honoring --project. */
function* iterFiles(root, projects) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      const top = rel.split(path.sep)[0];
      if (e.isDirectory()) {
        if (SKIP_TOP.has(top) || top.startsWith('.')) continue;
        if (projects.size && !projects.has(top)) continue;
        stack.push(full);
      } else if (e.name.endsWith('.md')) {
        if (projects.size && !projects.has(top)) continue;
        yield full;
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projects = new Set(args.project.filter(Boolean));
  const rows = [];
  const noFm = [];
  let already = 0;

  for (const file of iterFiles(args.root, projects)) {
    const { fm, hasFm, nLines } = readFrontmatter(file);
    const rel = path.relative(args.root, file);
    if (!hasFm) { noFm.push(rel); continue; }
    const enriched = isEnriched(fm);
    if (enriched && !args.includeEnriched) { already++; continue; }
    const uuidInPath = UUID_RE.exec(file);
    rows.push({
      path: rel,
      uuid: fm.session_id || (uuidInPath ? uuidInPath[0] : ''),
      project: (fm.project || '').replace(/^"|"$/g, '') || rel.split(path.sep)[0],
      lines: nLines,
      schema: schemaOf(fm),
      reason: enriched ? 'enriched' : (schemaOf(fm) === 'new' ? 'stub' : 'legacy-shallow'),
    });
  }

  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const emit = args.limit > 0 ? rows.slice(0, args.limit) : rows;
  for (const r of emit) process.stdout.write(JSON.stringify(r) + '\n');

  process.stderr.write(`[scan] to_enrich=${emit.length} already_enriched=${already} no_frontmatter=${noFm.length}\n`);
  for (const p of noFm) process.stderr.write(`[scan][no-frontmatter] ${p}\n`);
}

main();
