# vibe-history — System Guide

What vibe-history does, the concepts behind it (frontmatter, enrich, BM25,
vector/semantic search, QMD), and how to use it in practice. Written for anyone
who will operate or extend the system — no prior familiarity with search
terminology assumed.

> 🇻🇳 Vietnamese version: [`vibe-history-system-guide.vi.md`](vibe-history-system-guide.vi.md)

---

## 1. What vibe-history is

vibe-history automatically preserves your **Claude Code, Codex CLI, and
Antigravity** work sessions. When a session ends, a background hook reads the
raw transcript and writes a compact, readable Markdown file to
`<historyRoot>/<project>/` — `historyRoot` is the folder you pick at install
(see `config.json`; default `~/Documents/vibe-history`). All three agents
share one store, distinguished by a `source: claude|codex|antigravity` field.

The problem it solves: across many AI sessions and projects, the decisions and
bug fixes get buried inside hundreds of conversations that nobody re-reads.
vibe-history turns them into a **structured, searchable** knowledge base, so
later you can answer "how did I fix the Zoom login bug last time?" without
remembering or digging by hand.

Three layers run in sequence:

```
[1] CAPTURE  → hook saves each session as one Markdown file (automatic, no AI)
[2] ENRICH   → re-reads the full transcript to add semantic metadata (needs AI)
[3] SEARCH   → indexes + searches all history (BM25 / vector / hybrid)
```

---

## 2. Architecture & tech stack

Source is split into `core/` (shared engine, agent-agnostic), `claude/`,
`codex/`, and `antigravity/` (per-agent entrypoints, each `require ../core`).
See the directory tree and the "which files belong to which agent" table in
`README.md`.

| Layer | Component | Tech | Location (repo) |
|---|---|---|---|
| Capture | Claude Code hook | Node.js (zero-dep) | `claude/vibe-history-capture.cjs` |
| Capture | Codex hook + notify | Node.js (zero-dep) | `codex/codex-vibe-history-capture.cjs`, `codex/codex-vibe-history-notify.cjs` |
| Capture | Antigravity hook + notify | Node.js (zero-dep) | `antigravity/antigravity-vibe-history-capture.cjs`, `antigravity/antigravity-vibe-history-notify.cjs` |
| Capture | Shared parser + builder | Node.js | `core/vibe-history-markdown-builder.cjs`, `core/vibe-history-codex-parser.cjs`, `core/vibe-history-antigravity-parser.cjs` |
| Capture | Backfill (import old sessions) | Node.js | `core/vibe-history-backfill-runner.cjs` |
| Config | historyRoot + kill-switch + tz | Node.js + `config.json` | `core/vibe-history-config.cjs` |
| Enrich | scan/merge/classify skill | Node.js (zero-dep) | `skills/vibe-history-enrich/` |
| Search | qmd wrapper CLI | Node.js (zero-dep) | `core/vibe-history-qmd-cli.cjs` |
| Search | Search engine | QMD (`@tobilu/qmd`) + SQLite + GGUF model | `qmd` on PATH, index `~/.cache/qmd/index.sqlite` |
| Storage | Data store | Plain Markdown files | `<historyRoot>/<project>/*.md` |

Guiding principle: **the data is plain Markdown** — no proprietary database, no
lock-in. Readable by eye, by `grep`, by any editor. The upper layers (enrich,
search) are only helpers that read/write those same files.

**Install:** run `./install.sh` (macOS/Linux) or `install.ps1` / `install.cmd`
(Windows), or double-click `install.command` on macOS. The installer detects
Claude Code, Codex, and/or Antigravity, asks for the history folder, writes
`config.json`, and wires whichever agent is present. See `README.md`.

---

## 3. Layer 1 — Capture

### 3.1 When it runs

**Claude Code** — `claude/vibe-history-capture.cjs` is registered in
`~/.claude/settings.json` on two events:

- **SessionEnd** — when the session ends (window close, `/clear`, exit). The
  "official" capture.
- **PreCompact** — right before Claude Code compacts a long conversation.
  Capturing here avoids losing the earlier part before it is compacted.

Also `Backfill` (importing old sessions already under `~/.claude/projects/`)
can fire a capture manually.

**Codex CLI** — `codex/codex-vibe-history-notify.cjs` is invoked via `notify` in
`~/.codex/config.toml` after **each turn** (turn-ended); it captures the newest
rollout (`~/.codex/sessions/**/rollout-*.jsonl`). If another tool owns `notify`
(e.g. a computer-use client), let it forward here via `--previous-notify`.
Codex runs **standalone — Claude Code is not required**.

