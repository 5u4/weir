# weir UI round 5 brief: the conversation reader (throwaway prototype)

Read `weir-proto/ui/BRIEF.md`, `BRIEF-r2.md`, `BRIEF-r3.md`, then `BRIEF-r4.md`. Everything there still holds unless this file changes it. `weir-proto/CONTRACT.md` is the data contract; round 5 adds fields to it (see "Data" below).

## Round 4 verdict from the user

- `notch` is the chosen shell: flat list column on the ground, the reader is the only island, the Dynamic-Island capsule is inset in the reader island's top edge, expands into the sentence on the digest and shrinks to a pill while reading. The user loves that it shrinks while reading. Keep all of it.
- No quay "pier" bridge on the selected row.
- The new complaint is the conversation itself, in the right column: "现在都太长了，要翻好久。感觉也不适合长对话." Today the reader prints title, the full summary, the update, relation chips, then every message's full original body one after another. Real bodies are long (median 2.9k chars, p90 6k, English). A Teams-style group chat with 40+ messages would be unusable this way.
- Earlier verdicts that constrain this round: split reader is right because closing a long inline expansion meant scrolling back up; the user reads English slowly, so the zh-CN layer carries the reading and the English original is for checking; keyboard shortcuts are not a design concern now.

## The question this round answers

What should the right column show so that a conversation of any length is understood in one screen, and the original text is reachable without a long scroll?

The reader must answer, in this order: what is this; what is new since I last looked; what does it want from me; what exactly did they say (original, on demand).

## Shared rules (all three directions)

1. **Shell.** Start from a copy of `ui/notch/{index.html,app.js,style.css}`. Keep the list column, the notch capsule, the digest empty state, the bottom dock, the bucket nav, read state, 完成/undo, 全部清掉, 已清理/恢复, 标为未读, and the 390x844 sheet exactly as they are. Only the reader's conversation view (`readerHtml`, `timelineHtml`, `itemHtml` and their CSS) is redesigned. The dock may gain conversation-local controls.
2. **No full-body wall.** No message body is rendered in full by default. Every original body is either hidden behind its gist line or clamped (about 8 to 12 lines with a fade) with an explicit "全文" control.
3. **Gists replace bodies as the default unit.** Each message shows its zh-CN `gist` (see Data) as its default text. Fallback when `gist` is missing: the first sentence of `bodyNew`, clamped to one line.
4. **Land on what is new.** Opening an unread conversation lands on the first unread message (or the update), not on the top of the history. Read history above it is compressed.
5. **Long conversations compress.** A run of more than 3 consecutive read messages collapses into one row ("之前 N 条" plus a short span label such as date range and participants) that expands in place.
6. **Closing an expanded original never needs a scroll back.** Whatever control expands a message keeps a way to collapse it in view (sticky header, sticky collapse, or the dock).
7. **Points.** Show the conversation's `points` (see Data) somewhere above the fold, each linking to the message it came from (clicking jumps to and reveals that message).
8. **Long bodies.** GitHub notification bodies arrive as markdown with inline HTML; strip the inline HTML tags (`<details>`, `<summary>`, `<picture>`, `<img>`, `<sub>`, `<br>`) to text before rendering. Quoted history stays behind the existing 显示引用 toggle.
9. **Source tags.** Synthetic items carry `synthetic: true`; show their `sourceLabel` as is (it ends in "（合成）").

## Data

The data slice writes a new run `weir-proto/data/runs/gpt-6-luna-r5/data.json` and registers it in `data/runs/index.json`. It is the real 10-day Gmail run (`gpt-6-luna-low`) plus:

```ts
type Item = Item & {
  gist: string            // zh-CN, one sentence, at most about 40 Chinese characters: what this message adds
  synthetic?: true
}
type Conversation = Conversation & {
  points: { kind: "ask" | "decision" | "date" | "info"; text: string; itemId: string }[]   // 0 to 5, zh-CN
}
```

Two synthetic long conversations are added so the long case exists at all (the real Gmail data peaks at 8 messages per conversation):
- a Teams-style group chat, about 45 English messages over 3 days, 5 to 7 participants, interleaved topics, two direct @-mentions of me, mostly read with the last 10 to 15 unread;
- a long email thread, about 12 English replies with quoted history and signatures, last 3 unread.

