#!/usr/bin/env bash
#
# vibe-history installer (macOS / Linux).  Windows: use install.ps1.
#
# Installs the session-capture engine IN PLACE (this folder becomes the engine)
# and wires whichever of Claude Code / Codex CLI are present — either alone is
# fine. Safe to re-run and safe on a machine that already has an older install:
#   • Claude hooks use REPLACE semantics (old vibe-history hooks are removed, not
#     stacked), so re-running never causes double-capture.
#   • Config is written to a canonical per-user path, independent of this folder.
#   • If a previous history folder is found, you're offered to migrate it.
# Every file is backed up before it is edited. Nothing is deleted without asking.
#
# Run:  ./install.sh        (or double-click install.command on macOS)
#
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$RST" "$*"; }
err()  { printf '%s✗%s %s\n' "$RED" "$RST" "$*" >&2; }
ts()   { date +%Y%m%d-%H%M%S; }
backup() { if [ -f "$1" ]; then local b="$1.bak.$(ts)"; cp "$1" "$b"; say "  ${DIM}backup: $b${RST}"; fi; return 0; }
ask() { # ask "question" "default(y/n)" -> returns 0 for yes
  local q="$1" def="${2:-n}" ans
  printf '%s [%s]: ' "$q" "$([ "$def" = y ] && echo Y/n || echo y/N)"
  read -r ans || true; ans="${ans:-$def}"
  case "$ans" in [Yy]*) return 0;; *) return 1;; esac
}

say "${BOLD}vibe-history installer${RST}"
say "${DIM}engine: $BASE${RST}"
say ""

# --- 1. node ----------------------------------------------------------------
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  err "Node.js not found on PATH. Install Node (e.g. 'brew install node') then re-run."
  exit 1
fi
ok "node: $NODE_BIN ($("$NODE_BIN" --version))"

# --- 2. canonical config path + prior install detection ---------------------
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/vibe-history"
CONFIG="$CONFIG_DIR/config.json"
PRIOR_ROOT=""
if [ -f "$CONFIG" ]; then
  PRIOR_ROOT="$("$NODE_BIN" -e 'try{process.stdout.write(String((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).historyRoot)||""))}catch(_){}' "$CONFIG")"
fi

