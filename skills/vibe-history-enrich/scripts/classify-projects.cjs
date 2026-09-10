#!/usr/bin/env node
'use strict';

/**
 * Feature E — deterministic per-project tiering for vibe-history folders.
 *
 * Groups session .md files by top-level project folder and derives a cheap tier
 * (REAL / GRAY / THROWAWAY) from session count + active-day span + message
 * volume. Deterministic pre-pass; an LLM later refines each folder into one of
 * 4 labels using the type/summary signals emitted here.
 *
 * Output (stdout): {generated, root, folder_count, tier_counts, folders:[...]}
 * where each folder carries: name, sessions, span_days, first_date, last_date,
 * total_messages, types (histogram), sample_titles, tier.
 *
 * Flags: --root PATH
 */

const fs = require('fs');
const path = require('path');
const { defaultHistoryRoot } = require('./_config.cjs');

const SKIP_TOP = new Set(['docs', 'plans']);
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/;
const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/** Top-level scalar frontmatter; falls back to counting user turns if no `messages`. */
function scalars(file) {
  const text = fs.readFileSync(file, 'utf8');
  const fm = {};
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of text.slice(4, end).split('\n')) {
        if (line[0] === ' ' || line[0] === '\t') continue;
        const m = KEY_RE.exec(line);
        if (m) fm[m[1]] = m[2].trim().replace(/^"|"$/g, '');
      }
    }
  }
  if (!('messages' in fm)) fm._user_turns = (text.match(/\n### User/g) || []).length;
  return fm;
}

// Deterministic depth-first walk (entries sorted by name) so sample_titles and
// any order-dependent output are reproducible across platforms and runs.
function* walk(root, dir = root) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    const top = rel.split(path.sep)[0];
    if (e.isDirectory()) {
      if (SKIP_TOP.has(top) || top.startsWith('.')) continue;
      yield* walk(root, full);
    } else if (e.name.endsWith('.md')) {
      yield { file: full, top };
    }
  }
}

function collect(root) {
  const folders = {};
  for (const { file, top } of walk(root)) {
    const fm = scalars(file);
    const name = fm.project || top;
    const f = folders[name] || (folders[name] = { name, sessions: 0, dates: [], total_messages: 0, types: {}, sample_titles: [] });
    f.sessions += 1;
    const dm = DATE_RE.exec(path.basename(file));
    const d = fm.date || (dm ? dm[1] : '');
    if (d) f.dates.push(d);
    const msgs = parseInt(fm.messages || fm._user_turns || 0, 10);
    if (!Number.isNaN(msgs)) f.total_messages += msgs;
    const t = fm.type || '';
    if (t) f.types[t] = (f.types[t] || 0) + 1;
    const title = fm.title || '';
    if (title && f.sample_titles.length < 5) f.sample_titles.push(title);
  }
  return folders;
}

function spanDays(dates) {
  const ds = [...new Set(dates)].sort();
  if (ds.length < 2) return 0;
  const a = new Date(ds[0]), b = new Date(ds[ds.length - 1]);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000);
}

function tier(sessions, span, msgs) {
  if (sessions >= 3 || span >= 3) return 'REAL';
  if (sessions === 1 && span === 0 && msgs <= 6) return 'THROWAWAY';
  return 'GRAY';
}

function main() {
  let root = defaultHistoryRoot();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--root') root = argv[++i];

  const folders = collect(root);
  const out = Object.values(folders).map((f) => {
    const ds = [...new Set(f.dates)].sort();
    const sp = spanDays(f.dates);
    return {
      name: f.name, sessions: f.sessions, span_days: sp,
      first_date: ds[0] || '', last_date: ds[ds.length - 1] || '',
      total_messages: f.total_messages, types: f.types,
      sample_titles: f.sample_titles,
      tier: tier(f.sessions, sp, f.total_messages),
    };
  });
  out.sort((a, b) => (b.sessions - a.sessions) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const counts = { REAL: 0, GRAY: 0, THROWAWAY: 0 };
  for (const x of out) counts[x.tier]++;

  process.stdout.write(JSON.stringify({
    generated: new Date().toISOString().replace(/\.\d+Z$/, ''),
    root, folder_count: out.length, tier_counts: counts, folders: out,
  }, null, 2) + '\n');
  process.stderr.write(`[classify] folders=${out.length} tiers=${JSON.stringify(counts)}\n`);
}

main();
