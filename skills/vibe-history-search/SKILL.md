---
name: vibe-history-search
description: >-
  Search past Claude Code sessions captured in the vibe-history store (BM25,
  vector, or hybrid) via the qmd wrapper. Use when the user asks "did we do X
  before", "find the session about Y", "how did I fix Z last time", or wants to
  recall prior decisions/lessons across projects.
---

# vibe-history-search

Recall layer over the vibe-history capture store
(`<historyRoot>/<project>/*.md`). Wraps the
`qmd` CLI, scoped to the `vibe-history` collection. Frontmatter enrich
(title/summary/keywords/decisions/lessons/insights) makes results sharp.

## Commands

Run via node (zero-dep wrapper, forces `QMD_RUNTIME=node`):

```
node ~/.claude/hooks/lib/vibe-history-qmd-cli.cjs <cmd> [args]
```

- `search "<q>" [-n N]` — BM25 full-text, instant, no LLM. **Default choice.**
- `vsearch "<q>" [-n N]` — vector similarity (semantic; needs `embed` first).
- `query "<q>" [-n N]` — hybrid expand + rerank (best quality; needs `embed`).
- `index` — (re)index the store after new captures/enrich (idempotent upsert).
- `embed` — build/refresh vector embeddings (one-time; downloads a ~330MB
  model on first run; needed only for vsearch/query).
- `status` — index health + collection stats.

## Workflow

1. **Find sessions**: `search "sapo flashsale countdown" -n 5`. Results show
   `qmd://vibe-history/<project>/<file>.md`, title, score, and the matched
   frontmatter snippet (keywords/decisions/summary).
2. **Read a hit**: open the real path
   `<historyRoot>/<project>/<file>.md` (or
   `qmd get <file>`), scan its frontmatter first, then body if needed.
3. **Semantic recall** (fuzzy intent, not keywords): use `query` or `vsearch`
   — requires `embed` to have completed.

## Keeping the index fresh

New sessions are captured by the hook but NOT auto-indexed. After a batch of
new sessions or an enrich pass, run `index` (fast, BM25 ready immediately) and
`embed` (only if you rely on vsearch/query). This is manual by design (YAGNI —
no auto-reindex hook).

## Missing qmd

If the wrapper prints an install hint: `npm i -g @tobilu/qmd` (on a native
build error: `npm rebuild better-sqlite3 -g`).
