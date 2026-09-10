#!/usr/bin/env node
'use strict';

/**
 * vibe-history-antigravity-parser.cjs
 *
 * Antigravity (Google, Gemini-based IDE/CLI) counterpart to the Claude-JSONL
 * and Codex-rollout parsers. Antigravity writes one JSONL transcript per
 * conversation at
 * `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
 * (path handed to hooks as `transcriptPath` — see
 * https://antigravity.google/docs/hooks). Each line is a flat step object:
 * `{ step_index, source, type, status, created_at, content }`.
 *
 * Emits the SAME `{ turns, extracted, sessionId }` shape the Codex parser
 * does, so capture reuses renderDigest / buildFrontmatter / project-utils /
 * frontmatter-preserve verbatim (DRY: only the parse layer differs).
 *
 * Observed `type` values (live samples, 2026-08-29): USER_INPUT,
 * PLANNER_RESPONSE (assistant text — only the FINAL entry per turn carries
 * non-null `content`, earlier ones are streaming placeholders with
 * `content: null`), CODE_ACTION / RUN_COMMAND / VIEW_FILE / LIST_DIRECTORY /
 * GREP_SEARCH / SEARCH_WEB / EPHEMERAL_MESSAGE / CONVERSATION_HISTORY /
 * ERROR_MESSAGE (all dropped from turns, parity with how the Codex parser
 * drops tool calls — CODE_ACTION content is still scanned for changed-file
 * paths). No reasoning/thinking type has been observed yet, so — like
 * Codex — Antigravity digests currently have no thinking blocks; not a
 * regression, a source limitation until a reasoning type shows up.
 *
 * `USER_INPUT` content arrives wrapped as
 * `<USER_REQUEST>...</USER_REQUEST><ADDITIONAL_METADATA>...` — only the
 * `<USER_REQUEST>` inner text is kept.
 *
 * Never throws on malformed lines — skips them and keeps parsing.
 *
 * @module vibe-history-antigravity-parser
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

/** Best-effort current git branch for a cwd (transcript has no cwd/branch field). */
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

/** Strip the `<USER_REQUEST>…</USER_REQUEST>` wrapper (+ sibling metadata tags) off user input. */
function extractUserRequestText(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const m = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return (m ? m[1] : raw).trim();
}

/** Pull `Created/Modified/Edited/Updated/Deleted file file://<path>` mentions out of CODE_ACTION content. */
function collectCodeActionFiles(content, into) {
  if (typeof content !== 'string' || !content) return;
  const re = /(?:Created|Modified|Edited|Updated|Deleted)\s+file\s+file:\/\/(\S+)/gi;
  let m;
  while ((m = re.exec(content))) {
    try { into.add(decodeURIComponent(m[1])); } catch (_) { into.add(m[1]); }
  }
}

/** conversationId from `.../brain/<conversationId>/.system_generated/logs/transcript.jsonl`. */
function deriveSessionIdFromPath(transcriptPath) {
  if (!transcriptPath) return null;
  const parts = transcriptPath.split(path.sep);
  const idx = parts.lastIndexOf('brain');
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  // Fallback: parent of `.system_generated`.
  const sgIdx = parts.lastIndexOf('.system_generated');
  if (sgIdx > 0 && parts[sgIdx - 1]) return parts[sgIdx - 1];
  return null;
}

/**
 * Parse an Antigravity transcript.jsonl into { turns, extracted, sessionId }.
 * @param {string} transcriptPath
 * @param {string} [cwdHint] - workspace path from the hook payload, when known
 * @returns {Promise<{turns: Array, extracted: Object, sessionId: string|null}>}
 */
async function parseAntigravityTranscript(transcriptPath, cwdHint) {
  const extracted = {
    firstTs: null,
    lastTs: null,
    userMessageCount: 0,
    cwd: cwdHint || null,
    gitBranch: null,
    changedFiles: new Set(),
    customTitle: null,
    firstMeaningfulUserText: null
  };
  const turns = [];
  const sessionId = deriveSessionIdFromPath(transcriptPath);

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns, extracted, sessionId };
  }

  // Consecutive PLANNER_RESPONSE text chunks coalesce into one assistant
  // turn, flushed when the next USER_INPUT arrives (same pattern as Codex).
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

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch (_) { continue; }

    const ts = entry.created_at || null;
    if (ts) extracted.lastTs = ts;
    const type = entry.type;
    const content = entry.content;

    if (type === 'USER_INPUT') {
      addUser(extractUserRequestText(content), ts);
      continue;
    }
    if (type === 'PLANNER_RESPONSE') {
      if (typeof content === 'string' && content.trim()) addAssistantText(content.trim(), ts);
      continue;
    }
    if (type === 'CODE_ACTION') {
      collectCodeActionFiles(content, extracted.changedFiles);
      continue;
    }
    // RUN_COMMAND / VIEW_FILE / LIST_DIRECTORY / GREP_SEARCH / SEARCH_WEB /
    // EPHEMERAL_MESSAGE / CONVERSATION_HISTORY / ERROR_MESSAGE / unknown: dropped.
  }

  flush();
  extracted.gitBranch = deriveGitBranch(extracted.cwd);

  return { turns, extracted, sessionId };
}

module.exports = { parseAntigravityTranscript, deriveSessionIdFromPath, deriveGitBranch };
