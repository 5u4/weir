# weir UI round 10 brief: search (throwaway prototype)

Read `weir-proto/ui/BRIEF.md` and `BRIEF-r2.md` through `BRIEF-r7.md` first. Everything there still holds unless this file changes it. The data contract is `weir-proto/CONTRACT.md` plus the r5 additions (`Item.gist`, `Conversation.points`). `ui/folio/` is the finalized UI (r7 plus r8/r9 edits). This round adds search to it. Nothing else in folio changes.

## Why this round exists

The finalized prototype has no search. In the real app the daemon keeps every synced item in SQLite FTS5, and `weir-axi search <query> --bucket --source --from --since` already gives agents search. The web UI needs its own way to find "that thing someone said last week". The decision this round makes: where search lives in the notch shell, and what a result is.

The user context that shapes search:

- weir is conversation-first. The user cares most about the conversation experience.
- The user reads English slowly. Gists, summaries, and points are AI output in the user's chosen language (Chinese in this data). Originals are English. A query may be in either language, and an English hit is hard to judge without its gist next to it.
- Cleared (完成) and muted conversations are out of sight on purpose, but search is exactly how you find them again.
- The user does not want effort spent on keyboard shortcuts in prototypes (they will be configurable later). Keep keys to the minimum each variant needs to work.

## Shared behavior (all three variants)

