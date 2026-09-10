# vibe-history — Tài liệu hệ thống

> 🇬🇧 English (primary): [`vibe-history-system-guide.md`](vibe-history-system-guide.md).
> Bản tiếng Việt này là bản dịch phụ; khi có khác biệt, ưu tiên bản tiếng Anh.

Tài liệu này giải thích vibe-history làm gì, các khái niệm kỹ thuật đứng sau nó
(frontmatter, enrich, BM25, vector/semantic search, QMD…), và cách dùng trong
thực tế. Viết cho người sẽ vận hành hoặc mở rộng hệ thống, không giả định bạn
đã quen sẵn các thuật ngữ tìm kiếm.

---

## 1. vibe-history là gì

vibe-history là hệ thống **tự động lưu lại lịch sử các phiên làm việc với Claude
Code, Codex CLI, và Antigravity**. Mỗi khi một phiên (session) kết thúc, một hook
chạy nền sẽ đọc bản ghi hội thoại gốc và xuất ra một file Markdown gọn, dễ đọc,
lưu vào `<historyRoot>/<tên-project>/` — trong đó `historyRoot` là thư mục bạn
chọn lúc cài (xem `config.json`; mặc định `~/Documents/vibe-history`). Cả ba
agent dùng **chung một kho**, phân biệt bằng field `source: claude|codex|antigravity`.

Vấn đề nó giải quyết: khi làm việc với AI qua nhiều phiên, nhiều dự án, các
quyết định và cách xử lý bug bị "chôn" trong hàng trăm cuộc hội thoại. Không ai
đọc lại được. vibe-history biến chúng thành một kho tri thức **có cấu trúc** và
**tìm kiếm được**, để sau này trả lời được những câu như "lần trước sửa lỗi
login Zoom thế nào?" mà không phải nhớ hay lục tay.

Hệ thống gồm 3 lớp, chạy nối tiếp nhau:

```
[1] CAPTURE  → hook lưu mỗi session thành 1 file Markdown (tự động, không cần AI)
[2] ENRICH   → đọc lại toàn bộ transcript, sinh metadata ngữ nghĩa (cần AI)
[3] SEARCH   → index + tìm kiếm toàn bộ lịch sử (BM25 / vector / hybrid)
```

---

## 2. Kiến trúc & tech stack

Mã nguồn tách theo: `core/` (engine dùng chung, không phụ thuộc agent), `claude/`,
`codex/`, và `antigravity/` (entrypoint riêng từng agent, đều `require ../core`).
Xem cấu trúc thư mục và bảng "file nào thuộc agent nào" trong `README.md`.

| Lớp | Thành phần | Công nghệ | Vị trí (repo) |
|---|---|---|---|
| Capture | Hook Claude Code | Node.js (zero-dep) | `claude/vibe-history-capture.cjs` |
| Capture | Hook + notify Codex CLI | Node.js (zero-dep) | `codex/codex-vibe-history-capture.cjs`, `codex/codex-vibe-history-notify.cjs` |
| Capture | Hook + notify Antigravity | Node.js (zero-dep) | `antigravity/antigravity-vibe-history-capture.cjs`, `antigravity/antigravity-vibe-history-notify.cjs` |
| Capture | Parser + builder dùng chung | Node.js | `core/vibe-history-markdown-builder.cjs`, `core/vibe-history-codex-parser.cjs`, `core/vibe-history-antigravity-parser.cjs` |
| Capture | Backfill (import session cũ) | Node.js | `core/vibe-history-backfill-runner.cjs` |
| Config | historyRoot + kill-switch | Node.js + `config.json` | `core/vibe-history-config.cjs` |
| Enrich | Skill scan/merge/classify | Node.js (zero-dep) | `skills/vibe-history-enrich/` |
| Search | CLI bọc QMD | Node.js (zero-dep) | `core/vibe-history-qmd-cli.cjs` |
| Search | Search engine | QMD (`@tobilu/qmd`) + SQLite + model GGUF | binary `qmd` trên PATH, index `~/.cache/qmd/index.sqlite` |
| Storage | Kho dữ liệu | File Markdown thuần | `<historyRoot>/<project>/*.md` |

