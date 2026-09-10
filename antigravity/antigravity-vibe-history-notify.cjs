#!/usr/bin/env node
'use strict';

/**
 * antigravity-vibe-history-notify.cjs
 *
 * `Stop` hook entry for Antigravity, registered under a dedicated
 * `vibe-history` key in `~/.gemini/config/hooks.json` (sits alongside, and
 * does not touch, the pre-existing `orca-status` key). Antigravity invokes
 * the hook command with the event payload on stdin and expects a JSON
 * `{"decision": ...}` reply on stdout (see
 * https://antigravity.google/docs/hooks) — an empty string means "no
 * override, proceed as normal", same convention Orca's own antigravity-hook.sh
 * uses for Stop.
 *
 * Payload fields used: `transcriptPath` (JSONL transcript for this
 * conversation) and `workspacePaths[0]` (project cwd) — passed straight
 * through to antigravity-vibe-history-capture.cjs, spawned detached so the
 * capture (transcript parse + markdown write) never delays Antigravity's own
 * Stop handling.
 *
 * Always replies `{"decision":""}` and exits 0 (fail-open) even if the
 * payload is missing/malformed — capture then just falls back to its own
 * newest-transcript auto-resolve.
 */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => finish(data));
      process.stdin.on('error', () => finish(data));
      // Never hang waiting on stdin — fail open quickly.
      setTimeout(() => finish(data), 3000).unref();
    } catch (_) {
      finish('');
    }
  });
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw); } catch (_) { /* payload stays {} */ }

  const transcriptPath = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '';
  const cwd = Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string'
    ? payload.workspacePaths[0]
    : '';

  try {
    const { spawn } = require('child_process');
    const path = require('path');
    const CAPTURE = path.join(__dirname, 'antigravity-vibe-history-capture.cjs');
    const cap = spawn(process.execPath, [CAPTURE, transcriptPath, cwd, 'antigravity-stop'], {
      detached: true,
      stdio: 'ignore'
    });
    cap.on('error', () => {});
    cap.unref();
  } catch (_) { /* fail-open */ }

  process.stdout.write('{"decision":""}\n');
  process.exit(0);
}

main().catch(() => {
  try { process.stdout.write('{"decision":""}\n'); } catch (_) {}
  process.exit(0);
});