> **Codex has two rollout shapes**, handled transparently by the parser: the
> interactive TUI (0.149.x and pre-0.147) emits content as
> `event_msg → item_completed → item` (UserMessage/AgentMessage/Reasoning/
> FileChange); non-interactive `exec` (0.147.x) uses flat `event_msg`
> `user_message` / `agent_message` + `patch_apply_end`. The engine reads both.

**Antigravity** — `antigravity/antigravity-vibe-history-notify.cjs` is
registered under its own `vibe-history` key in `~/.gemini/config/hooks.json`
(sitting alongside, and never touching, any other key such as `orca-status`),
firing on `Stop`. It reads the conversation's `transcript.jsonl` under
`~/.gemini/antigravity/brain/<conversation>/.system_generated/logs/` (path
passed by the hook payload, or auto-resolved to the newest-mtime one if
called with an empty path — e.g. manually). Antigravity also runs
**standalone**.

**Kill-switch:** set `"enabled": false` in `config.json` (or
`VIBE_HISTORY_ENABLED=false`) to pause capture for all three agents.

### 3.2 Fidelity kept on purpose

vibe-history deliberately keeps more than a plain summary:

- **Thinking blocks** — the AI's reasoning is kept inside `<details>`.
- **Subagent inlining** — when the main session delegates to a subagent, that
  subagent's whole conversation is inlined (recursively), not dropped.
- **Fail-open, always** — if the hook errors for any reason it exits silently
  and **never** breaks or blocks your working session.

*Codex note:* Codex reasoning is encrypted at rest (`encrypted_content` /
empty `summary`), so Codex digests usually have **no** thinking blocks — a
Codex limitation, not a capture defect.

### 3.3 Filenames

Each session produces one file named `YYMMDD-HHMM-<id8>.md`, e.g.
`260709-1615-830cba69.md`:

- `YYMMDD-HHMM` = session start date/time in the configured timezone (machine
  local by default, or `timezone` in config) → sorts chronologically, scans by
  eye easily.
- `<id8>` = first 8 chars of the session UUID → traces back to the raw
  transcript.

One session = one file. When the hook fires again (PreCompact then SessionEnd)
it **overwrites** that same file with the latest regeneration — not multiple
snapshots.

**Project folder** = the session's git repository name, taken from the **main
worktree** (via `git --git-common-dir`). So a session run inside a linked
worktree (e.g. an orca workspace `.../my-project/<worktree>`) is filed under
`my-project`, not the throwaway worktree folder. Non-git cwds fall back to the
directory basename.

---

## 4. Concept: Frontmatter & metadata

### 4.1 What frontmatter is

**Frontmatter** is a YAML block at the top of a Markdown file, between two `---`
lines. It holds **metadata** (data describing the file), separate from content:

```yaml
---
title: "Debug Zoom login (4700/invalid_client), switch to PKCE"
summary: "Removed a leaked hardcoded client secret; handled Zoom banning localhost…"
type: debug
outcome: partial
keywords: [zoom-api, oauth2, pkce, secret-leak]
project: "zoom-cli"
date: 2026-07-09
session_id: 830cba69-385e-4355-b6db-962341a8b09d
source: codex
enriched: true
---
```

Frontmatter lets tools (and people) understand a file **without reading all of
it** — a glance at the metadata says what the session was about and how it went.

### 4.2 Two kinds of fields: deterministic vs semantic

**Deterministic** (machine-derivable, no AI) — filled by the hook at capture:

- `project`, `date`, `session_id`, `source` (`claude`|`codex`|`antigravity`),
  `git_branch`, `changed_files`, `messages`, `created`, `last_activity`, `cwd`,
  `hook_event`.
