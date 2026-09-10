# vibe-history

Auto-capture engine that turns **Claude Code**, **Codex CLI**, and
**Antigravity** sessions into readable, scan-friendly Markdown digests — one
file per session — so past work can be recalled later without rereading raw
transcripts.

Claude, Codex, and Antigravity are supported **independently**: install for
any one alone, or all three. This repo holds the **engine only**; the capture
output (your session history) is stored in a folder you choose and is never
committed.

## Install (one step)

| OS | One-step |
|---|---|
| macOS | double-click **`install.command`**, or `./install.sh` |
| Linux | `./install.sh` |
| Windows | double-click **`install.cmd`**, or `powershell -ExecutionPolicy Bypass -File install.ps1` |

Needs Node.js on PATH. The installer:
- asks where to store history (default `~/Documents/vibe-history`, resolved
  per-OS — `C:\Users\…\Documents\vibe-history` on Windows);
- auto-detects Claude Code (`~/.claude`), Codex CLI (`~/.codex`), and
  Antigravity (`~/.gemini/config`) and wires whichever are present — any one
  alone is fine;
- writes config to a canonical per-user path (see [Configure](#configure)), not
  inside this folder;
- backs up any file before editing it, and **never deletes without asking**.

**Safe on a machine that already has vibe-history:**
- Claude hooks use **replace** semantics — a prior vibe-history hook (even at an
  old path) is removed before adding the current one, so re-running never
  double-captures. Foreign hooks are left alone.
- If a previous history folder is found, you're offered to **migrate** it
  (merge-copy; originals kept).
- A Codex `notify` owned by another tool (e.g. a computer-use client) is never
  overwritten — the installer prints how to chain into it.
- Antigravity's `Stop` hook is wired under its own `vibe-history` key in
  `~/.gemini/config/hooks.json`, so any other key (e.g. `orca-status`) is left
  untouched.

Keep this folder where it is after installing (the wiring points at these paths).
Re-run the installer if you move it or change the history folder.

## What it does

- Fires on session end / compact (Claude), per turn-ended (Codex), and on
  `Stop` (Antigravity).
- Writes `<historyRoot>/<project>/YYMMDD-HHMM-<id8>.md` (local time — the
  machine's timezone by default, or `timezone` in config; stable filename per
  session → re-captures overwrite in place).
- Keeps conversation text + thinking, inlines subagent turns, drops tool/system
  noise. Deterministic YAML frontmatter from the hook; semantic fields
  (title/summary/type/outcome/…) filled by a separate enrich step. A
  `source: claude|codex|antigravity` field records the origin agent.
- Optional recall layer: a qmd wrapper (BM25 + vector + hybrid) searches the
  store by meaning, not just keywords.

## Layout

```
install.sh / install.command   One-step installer — macOS/Linux (+ Finder click)
install.ps1 / install.cmd      One-step installer — Windows (+ double-click)
config.example.json            Shape of the config.json the installer writes
core/                          Shared engine (agent-agnostic)
  vibe-history-config.cjs        Runtime config: historyRoot / enabled / timezone
  vibe-history-project-utils.cjs Project name / filename / timezone helpers
  vibe-history-markdown-builder.cjs  Claude parser + shared renderDigest/frontmatter
  vibe-history-codex-parser.cjs  Codex rollout parser (both TUI + exec schemas)
  vibe-history-antigravity-parser.cjs  Antigravity transcript.jsonl parser
  vibe-history-backfill-runner.cjs   Backfill core
  vibe-history-qmd-cli.cjs       qmd search wrapper (index/embed/search/vsearch)
  hook-logger.cjs                Self-contained hook telemetry
  __tests__/                     node:test suites
claude/                        Claude Code entrypoints (require ../core)
  vibe-history-capture.cjs       SessionEnd / PreCompact / ManualDone hook
  vibe-history-backfill.cjs      One-time backfill of prior sessions
  vibe-history-migrate-filenames.cjs
  __tests__/
codex/                         Codex CLI entrypoints (require ../core; no Claude needed)
  codex-vibe-history-capture.cjs Reads ~/.codex rollout files
  codex-vibe-history-notify.cjs  notify dispatcher → fires capture
antigravity/                  Antigravity entrypoints (require ../core; no Claude needed)
  antigravity-vibe-history-capture.cjs  Reads ~/.gemini/antigravity/brain transcript.jsonl
  antigravity-vibe-history-notify.cjs   Stop-hook dispatcher → fires capture
skills/                        Store-level, agent-agnostic
  vibe-history-enrich/           scan/merge/classify + _config.cjs (root resolver)
  vibe-history-search/
docs/vibe-history-system-guide.md
scripts/merge-claude-settings.cjs      Installer helper (replace-semantics settings merge)
scripts/merge-antigravity-hooks.cjs    Installer helper (replace-semantics hooks.json merge)
```

## Configure

Config lives at a canonical per-user path (written by the installer), so it is
independent of where this folder sits and is read by both the engine and the
enrich skill:

- macOS / Linux: `$XDG_CONFIG_HOME/vibe-history/config.json` (default `~/.config/…`)
- Windows: `%APPDATA%\vibe-history\config.json`

```json
{ "historyRoot": "/path/to/vibe-history", "enabled": true, "timezone": "Asia/Ho_Chi_Minh" }
```

- **History folder:** edit `historyRoot`, or set `$VIBE_HISTORY_ROOT` (env wins).
- **Pause capture:** set `"enabled": false` (or `$VIBE_HISTORY_ENABLED=false`).
- **Timezone** (filename/date stamps): `timezone`, or `$VIBE_HISTORY_TZ`; defaults
  to the machine's local timezone.

`$VIBE_HISTORY_CONFIG` overrides the config file path.

## Manual wiring (if you skip the installer)

- **Claude Code** — register `SessionEnd` + `PreCompact` in `~/.claude/settings.json`
  to run `node <base>/claude/vibe-history-capture.cjs`; put skills in `~/.claude/skills/`.
- **Codex CLI** — set `~/.codex/config.toml`
  `notify = ["<node>", "<base>/codex/codex-vibe-history-notify.cjs"]` (or forward
  to it via another notifier's `--previous-notify`).
- **Antigravity** — add a `vibe-history` key to `~/.gemini/config/hooks.json`:
  `{"vibe-history":{"Stop":[{"type":"command","command":"<node> <base>/antigravity/antigravity-vibe-history-notify.cjs","timeout":10}]}}`
  (leave other keys, e.g. `orca-status`, untouched).

## Test

```bash
node --test core/__tests__/*.test.cjs claude/__tests__/*.test.cjs scripts/__tests__/*.test.cjs
```

Full verification runbook (safe installer dry-runs, real end-to-end capture,
per-OS checks): [`docs/testing.md`](docs/testing.md).

## Notes

- Capture does **no secret scrubbing** by design (local-only assumption). Keep
  your history folder private — never publish it.
- Codex reasoning is encrypted at rest, so Codex digests usually have no thinking
  blocks (a Codex limitation, not a capture defect).