1. **Base.** Copy `ui/folio/{index.html,app.js,style.css}` into your directory and build on it. Keep everything folio has.
2. **What matches.** Conversation title, summary, points text, each item's gist, each item's original body, sender name and address, and source label. Case-insensitive substring. Whitespace-separated terms are ANDed within a conversation (all terms must appear somewhere in the conversation; each term may hit a different field or message). This stands in for SQLite FTS5 in the real app.
3. **Scope.** All conversations in the run: every bucket, read, unread, cleared, and muted. Cleared and muted results carry a quiet state label.
4. **A result is a conversation.** Show which messages matched and in which field, up to 3 hit lines per conversation, with the matched terms marked. For a hit in an original body, show an English excerpt of about 120 characters around the hit, and that message's gist under it so the user can tell what the message is about without reading English. For a hit in a gist, summary, point, title, or sender, show that text marked. Decide and state an ordering (for example: most recent matching message first).
5. **Opening a result.** The reader opens the conversation and lands on the first matching message (its bubble in view, the read-run fold expanded if it hides that message). Matched terms are marked inside gist bubbles. A message whose only hit is in its original body gets a quiet indicator on its bubble. A hit stepper (current/total, previous, next) moves between matching messages in that conversation. The dock's 原文 opens the transcript dialog landed on the current hit, with terms marked in the originals.
6. **State rules.** Opening a conversation from search follows the normal rule: it becomes read. A cleared conversation opened from search stays cleared; the dock shows 恢复 for it. Muted stays muted.
7. **Leaving search.** Esc (or clearing the query, or the variant's close control) returns to exactly the prior bucket, the prior open conversation (or the digest), and the prior list scroll position.
8. **Empty and zero states.** Design the state before typing (a short hint of what is searchable is enough; recent queries in localStorage are optional) and the zero-result state.
9. **Live.** Results update as you type. The data is small; no debounce needed beyond what feels right.
10. **Language rule.** No content-language words anywhere in visible text, `aria-label`, or `title` (BRIEF-r6 rule 3). The prototype UI stays in Chinese like folio.

## The three variants (one per directory)

- **`ui/seek/` (search lives in the Dynamic Island).** A search control in the notch capsule; activating it (click, or `/`) morphs the capsule into a query field. The bucket sentence becomes the results sentence with the same widget grammar, for example 「northwind」出现在 3 个「要我处理」、1 个「通知」和 1 个「已清理」里, and each widget filters results to that group. The flat left column becomes the result list. While reading a result, the compact capsule shows the query and the hit stepper. Layout must not move: the two columns stay put, exactly as folio.
- **`ui/sift/` (filter at the head of the list).** A quiet field pinned at the top of the flat left column. Typing filters the list in place across all buckets (each row then shows its bucket chip), with a scope toggle 本 bucket / 全部 and cleared or muted matches grouped at the end. Supports the field tokens `from:`, `in:<bucket>`, and `source:` (they mirror `weir-axi search` flags), shown as removable chips once typed. The capsule and reader behave as in folio, plus the hit stepper and marks from shared rule 5.
- **`ui/lens/` (search panel with preview).** A search control (and `⌘K`/`/`) opens a stage-centered panel over a dimmed page. Left: results grouped into conversations, then individual messages. Right: a live preview of the highlighted result (title, summary, and the matched messages with gists and excerpts). Enter or click opens it in the reader and closes the panel; a small 回到搜索 control in the reader reopens the panel with the same query, selection, and scroll. The underlying layout does not change.

## The bar

Read `skill://award-grade-ui` in full and hold to it. Dark mode is the user's main mode; light must still work. Nothing reintroduces the rounded-card-with-left-accent pattern. Highlight marks must stay readable in both themes (measure contrast of marked text). The variants should be bold in their own way while staying inside the notch shell's language (flat list, reader island, capsule).

## Verification

Use Playwright from `/tmp/yabcmp` (`bun add playwright@1` already ran there; it has WebKit and Chromium). Write your script in `/tmp/<variant>-jury/` and run it with `NODE_PATH=/tmp/yabcmp/node_modules`. Run `gpt-6-luna-r5` data.

- Pick queries from the data: an English word that appears only in original bodies, a Chinese term that appears in gists or summaries, a sender name, a term that hits a conversation you cleared first in the script, two terms ANDed, and a nonsense query.
- For each query, compute the expected set of conversations by brute force over the loaded data in-page, independently of your search code, and assert the UI shows exactly that set and that every visible hit line contains a marked term.
- Open the top result; assert the landed bubble is in the reader viewport and is a matching message; step through all hits with the stepper and assert the count; open 原文 and assert marks exist in the landed original.
- Assert leaving search restores bucket, open conversation, and list `scrollTop` (record before and after).
- Assert opening a cleared result keeps it cleared and offers 恢复.
- Regression set from BRIEF-r4 (完成 with undo and auto-open of next, 标为未读, 全部清掉, 已清理/恢复) once at 1440 dark.
- Content-language scan as in r6.
- Contrast of marked text and hit-line text, both themes.
- Screenshots to `/tmp/<variant>-jury/out/` first, then copied into `ui/shots/` at the end: `<variant>-1440-dark-empty.png`, `<variant>-1440-dark-results-en.png`, `<variant>-1440-dark-results-zh.png`, `<variant>-1440-dark-reader-hit.png`, `<variant>-1440-dark-transcript-hit.png`, `<variant>-1440-light-results-en.png`, `<variant>-390-dark-results-en.png`, `<variant>-1406-dark-webkit-results-en.png`, `<variant>-1406-dark-chromium-results-en.png`.

## Build notes

- Edit only your own `ui/<variant>/`. Do not edit `switch.js`, `ui/index.html`, `base/`, `data/`, `folio/`, or another variant's directory. The coordinator already added `seek`, `sift`, `lens`, `folio` to the switcher and pointed `/` at `/ui/seek/`.
- Server: `cd weir-proto && bun ux/serve.ts` serves http://localhost:9347 and is already running. Do not restart it.
- Pitfalls from earlier rounds:
  - The server's `/__reload` SSE fires on any write under `ui/`, including screenshots. Stub `/__reload` in headless sessions and write screenshots under `/tmp` first.
  - Synthetic keydown must be dispatched on `document.body`; the handler calls `e.target.matches`.
  - `render()` replaces `#app` innerHTML and resets scroll; search must not lose the reader scroll or the list scroll it promises to restore.
  - Do not use `text-wrap: pretty` (WebKit balances whole CJK paragraphs). `balance` only on short titles.
  - Sender favicons come from Google S2; a 404 for `ust.hk` is known console noise.
- Throwaway code: no tests, no abstractions, no comments narrating steps.
