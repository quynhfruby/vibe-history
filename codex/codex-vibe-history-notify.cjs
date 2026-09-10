#!/usr/bin/env node
'use strict';

/**
 * codex-vibe-history-notify.cjs
 *
 * config.toml `notify` dispatcher for Codex CLI. Codex invokes the notify
 * program once per event (e.g. agent-turn-complete), appending a JSON string as
 * the final argv. This wrapper triggers the vibe-history capture for the current
 * session, fire-and-forget so Codex is never blocked.
 *
 * TOPOLOGY: if another tool already owns config.toml `notify` (e.g. a
 * computer-use client) as PRIMARY, it can forward to THIS script via its own
 * `--previous-notify` arg instead of this script being registered directly.
 * In that setup the other tool already runs itself on every turn — this
 * script must NOT re-invoke it, or `turn-ended` would fire twice per turn.
 * So capture is the only job here. (If the topology ever flips back to this
 * script being primary, restore a forward to the other tool.)
 *
 * Always exits 0 immediately (fail-open).
 */

try {
  const { spawn } = require('child_process');
  const path = require('path');

  const CAPTURE = path.join(__dirname, 'codex-vibe-history-capture.cjs');

  // vibe-history capture — detached, newest rollout auto-resolved.
  try {
    const cap = spawn(process.execPath, [CAPTURE, '', 'codex-turn-ended'], {
      detached: true,
      stdio: 'ignore'
    });
    cap.on('error', () => {});
    cap.unref();
  } catch (_) { /* fail-open */ }

  process.exit(0);
} catch (_) {
  process.exit(0);
}