Nguyên tắc xuyên suốt: **dữ liệu là file Markdown thuần** — không database độc
quyền, không khoá vào công cụ nào. Đọc được bằng mắt, bằng `grep`, bằng bất kỳ
editor nào. Các lớp trên (enrich, search) chỉ là công cụ bổ trợ đọc/ghi lên
chính các file đó.

**Cài đặt:** chạy `./install.sh` (macOS/Linux) hoặc `install.ps1` / `install.cmd`
(Windows), hoặc double-click `install.command` trên macOS. Trình cài tự phát hiện
Claude Code, Codex, và/hoặc Antigravity, hỏi thư mục history, ghi `config.json`,
và nối dây hook cho agent nào đang có. Chi tiết trong `README.md`.

---

## 3. Lớp 1 — Capture (bắt session)

### 3.1 Chạy khi nào

**Claude Code** — hook `claude/vibe-history-capture.cjs` đăng ký trong
`~/.claude/settings.json` ở 2 sự kiện:

- **SessionEnd** — khi phiên kết thúc (đóng cửa sổ, `/clear`, thoát). Đây là
  lần bắt "chính thức".
- **PreCompact** — ngay trước khi Claude Code nén (compact) hội thoại vì quá
  dài. Bắt ở đây để **không mất phần đầu** hội thoại trước khi bị nén.

Ngoài ra `Backfill` (import thủ công các session cũ có sẵn trong
`~/.claude/projects/`) cũng có thể bắn capture.

**Codex CLI** — `codex/codex-vibe-history-notify.cjs` được gọi qua `notify`
trong `~/.codex/config.toml` sau **mỗi lượt** (turn-ended); nó bắn capture cho
rollout mới nhất (`~/.codex/sessions/**/rollout-*.jsonl`). Nếu một tool khác đã
giữ `notify` (vd computer-use client), để nó forward sang script này qua
`--previous-notify`. Codex chạy độc lập — **không cần cài Claude Code**.

> **Codex có 2 dạng rollout**, parser xử lý cả hai: TUI tương tác (0.149.x và
> trước 0.147) đưa nội dung qua `event_msg → item_completed → item`
> (UserMessage/AgentMessage/Reasoning/FileChange); còn `exec` (0.147.x) dùng
> `event_msg` phẳng `user_message`/`agent_message` + `patch_apply_end`.

**Antigravity** — `antigravity/antigravity-vibe-history-notify.cjs` được đăng
ký dưới key riêng `vibe-history` trong `~/.gemini/config/hooks.json` (nằm cạnh,
không đụng vào, các key khác như `orca-status`), bắn khi có sự kiện `Stop`. Nó
đọc `transcript.jsonl` của cuộc hội thoại tại
`~/.gemini/antigravity/brain/<conversation>/.system_generated/logs/` (đường dẫn
lấy từ payload của hook, hoặc tự dò file `transcript.jsonl` mới nhất nếu gọi
với đường dẫn rỗng — vd gọi tay). Antigravity cũng chạy **độc lập**.

**Kill-switch:** đặt `"enabled": false` trong `config.json` (hoặc
`VIBE_HISTORY_ENABLED=false`) để tạm dừng capture cho cả 3 agent.

### 3.2 Điểm mạnh giữ nguyên (fidelity)

vibe-history cố tình giữ nhiều chi tiết hơn một bản tóm tắt thông thường:

- **Thinking blocks** — các đoạn "suy nghĩ" của AI được giữ trong `<details>`.
- **Subagent inline** — khi phiên chính giao việc cho subagent, toàn bộ hội
  thoại của subagent được lồng vào (đệ quy), không bị bỏ.
- **Fail-open tuyệt đối** — nếu hook lỗi vì bất kỳ lý do gì, nó im lặng thoát,
  **không bao giờ** làm hỏng hay chặn phiên làm việc của bạn.

*Lưu ý Codex:* phần "suy nghĩ" (reasoning) của Codex bị mã hoá khi lưu
(`encrypted_content`), nên digest của Codex thường **không có** thinking blocks —
đây là giới hạn của Codex, không phải lỗi capture.

### 3.3 Tên file

