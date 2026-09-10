# vibe-history installer (Windows, PowerShell).  macOS/Linux: use install.sh.
#
# Installs the engine IN PLACE and wires whichever of Claude Code / Codex CLI /
# Antigravity are present. Safe to re-run and on a machine with an older
# install: hooks use REPLACE semantics (old vibe-history hooks removed, not
# stacked, foreign keys/hooks left alone); config goes to a canonical per-user
# path; a prior history folder can be migrated. Files are backed up before
# editing.
#
# Run:  powershell -ExecutionPolicy Bypass -File install.ps1
#       (or double-click install.cmd)

$ErrorActionPreference = 'Stop'
$Base = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m){ Write-Host $m }
function Ok($m){ Write-Host "[ok] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[!] $m" -ForegroundColor Yellow }
function Err($m){ Write-Host "[x] $m" -ForegroundColor Red }
function Backup($p){ if(Test-Path -LiteralPath $p){ $b="$p.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"; Copy-Item -LiteralPath $p $b; Say "  backup: $b" } }

Say "vibe-history installer (Windows)"
Say "engine: $Base"
Say ""

# --- 1. node ---
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if(-not $NodeCmd){ Err "Node.js not found on PATH. Install Node then re-run."; exit 1 }
$Node = $NodeCmd.Source
Ok "node: $Node ($(& $Node --version))"

# --- 2. canonical config + prior install ---
$ConfigDir = Join-Path $env:APPDATA 'vibe-history'
$Config = Join-Path $ConfigDir 'config.json'
$PriorRoot = ''
if(Test-Path -LiteralPath $Config){
  try { $PriorRoot = (Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json).historyRoot } catch {}
}

# --- 3. history folder ---
$DefaultRoot = if($PriorRoot){ $PriorRoot } else { Join-Path $HOME 'Documents\vibe-history' }
Say ""
Say "Where should session history be stored?"
if($PriorRoot){ Say "  (previous install used: $PriorRoot)" }
$HistoryRoot = Read-Host "  [enter = $DefaultRoot]"
if([string]::IsNullOrWhiteSpace($HistoryRoot)){ $HistoryRoot = $DefaultRoot }
New-Item -ItemType Directory -Force -Path $HistoryRoot | Out-Null
Ok "history root: $HistoryRoot"

# --- 3b. optional migration ---
if($PriorRoot -and ($PriorRoot -ne $HistoryRoot) -and (Test-Path -LiteralPath $PriorRoot)){
  Say ""
  Warn "A previous history folder exists at: $PriorRoot"
  $a = Read-Host "  Copy its contents into the new location (merge, originals kept)? [y/N]"
  if($a -match '^[Yy]'){
    Copy-Item -Path (Join-Path $PriorRoot '*') -Destination $HistoryRoot -Recurse -Force -ErrorAction SilentlyContinue
    Ok "copied existing history -> $HistoryRoot (old copy left in place)"
  } else { Say "  skipped - history stays split between the two folders." }
}

