---
name: vibe-history-enrich
description: >-
  Fill semantic frontmatter (title/summary/type/outcome/keywords/decisions/
  lessons/insights) on vibe-history session .md files by reading each FULL
  transcript, and classify project folders. Use when the user asks to enrich,
  backfill semantics, or tier/clean up vibe-history history.
---

# vibe-history-enrich

Semantic-enrich pass for the vibe-history capture store
(`<historyRoot>/<project>/<file>.md`).

The capture hook writes only *deterministic* frontmatter (provenance + a
heuristic title) and leaves the semantic slots empty (`enriched: false`).
This skill fills those slots, MERGING into the existing frontmatter — never
prepending, never touching the conversation body.

## Non-negotiable rule — read the FULL transcript

Author semantics from the **entire** conversation body, NOT a head+tail
digest. decisions / lessons / insights are scattered mid-session; the old
Task-5 digest approach was shallow and the user rejected it. For a large file
(5000-7500+ lines) that strains one context, **map-reduce**: chunk it (Read
with offset/limit), extract per chunk, consolidate — never truncate to fit.
Quality over token cost. (memory: `vibe-history-enrich-full-content`.)

## Semantic schema (must match the builder exactly)

`title` (override heuristic), `summary` (1-3 sentences), `type`, `outcome`,
`keywords` (inline list, ≤8 slugs), `decisions` / `lessons` / `insights`
(block lists, 0-5 short items each). Set `enriched: true`.

- `type` ∈ debug, feature, landing-page, cro, research, docs, setup, content,
  data-processing, seo, planning, other
- `outcome` ∈ completed, partial, exploratory, blocked

Legacy files carry `topics:` instead of `keywords:` — the merge drops
`topics` (fresh `keywords` from the full read supersede it).

## Scripts (`scripts/`, zero-dependency Node — run with `node`)

- **scan-unenriched.cjs** — list files where `enriched != true`, JSONL rows
  `{path, uuid, project, lines, schema, reason}`. Flags: `--project NAME`
  (repeatable), `--limit N`, `--include-enriched`, `--root`. Files with NO
  frontmatter are reported on stderr (they need Phase-2 backfill first, not
  enrich).
- **merge-frontmatter.cjs** — apply a results JSONL. Rewrites ONLY the
  frontmatter block: canonical semantic order + `enriched: true`,
  deterministic keys kept verbatim, body byte-identical. Guards: uuid
  cross-check, structural frontmatter validation, body-drift abort, per-file backup under
  `<root>/.enrich-backups/<ts>/`. Flags: `--results` (repeatable), `--dry`,
  `--backup-dir`, `--root`.
- **classify-projects.cjs** — deterministic per-folder tiering
  (REAL / GRAY / THROWAWAY from sessions + active-day span + messages) →
  one JSON object with the signals an LLM needs to pick a final label.

## Result object (one JSON line per file, keyed by `path`)

```json
{"path":"<rel>","uuid":"<session_id>","title":"...","summary":"...",
 "type":"feature","outcome":"completed",
 "keywords":["..."],"decisions":["..."],"lessons":["..."],"insights":["..."]}
```

`uuid` is optional but recommended — the merge rejects a row whose uuid does
not match the file's `session_id` (catches subagent mix-ups).

## Enrich workflow

1. **Scan**: `node scan-unenriched.cjs [--project X] [--limit N] > todo.jsonl`.
2. **Author** (the expensive step): for each row, read the FULL `.md` body
   (map-reduce if large) and author the result object. Parallelize with
   **≤6 subagents** (Agent tool), each handling a slice of `todo.jsonl` and
   writing its results to `results/<batch>.jsonl`. Instruct every subagent to
   read the whole transcript, never head+tail.
3. **Merge**: `node merge-frontmatter.cjs --results results/*.jsonl` (add `--dry`
   first to eyeball 3). Non-zero exit ⇒ some rows errored — inspect stderr,
   fix, re-run (idempotent).
4. **Verify**: re-run `node scan-unenriched.cjs` — enriched files drop out;
   spot-check YAML + that bodies are unchanged (compare against the backup).

Always **validate a small sample (3-5 files) end-to-end before a mass run.**

## Project classification (Feature E)

`node classify-projects.cjs > tiers.json` → for each folder, an LLM refines the
tier into one of `real-project | one-off-task | scratch/test |
reference/learning` using `types` + `sample_titles`, and suggests cleanup.
Write the review to `plans/reports/project-classification-<date>.md`.
**Never auto-delete** — the report is advisory only.
