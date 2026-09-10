'use strict';

/**
 * merge-antigravity-hooks.cjs — installer helper.
 *
 * Registers the vibe-history capture notify command on Antigravity's `Stop`
 * hook in ~/.gemini/config/hooks.json, under a dedicated top-level
 * `vibe-history` key — sits alongside any pre-existing keys (e.g.
 * `orca-status`) without touching them. REPLACE semantics: this key is fully
 * overwritten each run, so re-install / migration is idempotent and never
 * stacks duplicate Stop hooks.
 *
 * Usage: node merge-antigravity-hooks.cjs <hooks.json path> <command string>
 */

const fs = require('fs');

const hooksPath = process.argv[2];
const command = process.argv[3];
if (!hooksPath || !command) {
  console.error('usage: merge-antigravity-hooks.cjs <hooks-path> <command>');
  process.exit(2);
}

let hooks = {};
try {
  const raw = fs.readFileSync(hooksPath, 'utf8').trim();
  if (raw) hooks = JSON.parse(raw);
} catch (_) {
  hooks = {}; // missing/empty/corrupt → start fresh (backup is taken by install.sh)
}

if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) hooks = {};

hooks['vibe-history'] = {
  Stop: [{ type: 'command', command, timeout: 10 }]
};

fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n', 'utf8');
console.log('ok');
