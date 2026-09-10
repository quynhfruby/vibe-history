#!/usr/bin/env node
'use strict';

/**
 * vibe-history-markdown-builder.cjs
 *
 * Pure transcript -> Markdown converter for the vibe-history-capture hook.
 * No I/O side effects beyond reading the transcript file(s) it is given a path to
 * (main session transcript + its sibling `subagents/*.jsonl` + `*.meta.json` files).
 *
 * Exports: parseSessionTranscript, buildMarkdownDigest, buildSubagentLookup,
 * filterUserMessageText (exported for unit testing internals).
 *
 * @module vibe-history-markdown-builder
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { formatLocalDate } = require('./vibe-history-project-utils.cjs');

// Inline full subagent conversations under a collapsible <details> block
// (user-confirmed default). Kept as a 1-line toggle per plan spec.
const INCLUDE_SIDECHAIN_CONTENT = true;

// Tool names that trigger subagent delegation + inlining.
// Spec/plan assumed `Task`; empirical inspection of this Claude Code install's
// real transcript shows the actual tool_use block name is `Agent` (not `Task`).
// Support both defensively rather than trusting either name blindly — the real
// signal is whether the tool_use `id` matches a `toolUseId` in the subagents
// lookup, so this set only narrows which blocks we bother checking.
const DELEGATION_TOOL_NAMES = new Set(['Task', 'Agent']);

// Safety net against a malformed/cyclic transcript causing runaway recursion
// when inlining nested subagent delegations. Real-world delegation chains
// observed on this machine are 2 levels deep at most; 5 leaves generous
// headroom while guaranteeing termination.
const MAX_DELEGATION_DEPTH = 5;

// Wrapper tags to strip entirely from user message text (non-greedy, dotall).
// local-command-stdout added after real-sample review: raw CLI stdout (often
// with ANSI escapes) leaking into the digest is the same class of system noise
// as the other three tags, not real conversation.
const WRAPPER_TAG_STRIP_RE = /<(system-reminder|local-command-caveat|task-notification|local-command-stdout)>[\s\S]*?<\/\1>/g;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

// Tool names whose `input.file_path` marks a file the session changed. Used to
// build the frontmatter `changed_files` count + the `## Changed Files` section.
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Semantic frontmatter fields — authored by the enrich step (need an LLM, so
// NOT derivable in the headless capture hook). Emitted empty by the hook and
// PRESERVED VERBATIM across re-capture so enrichment is never wiped. Order here
// = emission order (scan order: identity → knowledge). `title` is special: the
// hook writes a heuristic default, enrich overwrites it.
const SEMANTIC_KEYS = ['title', 'summary', 'type', 'outcome', 'keywords', 'decisions', 'lessons', 'insights'];
// Default value emitted for a semantic field when absent/unenriched. `keywords`
// is an inline list; decisions/lessons/insights are block lists (empty `[]`).
const SEMANTIC_DEFAULTS = {
  summary: '""', type: '""', outcome: '""',
  keywords: '[]', decisions: '[]', lessons: '[]', insights: '[]'
};

/**
 * Fresh session-level metadata accumulator, populated during parse (Phase 1).
 * Only the MAIN transcript populates one (subagent recursion passes none).
 * @returns {Object}
 */
function newExtractedMeta() {
  return {
    firstTs: null,
    lastTs: null,
    userMessageCount: 0,
    cwd: null,
    gitBranch: null,
    changedFiles: new Set(),
    customTitle: null,
    firstMeaningfulUserText: null
  };
}

/**
 * Add `Edit/Write/MultiEdit/NotebookEdit` target file paths from a content
 * block array into `set`. No-op on non-arrays / missing set.
 * @param {Array} blocks - assistant message content blocks
 * @param {Set<string>} set
 */
function collectChangedFiles(blocks, set) {
  if (!Array.isArray(blocks) || !set) return;
  for (const b of blocks) {
    if (b && b.type === 'tool_use' && EDIT_TOOL_NAMES.has(b.name)) {
      const fp = b.input && b.input.file_path;
      if (fp) set.add(fp);
    }
  }
}