- A heuristic `title` (usually the user's opening question).

**Semantic** (needs to understand content → needs AI) — filled later by Enrich:

- `title` (rewritten), `summary`, `type`, `outcome`, `keywords`, `decisions`,
  `lessons`, `insights`.

Why the split: **the hook runs headless — it can't call an LLM.** It does only
the mechanical part. The "understanding" part is a separate step (Enrich). The
`enriched: true/false` flag marks whether a file has been through it.

**Constrained enums** (for consistent search/filtering):

- `type` ∈ debug · feature · landing-page · cro · research · docs · setup ·
  content · data-processing · seo · planning · other
- `outcome` ∈ completed · partial · exploratory · blocked

### 4.3 The "overwrite erases enrichment" problem

Because the hook overwrites the whole file each firing, if Enrich runs between
two firings the later firing would **erase** the semantic fields. The builder
handles this with **merge-on-overwrite**: before overwriting it reads the old
frontmatter, keeps the existing semantic fields verbatim, then rewrites. So
enrichment is never lost on re-capture.

---

## 5. Layer 2 — Enrich (semantic metadata)

### 5.1 Goal

Fill the 8 semantic fields per session by **reading and understanding** the
content. This is the only step that needs AI (runs via a subagent inside Claude
Code — no separate API key).

### 5.2 Mandatory rule: read the WHOLE transcript

The most important point — and a lesson learned: **read the entire transcript,
never a "head + tail" digest.**

Reason: `decisions` / `lessons` / `insights` are scattered **through** the
session, not only in the opening question or the closing message. Reading just
the ends (cheaper) misses most of the knowledge and yields shallow, wrong
metadata. Real example: a session was mislabeled `data-processing` on a shallow
read; a full read showed it was actually `setup` (packaging/distribution), and a
key insight ("n8n debugging took 2h52m > CLI build 40m") appeared only mid-session.

### 5.3 Map-reduce for large files

Some transcripts are very long (5,000–7,500+ lines), beyond a single context
window. The solution is **map-reduce**:

- **Map**: split into windows (chunks), read each, extract signals (decisions,
  lessons) from that chunk.
- **Reduce**: merge signals from all chunks into one final metadata set.

Never truncate the transcript to "fit" the context. Quality over token cost.

### 5.4 Process & tools

The `vibe-history-enrich` skill has 3 zero-dependency Node scripts (plus
`_config.cjs`, which resolves the store root the same way the engine does):

- **`scan-unenriched.cjs`** — scan the store, list files not yet `enriched: true`
  (including old shallowly-enriched ones).
- **`merge-frontmatter.cjs`** — take the AI result (JSON), write the 8 semantic
  fields + `enriched: true`, keeping the file body **byte-identical**. Multiple
  safety layers: UUID cross-check (no wrong-file writes), structural frontmatter
  validation, body-unchanged check, backup before writing.
- **`classify-projects.cjs`** — group files by folder, roughly rank projects
  (REAL / GRAY / THROWAWAY) by session count + time span, for the AI to refine
  into 4 labels (real-project / one-off-task / scratch-test / reference-learning).

Flow: `scan` → split files across ≤6 subagents reading full transcripts in
parallel → each emits JSON → `merge` → re-check. Re-running is safe (idempotent):
already-enriched files are skipped, no repeated AI cost.

---

## 6. Concept: Search

Concepts first, then how QMD uses them.

### 6.1 Full-text search & BM25

**Full-text search** = find by keywords appearing in the text. Core question:
for a query, which document is **most relevant**?

**BM25** is the classic ranking formula for this ("Best Matching 25"). It scores
each document by:

- **Term frequency** — more query-term occurrences score higher, but with
  **diminishing returns** (10 hits aren't worth 10× one hit — avoids keyword
  spam).
- **Term rarity** — a term rare across the whole store (like `invalid_client`)
  carries more information than a common one (`the`, `and`) and is weighted higher.
- **Document length** — normalized so long documents don't win just for
  containing more words.

BM25 is **fast, needs no AI/model**, runs instantly. Downside: it matches
**surface words**, not meaning. Searching "login error" won't match a doc that
says "authentication failure" without a shared word.

This is why **enrich matters for search**: once frontmatter has
`keywords: [zoom-api, oauth2, pkce]` and a clear `summary`, BM25 has the right
words to match → real-world relevance hits 92–96% on real queries.

### 6.2 Vector embeddings & semantic search

**Semantic search** = find by **meaning**, not surface words. To do that, each
chunk of text becomes a **vector embedding** — a list of numbers (a few hundred
dimensions) representing the chunk's "meaning", produced by a language model. Key
point: **two chunks with close meaning → two close vectors** in that number
space, even with different words.

At query time the query is turned into a vector too, and the system finds the
documents with the **nearest** vectors (by distance/cosine). So "fix the login"
can match a doc that says "authentication failure" — close meaning, different words.

Trade-off: needs an **embedding model** (here embeddinggemma-300M, ~330MB first
download) and must **pre-compute vectors for every document** (the `embed` step,
run once, CPU-heavy). In return you get meaning-based recall.

### 6.3 Hybrid search (query expansion + reranking)

**Hybrid** = combine both to cover each other's weaknesses, usually the best
result. QMD's `query` adds two steps:

- **Query expansion** — broaden the query with related terms/phrasings (from a
  small model) to catch documents using different words.
- **Reranking** — after gathering candidates (from BM25 + vector), a **rerank**
  model re-reads each (query, document) pair and re-orders by true relevance,
  pushing the best to the top.

### 6.4 What QMD is

**QMD** ("Quick Markdown Search", npm `@tobilu/qmd`) is a CLI bundling all three
search modes, specialized for **Markdown stores**:

- **Indexes** `.md` files into a SQLite database (`~/.cache/qmd/index.sqlite`),
  reading frontmatter too.
- Provides `search` (BM25), `vsearch` (vector), `query` (hybrid).
- Runs entirely **locally** (GGUF model on-device, no external API).

A QMD "collection" is an indexed directory. vibe-history registers the whole
store as a collection named `vibe-history` (pattern `**/*.md`).

*Technical note:* QMD must run under Node (`QMD_RUNTIME=node`) — its native
`better-sqlite3` crashes under Bun. The CLI wrapper sets this automatically.

---

## 7. Layer 3 — Search (in practice)

The zero-dep wrapper (`core/vibe-history-qmd-cli.cjs`) wraps QMD, scopes it to
the `vibe-history` collection, auto-locates qmd (cross-platform: `which`/`where`
+ known install dirs), and forces `QMD_RUNTIME=node`.

```bash
node core/vibe-history-qmd-cli.cjs <command>
```

| Command | Does | Model? |
|---|---|---|
| `search "<q>" [-n N]` | BM25 full-text, instant | No |
| `vsearch "<q>" [-n N]` | Vector / semantic | Yes (`embed` first) |
| `query "<q>" [-n N]` | Hybrid expand + rerank | Yes (`embed` first) |
| `index` | Re-index after new sessions / enrich | No |
| `embed` | Build vectors (once, ~330MB model download) | — |
| `status` | Index + collection status | No |

Results print `qmd://vibe-history/<project>/<file>.md`, title, score %, and the
matching frontmatter snippet. Open the real file for detail. You can also invoke
it through the **`vibe-history-search` skill** inside Claude Code.

**Keep the index fresh:** new sessions are saved by the hook but **not
auto-indexed**. After a batch of new sessions or enrich, run `index` (fast, BM25
ready immediately) and `embed` (only if you need vsearch/query). This is
intentional — no auto-reindex, to keep the system simple.

---

## 8. Real use cases

1. **Recall an old fix** — "How did I fix the Zoom login bug?"
   → `search "zoom oauth login invalid_client"` → the debug session, read its
   `decisions`/`lessons` for the approach + the trap you hit.

2. **Avoid redoing work** — before building a feature, check if you touched it
   before: `search "flashsale countdown sapo"` → an old session that already
   built `<countdown-timer>` → reuse instead of rewriting.

3. **Fuzzy recall** (don't remember exact keywords) —
   `query "how to sync customer data across systems"` → hybrid finds by meaning,
   surfacing Bitrix24/Lark migration sessions even without matching words.

4. **Cross-project knowledge** — filter `type: debug` + read `lessons` across
   many sessions to distill recurring traps (e.g. Sapo/DotLiquid quirks) into a
   checklist.

5. **Project inventory & cleanup** — the classification report groups folders
   into real-project / one-off / scratch-test / reference, suggesting what to
   archive/delete (suggests only, never deletes).

6. **Handover / review** — quickly open the frontmatter of a project's sessions
   to recover progress, settled decisions, and unfinished work (`outcome:
   partial/blocked`).

---

## 9. Ops cheat sheet

Paths are relative to the repo folder (where you installed). The enrich skill lives
at `skills/vibe-history-enrich/` (copied to `~/.claude/skills/` on install).

```bash
# --- Search ---
CLI=core/vibe-history-qmd-cli.cjs
node $CLI search "telegram sync churn" -n 5      # fast, surface words
node $CLI query  "membership permissions"        # meaning (needs embed done)
node $CLI status                                 # inspect index

# --- Refresh index after new sessions / enrich ---
node $CLI index                                  # BM25 ready immediately
node $CLI embed                                  # update vectors (backgroundable)

# --- Enrich sessions lacking semantic metadata ---
node skills/vibe-history-enrich/scripts/scan-unenriched.cjs --project <name>
# → use the vibe-history-enrich skill for the full flow (full read → merge)

# --- Import old, never-captured sessions (Claude Code) ---
node claude/vibe-history-backfill.cjs
```

---

## 10. Limitations & open questions

- **Index isn't auto-fresh** — run `index`/`embed` manually after new sessions.
  Intentional (YAGNI). A lightweight auto-reindex could be added later.
- **Collection includes `docs/` and `plans/`** — the `**/*.md` pattern indexes
  these meta files too, adding minor noise to search. Acceptable for now.
- **Enrich costs AI** — it reads full transcripts via subagents, so it's
  token-heavy; typically only selected projects are enriched, the rest left as
  backlog.
- **No secret-scrubbing** — transcripts may contain sensitive data; the store is
  local files with no secret filter before saving (a design decision). So **keep
  the history folder private — never publish it**.
- **`embed` depends on a downloaded model** — first run needs ~330MB and CPU to
  vectorize; slow on weak machines.