Mỗi session ra một file tên `YYMMDD-HHMM-<id8>.md`, ví dụ
`260709-1615-830cba69.md`:
- `YYMMDD-HHMM` = ngày giờ bắt đầu session, theo **timezone cấu hình** (mặc định
  giờ máy, hoặc `timezone` trong config) → sắp xếp theo thời gian đúng, quét dễ.
- `<id8>` = 8 ký tự đầu của session UUID → truy ngược được về transcript gốc.

Một session **chỉ có một file**. Khi hook bắn lại (PreCompact rồi SessionEnd),
nó **ghi đè** chính file đó bằng bản tái tạo mới nhất — không tạo nhiều bản
snapshot.

**Thư mục project** = tên git repo của phiên, lấy theo **main worktree** (qua
`git --git-common-dir`). Nên phiên chạy trong một linked worktree (vd orca
workspace `.../my-project/<worktree>`) sẽ vào thư mục `my-project`, không phải
tên folder worktree tạm. cwd không phải git repo thì fallback về basename.

---

## 4. Khái niệm: Frontmatter & metadata

### 4.1 Frontmatter là gì

**Frontmatter** là một khối YAML đặt ở đầu file Markdown, nằm giữa hai dòng
`---`. Nó chứa **metadata** (dữ liệu mô tả về file) tách biệt với nội dung.
Ví dụ:

```yaml
---
title: "Debug lỗi login Zoom (4700/invalid_client), chuyển sang PKCE"
summary: "Gỡ hardcode client secret đã lộ, xử lý lỗi Zoom cấm localhost..."
type: debug
outcome: partial
keywords: [zoom-api, oauth2, pkce, secret-leak]
decisions:
  - "Chuyển redirect sang domain thật vì Zoom cấm chuỗi localhost"
project: "zoom-cli"
date: 2026-07-09
session_id: 830cba69-385e-4355-b6db-962341a8b09d
enriched: true
---
```

Frontmatter cho phép công cụ (và con người) hiểu file **mà không cần đọc hết
nội dung** — chỉ liếc metadata là biết session nói về gì, kết quả ra sao.

### 4.2 Hai loại field: deterministic vs semantic

Hệ thống chia metadata làm hai nhóm, vì chúng có nguồn gốc khác nhau:

**Deterministic** (máy tự suy ra, không cần AI) — hook điền ngay lúc capture:
- `project`, `date`, `session_id`, `source` (`claude`|`codex`|`antigravity`),
  `git_branch`, `changed_files` (số file đã sửa), `messages` (số lượt),
  `created`, `last_activity`, `cwd`, `hook_event`.
- Một `title` tạm theo heuristic (thường là câu hỏi đầu của user).

**Semantic** (cần hiểu nội dung → cần AI) — do lớp Enrich điền sau:
- `title` (viết lại cho đúng), `summary`, `type`, `outcome`, `keywords`,
  `decisions`, `lessons`, `insights`.

Lý do tách: **hook chạy headless, không gọi được LLM**. Nó chỉ làm được phần
máy móc. Phần "hiểu nội dung" đẩy sang một bước riêng (Enrich). Cờ `enriched:
true/false` đánh dấu file đã qua bước semantic chưa.

**Enum ràng buộc** (để search/lọc nhất quán):
- `type` ∈ debug · feature · landing-page · cro · research · docs · setup ·
  content · data-processing · seo · planning · other
- `outcome` ∈ completed · partial · exploratory · blocked

### 4.3 Vấn đề "ghi đè xoá enrichment" và cách xử lý

Vì hook ghi đè cả file mỗi lần bắn, nếu Enrich (điền field semantic) chạy xen
giữa hai lần bắn, lần bắn sau sẽ **xoá mất** phần semantic. Builder xử lý bằng
**merge-on-overwrite**: trước khi ghi đè, nó đọc frontmatter cũ, giữ nguyên
verbatim các field semantic đã có, rồi mới ghi lại. Nhờ vậy enrichment không
bao giờ bị mất khi session re-capture.

---

## 5. Lớp 2 — Enrich (làm giàu metadata ngữ nghĩa)

### 5.1 Mục tiêu

Điền 8 field semantic cho mỗi session bằng cách **đọc và hiểu nội dung**. Đây là
bước duy nhất cần AI (chạy qua subagent trong Claude Code, không cần API key
riêng).

### 5.2 Nguyên tắc bắt buộc: đọc TOÀN BỘ transcript