/**
 * Whether a (already-filtered) user turn text is a good title candidate:
 * long enough, not a slash-command echo, not an image-only placeholder.
 * @param {string} text
 * @returns {boolean}
 */
function isMeaningfulTitleText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length <= 10) return false;
  if (/^\*Ran command/.test(t)) return false;
  if (/^\*\[image attached\]\*$/.test(t)) return false;
  return true;
}

/**
 * Strip system wrapper tags from raw user text; collapse a slash-command
 * wrapper (<command-name>/<command-args>) into a one-line summary.
 * @param {*} rawText - `message.content` value (only strings are meaningful)
 * @returns {string|null} Cleaned text, or null if nothing meaningful remains
 */
function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_RE, '');
}

function filterUserMessageText(rawText) {
  if (typeof rawText !== 'string') return null;

  const stripped = stripAnsi(rawText.replace(WRAPPER_TAG_STRIP_RE, '')).trim();
  if (!stripped) return null;

  const nameMatch = stripped.match(COMMAND_NAME_RE);
  if (nameMatch) {
    const argsMatch = stripped.match(COMMAND_ARGS_RE);
    const cmdName = nameMatch[1].trim();
    const cmdArgs = argsMatch ? argsMatch[1].replace(/\s+/g, ' ').trim() : '';
    return `*Ran command \`${cmdName}\`${cmdArgs ? ' ' + cmdArgs : ''}*`;
  }

  return stripped;
}

/**
 * Extract meaningful user-authored text from an array-shaped `message.content`.
 * Array content is NOT always a pure tool_result payload — a real human turn
 * can carry mixed text+image blocks. Drop tool_result (and any other
 * non-user-authored) blocks; keep `text` blocks (filtered through the same
 * wrapper-tag/ANSI rules as string content); render a short placeholder for
 * `image` blocks (never inline base64 image data into markdown — bloats the
 * file for no reader benefit).
 * @param {Array} blocks - `message.content` array
 * @returns {string|null} Joined text, or null if nothing meaningful remains
 */
function extractUserContentFromBlocks(blocks) {
  const pieces = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      const filtered = filterUserMessageText(block.text);
      if (filtered) pieces.push(filtered);
    } else if (block.type === 'image') {
      pieces.push('*[image attached]*');
    }
    // tool_result and any other block type: not user-authored content, skip.
  }
  return pieces.length > 0 ? pieces.join('\n\n') : null;
}

/**
 * Apply user-message filtering rules to a raw JSONL entry.
 * @param {Object} entry - Parsed JSONL line with type === 'user'
 * @returns {{role: 'user', ts: string|null, text: string}|null}
 */
function processUserEntry(entry) {
  if (entry.isMeta === true) return null;
  const message = entry.message || {};
  const content = message.content;

  if (Array.isArray(content)) {
    const text = extractUserContentFromBlocks(content);
    if (text === null) return null;
    return { role: 'user', ts: entry.timestamp || null, text };
  }

  const text = filterUserMessageText(content);
  if (text === null) return null;
  return { role: 'user', ts: entry.timestamp || null, text };
}

/**
 * Build a toolUseId -> subagent-file lookup by scanning `<sessionDir>/subagents/*.meta.json`
 * once. Never throws; missing/absent directory yields an empty map (graceful degrade).
 * @param {string} transcriptPath - Path to the main session transcript (`<sessionId>.jsonl`)
 * @returns {Map<string, {agentId: string, agentType: string, description: string, jsonlPath: string}>}
 */