# --- 4. write canonical config.json ---
# Delegate to node: guaranteed-valid JSON, no BOM, merges existing keys. Avoids
# PowerShell 5.1 gaps (ConvertFrom-Json -AsHashtable) and BOM from Set-Content.
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
Backup $Config
& $Node -e @'
const fs=require("fs");
let cur={}; try{cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(_){}
cur.historyRoot=process.argv[2]; if(cur.enabled===undefined)cur.enabled=true;
fs.writeFileSync(process.argv[1], JSON.stringify(cur,null,2)+"\n");
'@ $Config $HistoryRoot
Ok "wrote $Config"

$ClaudeDone=$false; $CodexDone=$false; $AntigravityDone=$false

# --- 5. Claude Code ---
$ClaudeDir = Join-Path $HOME '.claude'
if(Test-Path -LiteralPath $ClaudeDir){
  Say ""; Say "Claude Code detected"
  $Settings = Join-Path $ClaudeDir 'settings.json'
  $Capture = Join-Path $Base 'claude\vibe-history-capture.cjs'
  $Cmd = '"' + $Node + '" "' + $Capture + '"'
  Backup $Settings
  & $Node (Join-Path $Base 'scripts\merge-claude-settings.cjs') $Settings $Cmd | Out-Null
  Ok "wired SessionEnd + PreCompact (replaced any old vibe-history hook) -> $Settings"
  $SkillsDst = Join-Path $ClaudeDir 'skills'
  New-Item -ItemType Directory -Force -Path $SkillsDst | Out-Null
  Copy-Item -Path (Join-Path $Base 'skills\vibe-history-enrich') -Destination $SkillsDst -Recurse -Force
  Copy-Item -Path (Join-Path $Base 'skills\vibe-history-search') -Destination $SkillsDst -Recurse -Force
  Ok "installed skills -> $SkillsDst"
  $ClaudeDone=$true
} else { Warn "Claude Code (~/.claude) not found - skipping." }

# --- 6. Codex CLI ---
$CodexDir = Join-Path $HOME '.codex'
if(Test-Path -LiteralPath $CodexDir){
  Say ""; Say "Codex CLI detected"
  $ConfigToml = Join-Path $CodexDir 'config.toml'
  $NotifyTarget = Join-Path $Base 'codex\codex-vibe-history-notify.cjs'
  # TOML literal (single-quoted) strings avoid backslash escaping on Windows.
  $NotifyLine = "notify = ['$Node', '$NotifyTarget']"
  $content = if(Test-Path -LiteralPath $ConfigToml){ [IO.File]::ReadAllText($ConfigToml) } else { '' }
  if($content -match '(?m)^\s*notify\s*='){
    if($content.Contains($NotifyTarget)){
      Ok "notify already points at this install - unchanged."
    } elseif(($content -match 'codex-vibe-history-notify\.cjs') -and ($content -notmatch '--previous-notify')){
      Backup $ConfigToml
      $lines = $content -split "`r?`n" | ForEach-Object { if($_ -match '^\s*notify\s*='){ $NotifyLine } else { $_ } }
      [IO.File]::WriteAllText($ConfigToml, ($lines -join "`n"))
      Ok "repointed old notify -> this install"
    } else {
      Warn "config.toml already has a 'notify' owned by another tool - not touching it."
      Say  "  Point that notify (or its --previous-notify) at:"
      Say  "    $NotifyTarget"
    }
  } else {
    Backup $ConfigToml
    $sep = if($content -and -not $content.EndsWith("`n")){ "`n" } else { '' }
    [IO.File]::WriteAllText($ConfigToml, $content + $sep + $NotifyLine + "`n")
    Ok "added notify -> $ConfigToml"
  }
  $CodexDone=$true
} else { Warn "Codex CLI (~/.codex) not found - skipping." }

# --- 7. Antigravity ---
$GeminiConfigDir = Join-Path $HOME '.gemini\config'
if(Test-Path -LiteralPath $GeminiConfigDir){
  Say ""; Say "Antigravity detected"
  $SkillsDst = Join-Path $GeminiConfigDir 'skills'
  New-Item -ItemType Directory -Force -Path $SkillsDst | Out-Null
  Copy-Item -Path (Join-Path $Base 'skills\vibe-history-enrich') -Destination $SkillsDst -Recurse -Force
  Copy-Item -Path (Join-Path $Base 'skills\vibe-history-search') -Destination $SkillsDst -Recurse -Force
  Ok "installed skills -> $SkillsDst"

  $HooksJson = Join-Path $GeminiConfigDir 'hooks.json'
  Backup $HooksJson
  $NotifyTarget = Join-Path $Base 'antigravity\antigravity-vibe-history-notify.cjs'
  $NotifyCmd = '"' + $Node + '" "' + $NotifyTarget + '"'
  & $Node (Join-Path $Base 'scripts\merge-antigravity-hooks.cjs') $HooksJson $NotifyCmd | Out-Null
  Ok "wired Stop hook under 'vibe-history' key (other keys, e.g. orca-status, untouched) -> $HooksJson"
  $AntigravityDone=$true
} else { Warn "Antigravity (~/.gemini/config) not found - skipping." }

# --- 8. summary ---
Say ""
if(-not $ClaudeDone -and -not $CodexDone -and -not $AntigravityDone){ Err "Neither Claude Code, Codex CLI, nor Antigravity found. Nothing was wired."; exit 1 }
Ok "Done."
Say "History will be captured to: $HistoryRoot"
if($ClaudeDone){ Say "  - Claude Code: restart Claude / start a new session to load the hooks." }
if($CodexDone){ Say "  - Codex CLI: new sessions capture on each turn." }
if($AntigravityDone){ Say "  - Antigravity: restart / start a new conversation to load the hooks." }
Say ""
Say "Config: $Config  (historyRoot / enabled / timezone). Keep this folder where it is."