Điểm quan trọng nhất — và là bài học đã rút ra: **phải đọc hết cả transcript,
không được đọc kiểu "đầu + cuối" (head+tail digest)**.

Lý do: các `decisions` / `lessons` / `insights` nằm rải rác **giữa** phiên, chứ
không chỉ ở câu hỏi đầu hay câu chốt cuối. Cách đọc tắt đầu-cuối (rẻ hơn) bỏ sót
phần lớn tri thức và cho ra metadata nông, sai. Ví dụ thực tế: một session bị
gán nhầm `data-processing` khi đọc tắt, đọc full mới thấy đúng là `setup`
(đóng gói/phân phối); một insight quan trọng "thời gian debug n8n 2h52m > thời
gian build CLI 40m" chỉ xuất hiện ở giữa phiên.

### 5.3 Map-reduce cho file lớn

Một số transcript rất dài (5.000–7.500+ dòng), vượt khả năng đọc một lần của
context. Giải pháp là **map-reduce** — một kỹ thuật chia-để-trị:
- **Map**: chia file thành nhiều "cửa sổ" (chunk), đọc từng chunk, trích tín
  hiệu (quyết định, bài học) trong chunk đó.
- **Reduce**: hợp nhất tín hiệu từ mọi chunk thành một bộ metadata cuối.

Tuyệt đối không cắt bớt transcript cho "vừa" context. Chất lượng ưu tiên hơn chi
phí token.

### 5.4 Quy trình & công cụ

Skill `vibe-history-enrich` gồm 3 script Node (zero-dep):

- **`scan-unenriched.cjs`** — quét kho, liệt kê file chưa `enriched: true` (kể cả
  file cũ đã enrich nông từ trước).
- **`merge-frontmatter.cjs`** — nhận kết quả AI (JSON), ghi 8 field semantic +
  `enriched: true` vào frontmatter, **giữ nguyên phần thân file từng byte**.
  Có nhiều lớp an toàn: đối chiếu UUID (chống nhầm file), validate YAML bằng
  validate cấu trúc frontmatter, kiểm tra thân file không đổi, backup trước khi ghi.
- **`classify-projects.cjs`** — gom file theo folder, xếp hạng project thô
  (REAL / GRAY / THROWAWAY) dựa số session + khoảng thời gian, để AI tinh chỉnh
  thành 4 nhãn (real-project / one-off-task / scratch-test / reference-learning).

Luồng chạy: `scan` → chia file cho ≤6 subagent đọc full song song → mỗi subagent
xuất JSON → `merge` → kiểm tra lại. Chạy lại an toàn (idempotent): file đã
enrich sẽ bị bỏ qua, không tốn AI lặp.

---

## 6. Khái niệm: Tìm kiếm (Search)

Phần này giải thích các khái niệm search trước khi nói QMD dùng chúng thế nào.

### 6.1 Full-text search & BM25

**Full-text search** = tìm theo từ khoá xuất hiện trong văn bản (giống ô tìm
kiếm cơ bản). Câu hỏi cốt lõi: với một truy vấn, tài liệu nào **liên quan nhất**?

