'use strict';

/**
 * Shared config resolver for the vibe-history enrich scripts (Node).
 *
 * Mirrors core/vibe-history-config.cjs so the skill agrees with the engine on
 * the capture store root, while staying SELF-CONTAINED (the skill is installed
 * to ~/.claude/skills/ separately from the engine, so it can't require ../core).
 *
 * Resolution (first hit wins):
 *   $VIBE_HISTORY_ROOT  →  config.json .historyRoot  →  ~/Documents/vibe-history
 *
 * Config path (canonical, per-user; overridable with $VIBE_HISTORY_CONFIG):
 *   macOS / Linux : $XDG_CONFIG_HOME/vibe-history/config.json  (default ~/.config/…)
 *   Windows       : %APPDATA%\vibe-history\config.json
 *
 * All reads are best-effort — a missing/malformed config never throws.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function userConfigDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function configPath() {
  const override = process.env.VIBE_HISTORY_CONFIG;
  if (override && override.trim()) return override.trim();
  return path.join(userConfigDir(), 'vibe-history', 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

/** Resolve the capture store root: env → config.json → ~/Documents/vibe-history. */
function defaultHistoryRoot() {
  const env = process.env.VIBE_HISTORY_ROOT;
  if (env && env.trim()) return env.trim();
  const root = readConfig().historyRoot;
  if (root && String(root).trim()) return String(root).trim();
  return path.join(os.homedir(), 'Documents', 'vibe-history');
}

module.exports = { defaultHistoryRoot, configPath };