Set `DEFAULT_RUN = "gpt-6-luna-r5"` in your direction's `app.js`. Until that run exists, the shell falls back to `gpt-6-luna-low` without gists; build against the fallback but verify only on the r5 run.

## Directions

Each must look and feel clearly different from the other two at a glance. All three keep the notch shell.

### outline, 要点索引

- **Reader.** Header: title, one-line lede (first sentence of summary; full summary behind a "展开摘要" toggle), the update, relation chips, then a **要点** block grouped by kind (要你做 / 已决定 / 时间 / 信息), each point with a small message-number chip that jumps to its message.
- **Messages.** A dense **index**: one row per message with avatar, sender, gist, time, unread mark. Older read runs collapse per rule 5. Clicking a row expands that one message inline as an accordion (only one open at a time): gist, then the clamped original, then 全文 and 显示引用. The open message's header sticks to the top of the reader while you are inside it and carries 收起.
- **Question it answers.** Does a points-plus-index layer make any conversation readable in one screen, with originals one click away?

### stream, 对话流

- **Reader.** Reads like a chat, built for the Teams case. Messages are compact bubbles grouped by consecutive sender, with day separators and a "上次读到这里" divider; the reader opens scrolled so the divider sits near the top. Bubble text is the gist. Each bubble has a quiet 原文 toggle that swaps the bubble to the clamped English original in place (and back). My own messages align right.
- **Context.** Summary, update, and points live in a compact card pinned at the top of the reader under the notch pill; it collapses to one line as you scroll down into the stream and expands when you scroll back to the top.
- **Question it answers.** Is a chat stream with zh-CN gists in the bubbles the right shape for long multi-party conversations, and does it still work for a 2-message email conversation?

### pager, 逐封翻页

- **Reader.** Never a long scroll. A slim header (title, lede, update, points as a horizontal strip of chips) sits above a **rail**: a horizontal timeline of every message as a tick or dot, colored by sender, unread ticks marked, day breaks visible, the current message highlighted. Under the rail, exactly one message is shown as a page: sender, time, gist large, then the clamped original with 全文 and 显示引用.
- **Navigation.** Click any tick to go to that message; 上一封 / 下一封 in the dock. Opening lands on the first unread message. Hovering a tick previews its gist.
- **Question it answers.** For long conversations, is stepping one message at a time with a map of the whole conversation better than scrolling any list?

## The bar

Read `skill://award-grade-ui` in full and hold to it. The zh-CN gist and points carry the reading; their legibility is the floor. Bold comes from composition and one signature moment per direction, not from big type.

## Build notes

- Copy `ui/notch/{index.html,app.js,style.css}` into `ui/<direction>/`. Keep `window.weirDev` and the `/ui/switch.js` script tag. Do not edit `switch.js`, `ui/index.html`, `base/`, `data/`, or any other direction's directory.
- Server: `cd weir-proto && bun ux/serve.ts` serves http://localhost:9347 and is already running. Do not restart it. `/ui/<direction>/` is the URL.
- Verify in a headless browser at 1440x900, 2560x1440, and 390x844, on the r5 run: open the synthetic group chat, the synthetic long email thread, the longest real GitHub notification conversation, and a 1-message conversation. For each, record (a) the reader's total scroll height on open and the number of viewport heights it spans, (b) the scroll distance from the landing position to the last unread message, (c) whether the update, the points, and the first unread message are visible without scrolling. Compare against `ui/notch/` measured the same way on the same run. Exercise points-jump, expand/collapse of an original (collapse without scrolling back), 之前 N 条 expansion, and the regression set from BRIEF-r4 (完成 with undo and auto-open of next, 标为未读, 全部清掉, 已清理/恢复). Capture the signature moment as frames. Check WCAG AA contrast for gists, points, and clamped originals.
- Pitfalls from earlier rounds:
  - The server's `/__reload` SSE fires on any write under `ui/`, including screenshots. Stub `/__reload` in headless sessions and write screenshots to `/tmp/<direction>-jury/` first, then copy them to `ui/shots/<direction>-*.png` at the end.
  - Synthetic keydown must be dispatched on `document.body`; the handler calls `e.target.matches`.
  - `render()` replaces `#app` innerHTML and resets scroll; preserve list scroll and reader scroll and expansion state explicitly.
  - `全部清掉` (clearAll) skips the `beforeHide` hook.
  - Sender favicons come from Google S2; a 404 for `ust.hk` is known console noise.