**BM25** là công thức xếp hạng kinh điển cho việc này (viết tắt "Best Matching
25"). Nó chấm điểm mỗi tài liệu dựa trên:
- **Tần suất từ khoá** — từ truy vấn xuất hiện nhiều thì điểm cao hơn, nhưng
  **giảm dần** (xuất hiện 10 lần không đáng gấp 10 lần 1 lần — tránh spam từ).
- **Độ hiếm của từ** — từ hiếm trong toàn kho (như "invalid_client") mang nhiều
  thông tin hơn từ phổ biến ("the", "và") nên được đánh trọng số cao hơn.
- **Độ dài tài liệu** — chuẩn hoá để tài liệu dài không tự động thắng chỉ vì
  chứa nhiều từ hơn.

Đặc điểm BM25: **nhanh, không cần AI/model**, chạy tức thì. Nhược điểm: nó khớp
**mặt chữ**, không hiểu nghĩa. Tìm "login error" sẽ không tự khớp tài liệu viết
"authentication failure" nếu không trùng từ.

Đây là lý do **enrich rất quan trọng cho search**: khi frontmatter đã có
`keywords: [zoom-api, oauth2, pkce]` và `summary` mô tả rõ, BM25 có đúng từ để
khớp → độ liên quan thực tế đạt 92–96% trên các truy vấn thật.

### 6.2 Vector embeddings & semantic search

**Semantic search** = tìm theo **ý nghĩa**, không theo mặt chữ. Để làm được,
mỗi đoạn văn bản được biến thành một **vector embedding** — một dãy số (vài trăm
chiều) biểu diễn "nghĩa" của đoạn đó, do một mô hình ngôn ngữ sinh ra. Điểm mấu
chốt: **hai đoạn nghĩa gần nhau → hai vector gần nhau** trong không gian số, dù
dùng từ khác nhau.

Khi tìm, truy vấn cũng được biến thành vector, rồi hệ thống tìm các tài liệu có
vector **gần nhất** (đo bằng khoảng cách/cosine). Nhờ vậy "sửa lỗi đăng nhập"
có thể khớp tài liệu viết "authentication failure" — vì nghĩa gần, dù không
trùng chữ.

Đánh đổi: cần một **model embedding** (ở đây là embeddinggemma-300M, ~330MB tải
về lần đầu) và phải **tính trước vector cho mọi tài liệu** (bước `embed`, chạy
một lần, tốn thời gian CPU). Bù lại tìm được theo ngữ nghĩa.

### 6.3 Hybrid search (query expansion + reranking)

**Hybrid** = kết hợp cả hai để bù nhược điểm của nhau, thường cho kết quả tốt
nhất. QMD (lệnh `query`) làm thêm 2 bước:
- **Query expansion** — mở rộng truy vấn bằng các từ/cách diễn đạt liên quan
  (một model nhỏ sinh ra) để bắt được cả tài liệu dùng từ khác.
- **Reranking** — sau khi lấy tập ứng viên (từ BM25 + vector), một model
  **rerank** đọc lại từng cặp (truy vấn, tài liệu) và sắp xếp lại theo mức liên
  quan thật, đưa kết quả tốt lên đầu.

### 6.4 QMD là gì

**QMD** ("Quick Markdown Search", gói npm `@tobilu/qmd`) là một công cụ dòng
lệnh gói sẵn cả ba kiểu tìm trên, chuyên cho **kho file Markdown**:
- Nó **index** các file .md vào một database SQLite (`~/.cache/qmd/index.sqlite`),
  đọc được cả frontmatter.
- Cung cấp `search` (BM25), `vsearch` (vector), `query` (hybrid).
- Chạy hoàn toàn **cục bộ** (model GGUF chạy trên máy, không gọi API ngoài).

Một "collection" trong QMD là một thư mục được index. vibe-history đăng ký toàn
bộ kho làm collection tên `vibe-history` (pattern `**/*.md`).

*Lưu ý kỹ thuật:* QMD phải chạy bằng Node (`QMD_RUNTIME=node`) vì native module
`better-sqlite3` của nó crash dưới runtime Bun. CLI wrapper đã set sẵn biến này.

---

## 7. Lớp 3 — Search (dùng thực tế)

CLI wrapper zero-dep (`core/vibe-history-qmd-cli.cjs`) bọc QMD, giới hạn vào
collection `vibe-history`, tự dò đường dẫn qmd và ép `QMD_RUNTIME=node`.

```bash
node core/vibe-history-qmd-cli.cjs <lệnh>
```

| Lệnh | Việc | Cần model? |
|---|---|---|
| `search "<q>" [-n N]` | BM25 full-text, tức thì | Không |
| `vsearch "<q>" [-n N]` | Vector / semantic | Có (`embed` trước) |
| `query "<q>" [-n N]` | Hybrid expand + rerank | Có (`embed` trước) |
| `index` | Re-index kho sau khi có session mới / enrich | Không |
| `embed` | Sinh vector (một lần, tải model ~330MB) | — |
| `status` | Tình trạng index + collection | Không |

Kết quả in ra đường dẫn `qmd://vibe-history/<project>/<file>.md`, title, điểm %,
và đoạn frontmatter khớp. Từ đó mở file thật để đọc chi tiết.

Cũng có thể gọi qua **skill `vibe-history-search`** ngay trong Claude Code (agent
tự chạy CLI khi bạn hỏi kiểu "tìm session về X").

**Giữ index tươi:** session mới được hook lưu nhưng **không tự index lại**. Sau
một đợt session mới hoặc enrich, chạy `index` (nhanh, BM25 sẵn ngay) và `embed`
(chỉ khi cần vsearch/query). Đây là chủ ý — không làm auto-reindex để giữ hệ
thống đơn giản.

---

## 8. Use cases thực tế

1. **Nhớ lại cách xử lý cũ** — "Lần trước fix lỗi login Zoom thế nào?"
   → `search "zoom oauth login invalid_client"` → ra đúng session debug, đọc
   `decisions`/`lessons` là có ngay cách làm + cái bẫy đã gặp.

2. **Tránh làm lại từ đầu** — trước khi build một tính năng, tìm xem đã từng
   động vào chưa: `search "flashsale countdown sapo"` → thấy session cũ đã dựng
   `<countdown-timer>` → tái dùng thay vì viết lại.

3. **Recall theo ý mơ hồ** (không nhớ từ khoá chính xác) —
   `query "làm sao đồng bộ dữ liệu khách hàng qua nhiều hệ thống"` → hybrid tìm
   theo nghĩa, ra các session Bitrix24/Lark migration dù không trùng chữ.

4. **Tổng hợp tri thức chéo dự án** — lọc theo `type: debug` + đọc `lessons`
   nhiều session để rút ra các bẫy lặp lại (vd các quirk của Sapo/DotLiquid,
   của egatcli) — biến kinh nghiệm rời rạc thành checklist.

5. **Kiểm kê & dọn dẹp project** — báo cáo classification (Feature E) xếp folder
   thành real-project / one-off / scratch-test / reference, gợi ý cái nào đáng
   archive/xoá (chỉ gợi ý, không tự xoá).

6. **Bàn giao / ôn lại** — mở nhanh frontmatter của loạt session một project để
   nắm lại tiến độ, quyết định đã chốt, việc còn dở (`outcome: partial/blocked`).

---

## 9. Cheat sheet vận hành

Đường dẫn dưới đây tính từ thư mục repo (nơi bạn cài). Skill enrich nằm ở
`skills/vibe-history-enrich/` (khi cài, được copy sang `~/.claude/skills/`).

```bash
# --- Search ---
CLI=core/vibe-history-qmd-cli.cjs
node $CLI search "telegram sync churn" -n 5      # nhanh, mặt chữ
node $CLI query  "cách phân quyền membership"    # hiểu nghĩa (cần embed xong)
node $CLI status                                 # xem index

# --- Cập nhật index sau khi có session mới / enrich ---
node $CLI index                                  # BM25 sẵn ngay
node $CLI embed                                  # cập nhật vector (chạy nền được)

# --- Enrich session chưa có metadata ngữ nghĩa ---
node skills/vibe-history-enrich/scripts/scan-unenriched.cjs --project <tên>
# → dùng skill vibe-history-enrich cho quy trình đầy đủ (đọc full → merge)

# --- Import session cũ chưa được bắt (Claude Code) ---
node claude/vibe-history-backfill.cjs
```

---

## 10. Hạn chế & câu hỏi mở

- **Index không tự tươi** — phải chạy `index`/`embed` thủ công sau session mới.
  Chủ ý (YAGNI). Có thể thêm auto-reindex nhẹ sau này nếu thấy phiền.
- **Collection gồm cả `docs/` và `plans/`** — pattern `**/*.md` quét cả file
  meta này, gây nhiễu nhẹ khi search. Chấp nhận được hiện tại.
- **Enrich tốn AI** — enrich đọc full transcript qua subagent nên tốn token;
  thường chỉ enrich chọn lọc (vd project nhiều phiên), phần còn lại để backlog.
- **Chưa secret-scrubbing** — transcript có thể chứa thông tin nhạy cảm; kho là
  file cục bộ, chưa có bước lọc secret trước khi lưu (quyết định thiết kế). Vì
  vậy **giữ thư mục history ở chế độ riêng tư — đừng publish nó**.
- **`embed` phụ thuộc model tải về** — lần đầu cần ~330MB và CPU để vector hoá;
  máy yếu sẽ chậm.