function buildSubagentLookup(transcriptPath) {
  const lookup = new Map();
  try {
    const sessionDir = transcriptPath.replace(/\.jsonl$/, '');
    const subagentsDir = path.join(sessionDir, 'subagents');
    if (!fs.existsSync(subagentsDir)) return lookup;

    const metaFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.meta.json'));
    for (const file of metaFiles) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, file), 'utf8'));
        if (!meta || !meta.toolUseId) continue;
        const agentId = file.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
        lookup.set(meta.toolUseId, {
          agentId,
          agentType: meta.agentType || 'unknown',
          description: meta.description || '',
          jsonlPath: path.join(subagentsDir, `agent-${agentId}.jsonl`)
        });
      } catch (_) {
        // Malformed meta file — skip it, keep scanning the rest.
      }
    }
  } catch (_) {
    // Any unexpected failure (permissions, path issues) — degrade to empty lookup.
  }
  return lookup;
}

/**
 * Resolve a `tool_use` content block into a delegation block, recursively inlining
 * the subagent's own transcript when found. Degrades gracefully (marker-only) when
 * the subagent file is missing (still running, cleaned up), or the recursion depth
 * guard is hit.
 *
 * A subagent's own transcript can itself delegate to a grandchild subagent. That
 * grandchild's `tool_use.id` must be looked up against a lookup scoped to the
 * CURRENT transcript's own sibling `subagents/` directory (Claude Code may store
 * nested delegations there), not just the original top-level lookup — so this
 * rebuilds a lookup for `entry.jsonlPath` and merges it with the inherited one.
 * On this install's real transcripts every subagent file (any depth) happens to
 * live flat under the main session's single `subagents/` dir, so the rebuilt
 * lookup is typically empty and the merge is a no-op — but the merge keeps
 * correctness in either directory layout.
 * @param {Object} block - tool_use content block
 * @param {Map} subagentLookup - inherited toolUseId -> subagent-file lookup
 * @param {number} [depth=0] - current delegation recursion depth
 * @returns {Promise<Object>} delegation block
 */
async function resolveDelegationBlock(block, subagentLookup, depth = 0, meta = null) {
  const entry = block.id ? subagentLookup.get(block.id) : null;
  const agentType = entry?.agentType || block.input?.subagent_type || 'unknown';
  const description = entry?.description || block.input?.description || '';

  let resolved = false;
  let turns = null;
  const withinDepthLimit = depth < MAX_DELEGATION_DEPTH;
  if (INCLUDE_SIDECHAIN_CONTENT && entry && withinDepthLimit && fs.existsSync(entry.jsonlPath)) {
    try {
      const ownLookup = buildSubagentLookup(entry.jsonlPath);
      const mergedLookup = ownLookup.size > 0
        ? new Map([...subagentLookup, ...ownLookup])
        : subagentLookup;
      // Thread `meta` into the recursion so files edited BY a subagent are
      // counted in changed_files/## Changed Files. parseSessionTranscript gates
      // the main-session-only fields (firstTs, message count, title, …) by
      // depth, so only changedFiles accumulates from subagent turns.
      turns = await parseSessionTranscript(entry.jsonlPath, {
        skipSidechain: false,
        subagentLookup: mergedLookup,
        depth: depth + 1,
        meta
      });
      resolved = true;
    } catch (_) {
      resolved = false;
      turns = null;
    }
  }

  return { kind: 'delegation', agentType, description, resolved, turns };
}

/**
 * Flush an in-progress assistant block group into a rendered turn (filters +
 * resolves delegation blocks). Pushes onto `turns` when non-empty.
 * @param {{key: *, ts: string|null, blocks: Object[]}|null} group
 * @param {Object[]} turns - accumulator array
 * @param {Map} subagentLookup
 * @param {number} [depth=0] - current delegation recursion depth
 */
async function flushAssistantGroup(group, turns, subagentLookup, depth = 0, meta = null) {
  if (!group) return;
  const blocks = [];
  for (const raw of group.blocks) {
    if (raw.type === 'thinking') {
      const text = stripAnsi(raw.thinking || '').trim();
      if (text) blocks.push({ kind: 'thinking', text });
    } else if (raw.type === 'text') {
      const text = stripAnsi(raw.text || '').trim();
      if (text) blocks.push({ kind: 'text', text });
    } else if (raw.type === 'tool_use' && DELEGATION_TOOL_NAMES.has(raw.name)) {
      blocks.push(await resolveDelegationBlock(raw, subagentLookup, depth, meta));
    }
    // All other tool_use (non-delegation) and tool_result blocks: dropped by design.
  }
  if (blocks.length > 0) {
    turns.push({ role: 'assistant', ts: group.ts, blocks });
  }
}

