#!/usr/bin/env node
'use strict';

/**
 * Merge subagent-authored semantic fields into an existing session .md file.
 *
 * Reads a results JSONL (one object per file, authored from the FULL transcript)
 * and, for each, rewrites ONLY the frontmatter block: sets the 8 semantic keys
 * in canonical builder order + `enriched: true`, keeps every deterministic key
 * verbatim, and leaves the conversation body byte-for-byte identical.
 *
 * Canonical semantic order (matches vibe-history-markdown-builder.cjs):
 *   title, summary, type, outcome, keywords, decisions, lessons, insights
 * `topics` (legacy) is dropped; `enriched: true` is emitted last.
 *
 * Result object schema (keyed by `path`, relative to root):
 *   {"path","uuid"?,"title","summary","type","outcome",
 *    "keywords":[...], "decisions":[...], "lessons":[...], "insights":[...]}
 *
 * Safety: uuid cross-check (if provided); the rebuilt frontmatter is
 * structurally validated (well-formed top-level keys + enriched:true); the body
 * MUST be byte-identical; every original is backed up before write. (The Python
 * original used PyYAML to validate — replaced here by a structural check so the
 * skill stays zero-dependency Node.)
 *
 * Flags:
 *   --results FILE.jsonl   authored fields (repeatable)
 *   --root PATH            capture root (default: $VIBE_HISTORY_ROOT or ~/Documents/vibe-history)
 *   --backup-dir DIR       where originals are copied (default: <root>/.enrich-backups/<ts>)
 *   --dry                  preview first 3 rewrites, write nothing
 */

const fs = require('fs');
const path = require('path');
const { defaultHistoryRoot } = require('./_config.cjs');

const SEMANTIC = ['title', 'summary', 'type', 'outcome', 'keywords', 'decisions', 'lessons', 'insights'];
const OWNED = new Set([...SEMANTIC, 'topics', 'enriched']);
const ALLOWED_TYPE = new Set(['debug', 'feature', 'landing-page', 'cro', 'research', 'docs',
  'setup', 'content', 'data-processing', 'seo', 'planning', 'other']);
const ALLOWED_OUTCOME = new Set(['completed', 'partial', 'exploratory', 'blocked']);
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*):/;
const FENCE_RE = /\n---[ \t]*\n/;

/** Double-quoted YAML scalar (matches builder's yamlQuote). */
function yq(s) {
  s = String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  s = s.replace(/\r?\n/g, ' ').trim();
  return '"' + s + '"';
}

const kwSlug = (t) => String(t).toLowerCase().trim().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '');

/** [fm_inner, body] or [null, null] if no leading frontmatter fence. */
function splitDoc(text) {
  if (!text.startsWith('---')) return [null, null];
  const m = FENCE_RE.exec(text);
  if (!m) return [null, null];
  return [text.slice(4, m.index), text.slice(m.index + m[0].length)];
}

