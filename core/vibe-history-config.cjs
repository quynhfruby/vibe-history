'use strict';

/**
 * vibe-history-config.cjs
 *
 * Single source of runtime configuration for the vibe-history engine, shared by
 * the Claude and Codex capture paths (and mirrored by the Python skills in
 * skills/vibe-history-enrich/scripts/_config.cjs — keep the two in sync).
 *
 * Config lives at a canonical PER-USER path (not inside the repo), so it is
 * independent of where the engine folder sits and is readable by every
 * component:
 *   macOS / Linux : $XDG_CONFIG_HOME/vibe-history/config.json
 *                   (default ~/.config/vibe-history/config.json)
 *   Windows       : %APPDATA%\vibe-history\config.json
 * $VIBE_HISTORY_CONFIG overrides the path (used by tests and power users).
 *
 * Resolution (first hit wins):
 *   historyRoot: $VIBE_HISTORY_ROOT → config.historyRoot → default (~/Documents/vibe-history)
 *   enabled:     $VIBE_HISTORY_ENABLED=false → config.enabled===false → enabled
 *   timezone:    $VIBE_HISTORY_TZ → config.timezone → machine local TZ → UTC
 *
 * All reads are best-effort: a missing/malformed config never throws — the
 * capture path must stay fail-open.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_BASE = path.join(__dirname, '..');

/** Per-user config directory, cross-platform. */
function userConfigDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

const CONFIG_PATH = (process.env.VIBE_HISTORY_CONFIG && process.env.VIBE_HISTORY_CONFIG.trim())
  || path.join(userConfigDir(), 'vibe-history', 'config.json');

// Cross-platform default: <home>/Documents/vibe-history on every OS.
const DEFAULT_HISTORY_ROOT = path.join(os.homedir(), 'Documents', 'vibe-history');

/** Parse config.json, or {} when absent/unreadable/malformed. */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

/** Absolute path to the capture store root. */
function getHistoryRoot() {
  const env = process.env.VIBE_HISTORY_ROOT;
  if (env && env.trim()) return env.trim();
  const cfg = readConfig();
  if (cfg.historyRoot && String(cfg.historyRoot).trim()) return String(cfg.historyRoot).trim();
  return DEFAULT_HISTORY_ROOT;
}

/** Kill-switch: false disables capture (both agents). Defaults to enabled. */
function isEnabled() {
  if (process.env.VIBE_HISTORY_ENABLED === 'false') return false;
  return readConfig().enabled !== false;
}

/**
 * IANA timezone used for filename/frontmatter date+time stamping.
 * $VIBE_HISTORY_TZ → config.json .timezone → the machine's local timezone.
 * Falls back to UTC if the runtime can't report one.
 */
function getTimezone() {
  const env = process.env.VIBE_HISTORY_TZ;
  if (env && env.trim()) return env.trim();
  const cfg = readConfig();
  if (cfg.timezone && String(cfg.timezone).trim()) return String(cfg.timezone).trim();
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch (_) { /* fall through */ }
  return 'UTC';
}

module.exports = {
  getHistoryRoot,
  isEnabled,
  getTimezone,
  readConfig,
  userConfigDir,
  CONFIG_PATH,
  ENGINE_BASE,
  DEFAULT_HISTORY_ROOT
};