/**
 * Stream-parse a transcript JSONL file (main session or a subagent's own file,
 * same schema) into an ordered array of turn objects. Never throws on malformed
 * JSON lines — skips them and keeps parsing.
 *
 * @param {string} transcriptPath - Path to a `.jsonl` transcript file
 * @param {Object} [opts]
 * @param {boolean} [opts.skipSidechain=true] - Defensively drop `isSidechain: true`
 *   entries. Only meaningful for the MAIN transcript (which empirically never has
 *   any); MUST be false when recursing into a subagent's own file, since every
 *   entry there legitimately carries `isSidechain: true`.
 * @param {Map} [opts.subagentLookup] - Shared toolUseId -> subagent-file lookup,
 *   built once per digest via buildSubagentLookup and threaded through recursion
 *   (merged with each subagent's own lookup as recursion descends — see
 *   resolveDelegationBlock).
 * @param {number} [opts.depth=0] - Current delegation recursion depth. Callers
 *   parsing the main session transcript should omit this (defaults to 0);
 *   recursive calls into a subagent's own transcript pass depth+1. Guarded by
 *   MAX_DELEGATION_DEPTH in resolveDelegationBlock to prevent a malformed/cyclic
 *   transcript from causing a runaway/hanging recursion.
 * @returns {Promise<Array<Object>>} Ordered turns: user turns + grouped assistant turns
 */
async function parseSessionTranscript(transcriptPath, opts = {}) {
  const { skipSidechain = true, subagentLookup = new Map(), depth = 0, meta = null } = opts;
  const turns = [];
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return turns;

  let currentGroup = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue; // malformed line — skip, keep parsing the rest
    }

    // Session-level metadata (message count, firstTs, title, cwd, branch,
    // last_activity) describes the MAIN session only — never inflated by a
    // subagent's own turns during recursion. changed_files is the exception:
    // it accumulates at any depth so subagent-authored edits are counted too.
    const mainMeta = meta && depth === 0;

    // Session title from Claude Code's own summary/custom-title records (these
    // record types are otherwise dropped as noise below). Main transcript only.
    if (mainMeta && !meta.customTitle) {
      if (entry.type === 'custom-title' && entry.customTitle) {
        meta.customTitle = String(entry.customTitle).split('\n')[0].trim().slice(0, 100);
      } else if (entry.type === 'summary' && entry.summary) {
        meta.customTitle = String(entry.summary).split('\n')[0].trim().slice(0, 100);
      }
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue; // drop noise types
    if (skipSidechain && entry.isSidechain === true) continue; // defensive (main file only)

    if (entry.type === 'user') {
      await flushAssistantGroup(currentGroup, turns, subagentLookup, depth, meta);
      currentGroup = null;
      const userTurn = processUserEntry(entry);
      if (userTurn) {
        turns.push(userTurn);
        if (mainMeta) {
          meta.userMessageCount++;
          const ts = entry.timestamp || null;
          if (ts) { if (!meta.firstTs) meta.firstTs = ts; meta.lastTs = ts; }
          if (entry.cwd && !meta.cwd) meta.cwd = entry.cwd;
          if (entry.gitBranch && !meta.gitBranch) meta.gitBranch = entry.gitBranch;
          if (!meta.firstMeaningfulUserText && isMeaningfulTitleText(userTurn.text)) {
            meta.firstMeaningfulUserText = userTurn.text.replace(/\s+/g, ' ').trim().slice(0, 80);
          }
        }
      }
      continue;
    }

    // entry.type === 'assistant'
    const message = entry.message || {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (meta) {
      collectChangedFiles(content, meta.changedFiles); // any depth (incl. subagents)
    }
    if (mainMeta) {
      if (entry.timestamp) meta.lastTs = entry.timestamp;
      if (entry.gitBranch && !meta.gitBranch) meta.gitBranch = entry.gitBranch;
    }
    const groupKey = message.id || entry.requestId || null;

    if (!currentGroup || currentGroup.key !== groupKey) {
      await flushAssistantGroup(currentGroup, turns, subagentLookup, depth, meta);
      currentGroup = { key: groupKey, ts: entry.timestamp || null, blocks: [] };
    }
    currentGroup.blocks.push(...content);
  }

  await flushAssistantGroup(currentGroup, turns, subagentLookup, depth, meta);
  return turns;
}