/** Ordered [key, raw_block] — indented/list lines attach to the previous key. */
function groupKeys(fmInner) {
  const out = [];
  let cur = null, buf = null;
  for (const line of fmInner.split('\n')) {
    const m = KEY_RE.exec(line);
    if (m && line[0] !== ' ' && line[0] !== '\t') {
      if (cur !== null) out.push([cur, buf.join('\n')]);
      cur = m[1]; buf = [line];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  if (cur !== null) out.push([cur, buf.join('\n')]);
  return out;
}

function blockList(key, items) {
  const list = (items || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5);
  if (!list.length) return `${key}: []`;
  return [`${key}:`, ...list.map((it) => `  - ${yq(it)}`)].join('\n');
}

function buildSemantic(r) {
  let typ = (r.type || 'other').trim();
  if (!ALLOWED_TYPE.has(typ)) typ = 'other';
  let out = (r.outcome || 'exploratory').trim();
  if (!ALLOWED_OUTCOME.has(out)) out = 'exploratory';
  const kws = (r.keywords || []).map(kwSlug).filter(Boolean).slice(0, 8);
  return [
    `title: ${yq(r.title || 'Untitled session')}`,
    `summary: ${yq(r.summary || '')}`,
    `type: ${typ}`,
    `outcome: ${out}`,
    kws.length ? `keywords: [${kws.join(', ')}]` : 'keywords: []',
    blockList('decisions', r.decisions),
    blockList('lessons', r.lessons),
    blockList('insights', r.insights),
  ].join('\n');
}

/** Light structural check replacing PyYAML: every top-level line is a key line
 * or an indented/list continuation, and `enriched: true` is present exactly. */
function validInner(inner) {
  let sawEnriched = false;
  for (const line of inner.split('\n')) {
    if (line === '' || line[0] === ' ' || line[0] === '\t') continue;
    if (!KEY_RE.test(line)) return false;
    if (line.trim() === 'enriched: true') sawEnriched = true;
  }
  return sawEnriched;
}

/** Return [new_text, error]. Body preserved verbatim; frontmatter rebuilt. */
function rewrite(text, r) {
  const [fmInner, body] = splitDoc(text);
  if (fmInner === null) return [null, 'no-frontmatter'];
  const groups = groupKeys(fmInner);
  const have = Object.fromEntries(groups);

  const uuidWant = (r.uuid || '').trim();
  if (uuidWant) {
    const raw = have.session_id || '';
    const sid = raw.split(':').pop().trim();
    if (sid && sid !== uuidWant) return [null, `uuid-mismatch(file=${sid} result=${uuidWant})`];
  }

  const deterministic = groups.filter(([k]) => !OWNED.has(k)).map(([, raw]) => raw);
  const inner = [buildSemantic(r), ...deterministic, 'enriched: true'].join('\n');

  if (!validInner(inner)) return [null, 'fm-invalid'];

  const newText = '---\n' + inner + '\n---' + '\n' + body;
  const [, newBody] = splitDoc(newText);
  if (newBody !== body) return [null, 'body-drift'];
  return [newText, null];
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv) {
  const out = { results: [], root: defaultHistoryRoot(), backupDir: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') out.results.push(argv[++i]);
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--backup-dir') out.backupDir = argv[++i];
    else if (a === '--dry') out.dry = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.results.length) { process.stderr.write('merge: --results required\n'); process.exit(2); }
  const backupDir = args.backupDir || path.join(args.root, '.enrich-backups', ts());

  const results = [];
  for (const rf of args.results) {
    for (const ln of fs.readFileSync(rf, 'utf8').split('\n')) {
      const t = ln.trim();
      if (t) results.push(JSON.parse(t));
    }
  }

  const rootResolved = path.resolve(args.root) + path.sep;

  let done = 0, skipped = 0, errors = 0;
  for (const r of results) {
    const rel = r.path || '';
    const file = path.join(args.root, rel);
    // `rel` comes from AI-subagent-authored JSON (derived from transcript
    // content) — reject anything that resolves outside args.root (e.g. a
    // `../../` segment) before touching the filesystem.
    if (!path.resolve(file).startsWith(rootResolved)) {
      process.stderr.write(`[merge][err:outside-root] ${rel}\n`); errors++; continue;
    }
    if (!fs.existsSync(file)) { process.stderr.write(`[merge][miss] ${rel}\n`); errors++; continue; }
    const text = fs.readFileSync(file, 'utf8');
    const [newText, err] = rewrite(text, r);
    if (err) { process.stderr.write(`[merge][err:${err}] ${rel}\n`); errors++; continue; }
    if (newText === text) { skipped++; continue; }
    if (args.dry) {
      if (done < 3) { process.stdout.write(`\n===== ${rel} =====\n`); process.stdout.write(newText.split('\n---\n', 1)[0] + '\n---\n'); }
      done++; continue;
    }
    const bpath = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(bpath), { recursive: true });
    fs.copyFileSync(file, bpath);
    fs.writeFileSync(file, newText, 'utf8');
    done++;
  }

  process.stderr.write(`[merge] written=${done} unchanged=${skipped} errors=${errors} backups=${args.dry ? '(dry)' : backupDir}\n`);
  process.exit(errors ? 1 : 0);
}

main();
