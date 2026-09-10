#!/usr/bin/env node
'use strict';

/**
 * vibe-history-codex-parser.cjs
 *
 * Codex-CLI counterpart to the Claude-JSONL parser in
 * vibe-history-markdown-builder.cjs. Codex writes its transcripts as "rollout"
 * files (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`). This module
 * reads a rollout and emits the SAME `{ turns, extracted }` shape the shared
 * renderer (renderDigest) consumes, so the Codex capture reuses renderDigest,
 * buildFrontmatter, project-utils, filenames and frontmatter-preserve verbatim
 * (DRY: only the parse layer differs between the two agents).
 *
 * Codex has shipped TWO different rollout shapes; this parser handles BOTH,
 * because which one you get depends on the Codex mode/version:
 *
 *   A) Interactive TUI (e.g. 0.149.x, and pre-0.147) — content arrives as
 *      `event_msg` → `item_completed` → `payload.item`, typed:
 *        UserMessage / AgentMessage (item.content = [{text}])
 *        Reasoning   (item.summary_text = [str], usually empty/encrypted)
 *        FileChange  (item.changes = { path: … })
 *
 *   B) Non-interactive exec (0.147.x) — content arrives as FLAT `event_msg`
 *      payload types: `user_message` / `agent_message` (payload.message = str),
 *      changed files from `patch_apply_end` (payload.stdout lists A|M|D paths).
 *
 * The `response_item` stream is intentionally ignored for content: its messages
 * duplicate the item_completed ones, and its reasoning is `encrypted_content`
 * (no plaintext), so Codex digests usually have no thinking blocks — a Codex
 * limitation, not a capture defect. `session_meta` (session_id, cwd) is shared.
 *
 * Turn/block shapes produced (must match renderTurns in the builder):
 *   user turn      -> { role: 'user', ts, text }
 *   assistant turn -> { role: 'assistant', ts, blocks: [
 *                        { kind: 'thinking', text } | { kind: 'text', text } ] }
 *
 * Never throws on malformed lines — skips them and keeps parsing.
 *
 * @module vibe-history-codex-parser
 */

const fs = require('fs');
const readline = require('readline');
const { execFileSync } = require('child_process');

/**
 * Best-effort current git branch for a cwd (Codex rollouts don't record it).
 * @param {string} cwd
 * @returns {string|null}
 */
function deriveGitBranch(cwd) {
  if (!cwd) return null;
  try {
    const branch = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return branch || null;
  } catch (_) {
    return null;
  }
}

/** Join an array of content blocks ({text} — the `type` field varies: text/Text). */
function joinContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map(c => (c && typeof c.text === 'string' ? c.text : ''))
    .join('')
    .trim();
}

/** Coerce a flat `message` field (string, or defensively an array of {text}). */
function messageToText(message) {
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) return joinContentText(message);
  return '';
}

/** Reasoning plaintext from an item's `summary_text` array (empty when encrypted). */
function itemReasoningText(item) {
  const parts = [];
  const arr = item && Array.isArray(item.summary_text) ? item.summary_text
    : (item && Array.isArray(item.summary) ? item.summary : null);
  if (arr) {
    for (const s of arr) {
      if (typeof s === 'string' && s.trim()) parts.push(s.trim());
      else if (s && typeof s.text === 'string' && s.text.trim()) parts.push(s.text.trim());
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * Extract changed file paths from a `patch_apply_end` stdout blob (exec mode):
 *   "Success. Updated the following files:\nA /abs/new.ts\nM /abs/edit.ts\n"
 */
function collectPatchFiles(stdout, into) {
  if (typeof stdout !== 'string' || !stdout) return;
  for (const raw of stdout.split('\n')) {
    const m = raw.match(/^\s*([AMDR])\s+(.+?)\s*$/);
    if (m && m[2]) into.add(m[2]);
  }
}

/**
 * Parse a Codex rollout file into { turns, extracted, sessionId }.
 * @param {string} rolloutPath
 * @returns {Promise<{turns: Array, extracted: Object, sessionId: string|null}>}
 */
async function parseCodexRollout(rolloutPath) {
  const extracted = {
    firstTs: null,
    lastTs: null,
    userMessageCount: 0,
    cwd: null,
    gitBranch: null,
    changedFiles: new Set(),
    customTitle: null,
    firstMeaningfulUserText: null
  };
  const turns = [];
  let sessionId = null;
  let sessionMetaTs = null;

  if (!rolloutPath || !fs.existsSync(rolloutPath)) {
    return { turns, extracted, sessionId };
  }

  // Consecutive assistant items (reasoning + agent text) coalesce into one
  // assistant turn, flushed when a user message arrives.
  let current = null;
  const flush = () => {
    if (current && current.blocks.length > 0) turns.push(current);
    current = null;
  };
  const ensureAssistant = (ts) => { if (!current) current = { role: 'assistant', ts, blocks: [] }; };

  const addUser = (text, ts) => {
    if (!text) return;
    flush();
    extracted.userMessageCount += 1;
    if (!extracted.firstTs) extracted.firstTs = ts;
    if (!extracted.firstMeaningfulUserText) {
      extracted.firstMeaningfulUserText = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    turns.push({ role: 'user', ts, text });
  };
  const addAssistantText = (text, ts) => { if (!text) return; ensureAssistant(ts); current.blocks.push({ kind: 'text', text }); };
  const addThinking = (text, ts) => { if (!text) return; ensureAssistant(ts); current.blocks.push({ kind: 'thinking', text }); };

  const rl = readline.createInterface({
    input: fs.createReadStream(rolloutPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch (_) { continue; }

    const ts = entry.timestamp || null;
    if (ts) extracted.lastTs = ts;

    const type = entry.type;
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};

    if (type === 'session_meta') {
      sessionId = payload.session_id || payload.id || sessionId;
      if (!extracted.cwd && payload.cwd) extracted.cwd = payload.cwd;
      sessionMetaTs = payload.timestamp || ts || sessionMetaTs;
      continue;
    }

    if (type !== 'event_msg') continue; // response_item is ignored (dup/encrypted)
    const pType = payload.type;

    // --- Schema A: interactive TUI / pre-0.147 — item_completed → payload.item ---
    if (pType === 'item_completed' && payload.item && typeof payload.item === 'object') {
      const item = payload.item;
      switch (item.type) {
        case 'UserMessage':   addUser(joinContentText(item.content), ts); break;
        case 'AgentMessage':  addAssistantText(joinContentText(item.content), ts); break;
        case 'Reasoning':     addThinking(itemReasoningText(item), ts); break;
        case 'FileChange': {
          const changes = item.changes && typeof item.changes === 'object' ? item.changes : {};
          for (const p of Object.keys(changes)) if (p) extracted.changedFiles.add(p);
          break;
        }
        // CommandExecution / others: dropped (parity with dropping tool calls).
      }
      continue;
    }

    // --- Schema B: exec 0.147 — flat event_msg payloads ---
    if (pType === 'user_message') addUser(messageToText(payload.message), ts);
    else if (pType === 'agent_message') addAssistantText(messageToText(payload.message), ts);
    else if (pType === 'patch_apply_end') collectPatchFiles(payload.stdout, extracted.changedFiles);
  }

  flush();

  if (!extracted.firstTs) extracted.firstTs = sessionMetaTs;
  extracted.gitBranch = deriveGitBranch(extracted.cwd);

  return { turns, extracted, sessionId };
}

module.exports = { parseCodexRollout, deriveGitBranch };
