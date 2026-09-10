'use strict';

/**
 * merge-claude-settings.cjs — installer helper.
 *
 * Registers the vibe-history capture command on Claude Code's SessionEnd +
 * PreCompact hooks in ~/.claude/settings.json with REPLACE semantics: any prior
 * vibe-history-capture hook (including one pointing at an old install path) is
 * removed first, then the current command is added exactly once. This makes
 * re-install / migration idempotent and prevents double-capture. Other hooks the
 * user has are left untouched.
 *
 * Usage: node merge-claude-settings.cjs <settings.json path> <command string>
 */

const fs = require('fs');

const settingsPath = process.argv[2];
const command = process.argv[3];
if (!settingsPath || !command) {
  console.error('usage: merge-claude-settings.cjs <settings-path> <command>');
  process.exit(2);
}

let settings = {};
try {
  const raw = fs.readFileSync(settingsPath, 'utf8').trim();
  if (raw) settings = JSON.parse(raw);
} catch (_) {
  settings = {}; // missing/empty/corrupt → start fresh (backup is taken by install.sh)
}

if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

// Matches any vibe-history capture command (current or a stale/old-path one) so
// prior installs are cleaned out rather than stacked.
const isVibeHistoryHook = (h) =>
  h && typeof h.command === 'string' && /vibe-history-capture\.cjs/.test(h.command);

/** Strip prior vibe-history hooks from one event, then add the current command once. */
function replaceHook(event) {
  let groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  // Drop our command from every group; drop groups left empty.
  groups = groups
    .map(g => {
      if (!g || !Array.isArray(g.hooks)) return g;
      return { ...g, hooks: g.hooks.filter(h => !isVibeHistoryHook(h)) };
    })
    .filter(g => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
  groups.push({ hooks: [{ type: 'command', command }] });
  settings.hooks[event] = groups;
}

replaceHook('SessionEnd');
replaceHook('PreCompact');

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log('ok');
