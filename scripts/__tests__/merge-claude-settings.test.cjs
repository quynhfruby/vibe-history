'use strict';

/**
 * Tests for scripts/merge-claude-settings.cjs — the installer's settings.json
 * hook merge. Verifies REPLACE semantics: prior vibe-history hooks (any path)
 * are removed, foreign hooks are preserved, ours is added exactly once, and
 * re-running is idempotent.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'merge-claude-settings.cjs');
const CMD = 'node /engine/claude/vibe-history-capture.cjs';

function run(settingsPath, command = CMD) {
  execFileSync('node', [HELPER, settingsPath, command], { encoding: 'utf8' });
}
function tmpSettings(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-merge-'));
  const p = path.join(dir, 'settings.json');
  if (obj !== undefined) fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
function commandsOf(p, event) {
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (s.hooks[event] || []).flatMap(g => (g.hooks || []).map(h => h.command));
}

test('creates hooks on a fresh (missing) settings file', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-merge-')), 'settings.json');
  run(p);
  assert.deepStrictEqual(commandsOf(p, 'SessionEnd'), [CMD]);
  assert.deepStrictEqual(commandsOf(p, 'PreCompact'), [CMD]);
});

test('removes a stale vibe-history hook (different path) and preserves foreign hooks', () => {
  const p = tmpSettings({
    hooks: {
      SessionEnd: [
        { hooks: [{ type: 'command', command: 'node /old/path/vibe-history-capture.cjs' }] },
        { hooks: [{ type: 'command', command: 'echo keep-me' }] }
      ]
    }
  });
  run(p);
  const se = commandsOf(p, 'SessionEnd');
  assert.ok(se.includes('echo keep-me'), 'foreign hook preserved');
  assert.ok(!se.some(c => c.includes('/old/path/')), 'stale vibe-history hook removed');
  assert.strictEqual(se.filter(c => c.includes('vibe-history-capture.cjs')).length, 1, 'exactly one vibe-history hook');
});

test('is idempotent across repeated runs (no duplicate)', () => {
  const p = tmpSettings({ hooks: {} });
  run(p); run(p); run(p);
  assert.strictEqual(commandsOf(p, 'SessionEnd').filter(c => c === CMD).length, 1);
  assert.strictEqual(commandsOf(p, 'PreCompact').filter(c => c === CMD).length, 1);
});