# --- 3. history folder ------------------------------------------------------
DEFAULT_ROOT="${PRIOR_ROOT:-$HOME/Documents/vibe-history}"
say ""
printf "%sWhere should session history be stored?%s\n" "$BOLD" "$RST"
[ -n "$PRIOR_ROOT" ] && say "  ${DIM}(previous install used: $PRIOR_ROOT)${RST}"
printf "  [enter = %s]: " "$DEFAULT_ROOT"
read -r HISTORY_ROOT || true
HISTORY_ROOT="${HISTORY_ROOT:-$DEFAULT_ROOT}"
case "$HISTORY_ROOT" in "~"/*) HISTORY_ROOT="$HOME/${HISTORY_ROOT#\~/}";; "~") HISTORY_ROOT="$HOME";; esac
mkdir -p "$HISTORY_ROOT"
ok "history root: $HISTORY_ROOT"

# --- 3b. optional migration of an existing store ----------------------------
if [ -n "$PRIOR_ROOT" ] && [ "$PRIOR_ROOT" != "$HISTORY_ROOT" ] && [ -d "$PRIOR_ROOT" ]; then
  say ""
  warn "A previous history folder exists at: $PRIOR_ROOT"
  if ask "  Copy its contents into the new location (merge, originals kept)?" n; then
    cp -R "$PRIOR_ROOT"/. "$HISTORY_ROOT"/ 2>/dev/null || true
    ok "copied existing history → $HISTORY_ROOT (old copy left in place)"
  else
    say "  ${DIM}skipped — history stays split between the two folders.${RST}"
  fi
fi

# --- 4. write canonical config.json -----------------------------------------
mkdir -p "$CONFIG_DIR"
backup "$CONFIG"
"$NODE_BIN" -e '
  const fs=require("fs");
  let cur={}; try{cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(_){}
  cur.historyRoot=process.argv[2]; if(cur.enabled===undefined)cur.enabled=true;
  fs.writeFileSync(process.argv[1], JSON.stringify(cur,null,2)+"\n");
' "$CONFIG" "$HISTORY_ROOT"
ok "wrote $CONFIG"

CLAUDE_DONE=0; CODEX_DONE=0; ANTIGRAVITY_DONE=0

# --- 5. Claude Code ---------------------------------------------------------
if [ -d "$HOME/.claude" ]; then
  say ""
  say "${BOLD}Claude Code detected${RST}"
  SETTINGS="$HOME/.claude/settings.json"
  CMD="$NODE_BIN $BASE/claude/vibe-history-capture.cjs"
  backup "$SETTINGS"
  "$NODE_BIN" "$BASE/scripts/merge-claude-settings.cjs" "$SETTINGS" "$CMD" >/dev/null \
    && ok "wired SessionEnd + PreCompact (replaced any old vibe-history hook) → $SETTINGS"
  mkdir -p "$HOME/.claude/skills"
  cp -R "$BASE/skills/vibe-history-enrich" "$HOME/.claude/skills/" 2>/dev/null || true
  cp -R "$BASE/skills/vibe-history-search" "$HOME/.claude/skills/" 2>/dev/null || true
  ok "installed skills → ~/.claude/skills/ (vibe-history-enrich, vibe-history-search)"
  CLAUDE_DONE=1
else
  warn "Claude Code (~/.claude) not found — skipping."
fi

# --- 6. Codex CLI -----------------------------------------------------------
if [ -d "$HOME/.codex" ]; then
  say ""
  say "${BOLD}Codex CLI detected${RST}"
  CONFIG_TOML="$HOME/.codex/config.toml"
  NOTIFY_LINE="notify = [\"$NODE_BIN\", \"$BASE/codex/codex-vibe-history-notify.cjs\"]"
  NOTIFY_TARGET="$BASE/codex/codex-vibe-history-notify.cjs"
  if [ -f "$CONFIG_TOML" ] && grep -qE '^[[:space:]]*notify[[:space:]]*=' "$CONFIG_TOML"; then
    if grep -qF "$NOTIFY_TARGET" "$CONFIG_TOML"; then
      ok "notify already points at this install — unchanged."
    elif grep -q 'codex-vibe-history-notify.cjs' "$CONFIG_TOML" && ! grep -q -- '--previous-notify' "$CONFIG_TOML"; then
      # Direct notify to an OLD vibe-history script → safe to repoint.
      backup "$CONFIG_TOML"
      "$NODE_BIN" -e '
        const fs=require("fs");const [file,line]=process.argv.slice(1);
        const out=fs.readFileSync(file,"utf8").split(/\r?\n/)
          .map(l=>/^\s*notify\s*=/.test(l)?line:l).join("\n");
        fs.writeFileSync(file,out);
      ' "$CONFIG_TOML" "$NOTIFY_LINE"
      ok "repointed old notify → this install"
    else
      warn "config.toml already has a 'notify' owned by another tool — not touching it."
      say  "  To capture Codex here, point that notify (or its --previous-notify) at:"
      say  "    ${DIM}$NOTIFY_TARGET${RST}"
    fi
  else
    backup "$CONFIG_TOML"
    printf '%s\n' "$NOTIFY_LINE" >> "$CONFIG_TOML"
    ok "added notify → $CONFIG_TOML"
  fi
  CODEX_DONE=1
else
  warn "Codex CLI (~/.codex) not found — skipping."
fi

# --- 7. Antigravity ----------------------------------------------------------
if [ -d "$HOME/.gemini/config" ]; then
  say ""
  say "${BOLD}Antigravity detected${RST}"
  mkdir -p "$HOME/.gemini/config/skills"
  cp -R "$BASE/skills/vibe-history-enrich" "$HOME/.gemini/config/skills/" 2>/dev/null || true
  cp -R "$BASE/skills/vibe-history-search" "$HOME/.gemini/config/skills/" 2>/dev/null || true
  ok "installed skills → ~/.gemini/config/skills/ (vibe-history-enrich, vibe-history-search)"

  HOOKS_JSON="$HOME/.gemini/config/hooks.json"
  backup "$HOOKS_JSON"
  NOTIFY_CMD="$NODE_BIN $BASE/antigravity/antigravity-vibe-history-notify.cjs"
  "$NODE_BIN" "$BASE/scripts/merge-antigravity-hooks.cjs" "$HOOKS_JSON" "$NOTIFY_CMD" >/dev/null \
    && ok "wired Stop hook under 'vibe-history' key (other keys, e.g. orca-status, untouched) → $HOOKS_JSON"
  ANTIGRAVITY_DONE=1
else
  warn "Antigravity (~/.gemini/config) not found — skipping."
fi

# --- 8. summary -------------------------------------------------------------
say ""
if [ "$CLAUDE_DONE" = 0 ] && [ "$CODEX_DONE" = 0 ] && [ "$ANTIGRAVITY_DONE" = 0 ]; then
  err "Neither Claude Code, Codex CLI, nor Antigravity found. Nothing was wired."
  exit 1
fi
ok "${BOLD}Done.${RST}"
say "History will be captured to: ${BOLD}$HISTORY_ROOT${RST}"
[ "$CLAUDE_DONE" = 1 ] && say "  • Claude Code: restart Claude / start a new session to load the hooks."
[ "$CODEX_DONE" = 1 ]  && say "  • Codex CLI: new sessions capture on each turn."
[ "$ANTIGRAVITY_DONE" = 1 ] && say "  • Antigravity: restart / start a new conversation to load the hooks."
say ""
say "${DIM}Config: $CONFIG  (historyRoot / enabled / timezone). Keep this folder where it is.${RST}"