/**
 * Minimal HTML-escaping for values interpolated into `<summary>` markup so a
 * subagent `description`/`agentType` containing `</summary>` or other raw
 * HTML can't break the rendered block. Cosmetic hardening only — not a
 * security boundary (these values come from Claude Code's own tool_use
 * input, not untrusted external input).
 * @param {*} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render an ordered turn array into Markdown body text (no top-level header).
 * Recursively reused for nested subagent turns inside <details> blocks.
 * @param {Array<Object>} turns
 * @returns {string}
 */
function renderTurns(turns) {
  const parts = [];

  for (const turn of turns) {
    if (turn.role === 'user') {
      parts.push(`### User — ${turn.ts || 'unknown'}\n${turn.text}`);
      continue;
    }

    const blockParts = turn.blocks.map(block => {
      if (block.kind === 'thinking') {
        return `<details><summary>🧠 thinking</summary>\n\n${block.text}\n\n</details>`;
      }
      if (block.kind === 'text') {
        return block.text;
      }
      // block.kind === 'delegation'
      const marker = `*Delegated to \`${block.agentType}\` agent — ${block.description}*`;
      if (!block.resolved) return marker;
      const nested = renderTurns(block.turns);
      const safeAgentType = escapeHtml(block.agentType);
      const safeDescription = escapeHtml(block.description);
      return `${marker}\n<details><summary>📋 Subagent: ${safeAgentType} — ${safeDescription}</summary>\n\n${nested}\n\n</details>`;
    });

    if (blockParts.length > 0) {
      parts.push(`### Assistant — ${turn.ts || 'unknown'}\n${blockParts.join('\n\n')}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Build the full Markdown digest for one hook firing.
 * @param {string} transcriptPath - Path to the main session transcript
 * @param {Object} meta
 * @param {string} meta.sessionId
 * @param {string} meta.hookEvent - e.g. 'SessionEnd' or 'PreCompact'
 * @param {string} meta.reasonOrTrigger - `reason` (SessionEnd) or `trigger` (PreCompact)
 * @param {string} meta.projectName
 * @param {string} meta.cwd
 * @param {string} meta.generatedAt - ISO timestamp
 * @returns {Promise<string>} Markdown document
 */
/**
 * Quote a scalar for YAML double-quoted style (escape backslash + quote,
 * flatten newlines). Mirrors the Task-5 prepend script's quoting.
 * @param {*} value
 * @returns {string}
 */
function yamlQuote(value) {
  const s = String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')
    .trim();
  return `"${s}"`;
}

/** Whether a semantic field's raw text (its `key:` line + any block-list
 * children) carries no real content — `""`, `[]`, or an empty block. */
function isEmptySemanticRaw(raw) {
  const after = raw.split('\n')[0].replace(/^[A-Za-z_][A-Za-z0-9_]*:[ \t]*/, '').trim();
  if (after === '') return !/\n[ \t]*-[ \t]+\S/.test(raw); // block list: empty unless it has items
  return after === '""' || after === "''" || after === '[]';
}

/**
 * Read the semantic frontmatter fields from an existing digest so a re-capture
 * PRESERVES enrichment instead of wiping it (the hook regenerates the whole
 * file every firing). Values are captured VERBATIM (raw `key:` line + any
 * indented block-list children) and re-emitted unchanged, so multi-line
 * decisions/lessons/insights round-trip losslessly. Fail-open: any problem
 * returns {} (treated as "not yet enriched"). Scoped strictly to the leading
 * `---`…`---` block — never the conversation body.
 * @param {string} destPath
 * @returns {Object} { <semanticKey>: rawText, enriched: boolean }
 */
function readExistingFrontmatter(destPath) {
  try {
    if (!destPath || !fs.existsSync(destPath)) return {};
    const content = fs.readFileSync(destPath, 'utf8');
    if (!content.startsWith('---')) return {};
    const end = content.indexOf('\n---', 3);
    if (end === -1) return {};
    const block = content.slice(4, end); // drop leading "---\n"
    const keyRe = /^([A-Za-z_][A-Za-z0-9_]*):/;

    // Group each top-level key with its (indented / list) continuation lines.
    const byKey = {};
    let curKey = null, buf = null;
    for (const line of block.split('\n')) {
      const m = line.match(keyRe);
      if (m && !/^[ \t]/.test(line)) {
        if (curKey) byKey[curKey] = buf.join('\n');
        curKey = m[1]; buf = [line];
      } else if (curKey) {
        buf.push(line);
      }
    }
    if (curKey) byKey[curKey] = buf.join('\n');

    const preserved = {};
    for (const k of SEMANTIC_KEYS) {
      if (byKey[k] !== undefined) preserved[k] = byKey[k];
    }
    // enriched: explicit flag wins; otherwise infer from any non-empty
    // knowledge field (covers legacy Task-5 files that predate the flag).
    const explicit = byKey.enriched
      ? byKey.enriched.replace(/^enriched:[ \t]*/, '').trim()
      : null;
    if (explicit === 'true') preserved.enriched = true;
    else if (explicit === 'false') preserved.enriched = false;
    else {
      preserved.enriched = SEMANTIC_KEYS.some(
        k => k !== 'title' && preserved[k] !== undefined && !isEmptySemanticRaw(preserved[k])
      );
    }
    return preserved;
  } catch (_) {
    return {};
  }
}

/**
 * Build the YAML frontmatter block (with trailing newline). Deterministic
 * fields come from the parsed session; semantic fields come from `preserved`
 * (empty on a fresh capture → `enriched:false`).
 * @param {Object} extracted - from newExtractedMeta()/parse
 * @param {Object} digestMeta - {sessionId, hookEvent, projectName, cwd, generatedAt}
 * @param {Object} [preserved] - semantic fields from readExistingFrontmatter
 * @returns {string}
 */
function buildFrontmatter(extracted, digestMeta, preserved = {}) {
  const heuristicTitle = extracted.customTitle || extracted.firstMeaningfulUserText || 'Untitled session';
  const date = formatLocalDate(extracted.firstTs) || formatLocalDate(digestMeta.generatedAt);
  const enriched = preserved.enriched === true;

  const lines = ['---'];
  // ── identity (scan first) ── title is enrichable: preserved verbatim if the
  // enrich step wrote a better one, else the heuristic default.
  lines.push(preserved.title || `title: ${yamlQuote(heuristicTitle)}`);
  // ── identity + knowledge (semantic: preserved verbatim, else empty default) ──
  for (const k of ['summary', 'type', 'outcome', 'keywords', 'decisions', 'lessons', 'insights']) {
    lines.push(preserved[k] !== undefined ? preserved[k] : `${k}: ${SEMANTIC_DEFAULTS[k]}`);
  }
  // ── provenance / navigation (deterministic) ──
  lines.push(`project: ${yamlQuote(digestMeta.projectName)}`);
  lines.push(`date: ${date}`);
  lines.push(`session_id: ${digestMeta.sessionId}`);
  // Which agent produced this session — 'claude' or 'codex'. Deterministic
  // provenance so search/enrich can filter by agent. Falls back to 'claude'
  // (the original single-agent default) when a caller omits it.
  lines.push(`source: ${yamlQuote(digestMeta.source || 'claude')}`);
  // Omit git_branch when it's the literal "HEAD" (detached-HEAD cwd) — a noisy
  // non-branch value the user chose not to record; a real branch name still emits.
  if (extracted.gitBranch && extracted.gitBranch !== 'HEAD') {
    lines.push(`git_branch: ${yamlQuote(extracted.gitBranch)}`);
  }
  lines.push(`changed_files: ${extracted.changedFiles.size}`);
  lines.push(`messages: ${extracted.userMessageCount}`);
  if (extracted.firstTs) lines.push(`created: ${extracted.firstTs}`);
  if (extracted.lastTs) lines.push(`last_activity: ${extracted.lastTs}`);
  lines.push(`cwd: ${yamlQuote(digestMeta.cwd)}`);
  lines.push(`hook_event: ${yamlQuote(digestMeta.hookEvent)}`);
  lines.push(`enriched: ${enriched}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

/**
 * Render the `## Changed Files` section (sorted), or '' when none.
 * @param {Set<string>} set
 * @returns {string}
 */
function renderChangedFiles(set) {
  if (!set || set.size === 0) return '';
  const items = [...set].sort().map(f => `- \`${f}\``);
  return `## Changed Files\n\n${items.join('\n')}`;
}

/**
 * Phase 1: parse a transcript into turns + extracted session metadata.
 * @param {string} transcriptPath
 * @returns {Promise<{turns: Array, extracted: Object}>}
 */
async function parseDigest(transcriptPath) {
  const subagentLookup = buildSubagentLookup(transcriptPath);
  const extracted = newExtractedMeta();
  const turns = await parseSessionTranscript(transcriptPath, {
    skipSidechain: true, subagentLookup, meta: extracted
  });
  return { turns, extracted };
}

/**
 * Phase 2: render parsed turns + metadata into the full Markdown document
 * (frontmatter + legacy header + body + Changed Files).
 * @param {Array} turns
 * @param {Object} extracted
 * @param {Object} digestMeta - {sessionId, hookEvent, reasonOrTrigger, projectName, cwd, generatedAt}
 * @param {Object} [preserved]
 * @returns {string}
 */
function renderDigest(turns, extracted, digestMeta, preserved = {}) {
  const frontmatter = buildFrontmatter(extracted, digestMeta, preserved);
  const header = `# Session ${digestMeta.sessionId} — ${digestMeta.hookEvent} (${digestMeta.reasonOrTrigger})\n` +
    `_project: ${digestMeta.projectName} · cwd: ${digestMeta.cwd} · generated: ${digestMeta.generatedAt}_`;
  const body = renderTurns(turns);
  const changed = renderChangedFiles(extracted.changedFiles);

  let doc = `${frontmatter}\n${header}`;
  if (body) doc += `\n\n${body}`;
  if (changed) doc += `\n\n${changed}`;
  return doc + '\n';
}

/**
 * Build the full Markdown digest for one hook firing (parse + render). Thin
 * wrapper over parseDigest + renderDigest; callers that need the session's
 * firstTs (for the filename) or merge-preserve should use the two-phase API.
 * @param {string} transcriptPath - Path to the main session transcript
 * @param {Object} meta - digestMeta (see renderDigest)
 * @returns {Promise<string>} Markdown document
 */
async function buildMarkdownDigest(transcriptPath, meta) {
  const { turns, extracted } = await parseDigest(transcriptPath);
  return renderDigest(turns, extracted, meta, {});
}

module.exports = {
  parseSessionTranscript,
  parseDigest,
  renderDigest,
  buildMarkdownDigest,
  buildSubagentLookup,
  buildFrontmatter,
  readExistingFrontmatter,
  renderChangedFiles,
  collectChangedFiles,
  filterUserMessageText,
  renderTurns
};
