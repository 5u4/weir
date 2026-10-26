# weir UI round 7 brief: polish the transcript reader (throwaway prototype)

Read `weir-proto/ui/BRIEF.md` and `BRIEF-r2.md` through `BRIEF-r6.md` first. Everything there still holds unless this file changes it. The data contract is `weir-proto/CONTRACT.md` plus the r5 additions (`Item.gist`, `Conversation.points`).

This round is one direction, `folio`: a polished copy of `ui/transcript/`. It is not a bakeoff.

## Round 6 verdict from the user

- `transcript` (原文对照) is the chosen 原文 modal. The user likes that it focuses on reading one conversation's whole run. `sheet/` and `lightbox/` are rejected and have been deleted.
- Remove the orange-red horizontal line that connects the landed gist in the left column to its original in the right column.
- Remove the per-bubble 原文 button. The modal is now a whole-conversation 摘要/原文 comparison, so its entry point belongs somewhere else (decided below).
- The hover and selected states in the transcript's left column feel off.
- Polish the chat. The time should not sit inside the bubble. The padding inside the reader island looks odd.
- The page looks off in WebKit (the user runs YAB, a WebKit browser, next to Chromium). A separate investigation found the cause (see "WebKit" below).
- The user works in dark mode. Light still has to work.

## Changes (all in `ui/folio/`)

1. **Base.** Copy `ui/transcript/{index.html,app.js,style.css}` into `ui/folio/`. Keep everything transcript has unless a rule below changes it: notch shell, digest empty state, dock, bucket nav, conversation-level read state, 完成 with undo and auto-open of next, 标为未读, 静音, 全部清掉, 已清理/恢复, folding context card with the pager-style 自你上次查看, sender-grouped gist bubbles, day separators, 上次读到这里 divider and landing, 之前 N 条 collapse, points jump, the 390x844 layout, both themes, the transcript dialog with scroll-locked columns and precise landing.
2. **No connector line.** Delete the accent line between the left gist and the right original in the transcript dialog, in every state and theme. Alignment on the same horizontal line stays; it no longer needs a drawn connector.
3. **Entry point for 原文对照.** Remove the 原文 control from every bubble. Two entries replace it:
   - The bubble itself. Each gist bubble is a button (`<button>` or `role="button"` with Enter/Space) labelled for screen readers as opening the original of message `#n`. Clicking it opens the transcript dialog landed on that message. Its hover and focus-visible states are a quiet surface step (one tone lighter in dark, one darker in light) and `cursor: pointer`. No hover text, no icon, no outline-plus-fill combos.
   - The dock gets a `原文对照` button (place it after 静音, before the open-in-source link). It opens the dialog landed on the topmost bubble that is visible in the reader viewport, so it continues from where you are reading.
   - Focus returns to whichever control opened the dialog.
4. **Transcript left column states.** No filled box, no background that bleeds to the column edge, no rounded card. State is typographic:
   - rest: gist in `--ink-2`, `#n` and time in `--ink-3`.
   - hover: gist in `--ink`, nothing else moves.
   - active (landed or scroll-spied): gist in `--ink` at weight 600, and the `#n` becomes the filled bucket-colored chip. Only one row is active at a time.
   - focus-visible: the shared focus ring.
   The right column's original for the active message keeps its header; drop any extra highlight there except the same filled `#n` chip.
5. **Time out of the bubble.** The bubble holds only the gist text. Its padding is symmetric and sized for one line, so a one-line bubble is one line tall (about 9px vertical, 14px horizontal; tune by eye). The time renders outside the bubble on its trailing side (right of others' bubbles, left of my own right-aligned bubbles), bottom-aligned with the bubble's last line, 11.5px tabular numerals in `--ink-3`. Omit the time when the previous message in the same sender group is less than 5 minutes earlier. Day separators stay.
6. **Neutral bubbles.** Bubbles drop the bucket-hue tint in both themes (r6 dark bubbles in 要我处理 read brown). Others' bubbles use one neutral surface per theme; my own keep their distinct inverted treatment. Bucket color stays in chrome only: capsule widgets, `#n` chips, the 上次读到这里 divider, point kind labels.
7. **Island insets.** Inside the reader island, the header meta line, title, lede, 自你上次查看, points, the divider, and the stream share one left content edge and one right content edge, from one inset token, and the right inset mirrors the left. In r6 at 1440 the text block started about 45px from the island's left edge but points and divider ended about 125px short of its right edge. Text measure still caps reading lines (about 42em for prose); a capped block aligns to the left edge, while full-width rules (divider, points rows) run edge to edge of the content box. Bubbles may be narrower than the content box but start at the shared left edge (after the avatar column). The capsule's top spacing to the island edge and the content's top spacing below the capsule should read as one rhythm. Report the measured left and right gaps (`getBoundingClientRect`) for each of these blocks at 1440 and 2560.
8. **Open in source.** `在 Gmail 中打开` comes from the conversation's source. The synthetic Teams conversation says `在 Teams 中打开` in the dock and the dialog. Derive the label from the data (`source`/stream label), not from a hardcoded string.
9. **WebKit.** WebKit implements `text-wrap: pretty` as whole-paragraph line balancing; on CJK text every character is a break opportunity, so it shortens every line to lengthen the last one, which leaves a ragged gap of about 100px on the right of 自你上次查看, gists, ledes, and digest lines. Chromium only adjusts the last lines. Evidence: `/Users/senhung/.agent-fold/-Workspaces-random/omp/20261026000140-09d21c6f/yab-webkit-wrap.md` and `wrap.png` (left Chromium, middle WebKit, right WebKit with `text-wrap: wrap`).
   - Replace `text-wrap: pretty` with normal wrapping on every body, gist, lede, update, point, digest, and caption rule. Keep `text-wrap: balance` only on short titles where both engines agree.
   - Then compare folio in Playwright WebKit and Playwright Chromium at 1406x674 and 1440x900, both themes, on: the digest home, the synthetic group chat open, and the transcript dialog open. Fix any other visible divergence you find (dialog backdrop, `backdrop-filter`, scrollbars, View Transitions fallback, `oklch`/`color-mix`, sticky headers). Note that headless WebKit skipped `backdrop-filter` on a sticky header in the earlier investigation while the user's real YAB rendered it, so treat a headless-only `backdrop-filter` gap as test-environment noise unless it also shows up another way.
   - Playwright with its WebKit and Chromium builds is already installed in `/tmp/yabcmp` (`bun add playwright@1` was run there; the investigation scripts are `/tmp/yabcmp/shot.mjs` and `exp.mjs`). Reuse it; run your scripts from that directory or point `NODE_PATH` at it.

## The bar

Read `skill://award-grade-ui` in full and hold to it. This round is polish: every change should make the reader calmer and easier to scan, not add a new signature. Nothing reintroduces the rounded-card-with-left-accent pattern. No content-language words anywhere in visible text, `aria-label`, or `title` (BRIEF-r6 rule 3).

## Verification

- Headless at 1440x900, 2560x1440, and 390x844, light and dark, on run `gpt-6-luna-r5`. Use the synthetic group chat, the synthetic long email thread, the longest real GitHub notification conversation, and a 1-message conversation.
- For each: open the conversation; click a bubble in the middle of the stream and confirm the dialog lands on that message (gist and original top edges within 1px); close it by Esc, by the close control, and by clicking outside; record reader `scrollTop` before and after (must be equal); confirm focus returns to the bubble. Then scroll the reader partway, press the dock `原文对照`, and confirm it lands on the topmost visible bubble.
- Scroll-spy still keeps exactly one active left row; clicking a left row scrolls the right column to it.
- Assert there is no connector element between the columns, no 原文 control inside any bubble, and no time text inside any bubble.
- Time omission rule: in the synthetic group chat, count bubbles with and without a time and spot-check three of each against the 5-minute rule.
- Regression set from BRIEF-r4 (完成 with undo and auto-open of next, 标为未读, 全部清掉, 已清理/恢复) once per theme at 1440.
- Content-language scan as in r6.
- Contrast: re-measure the minimum AA ratio per theme for body text, gists, labels, the time outside bubbles, and left-column rest-state gists (`--ink-2` on the dialog surface must still pass 4.5:1).
- WebKit vs Chromium comparison per change 9; save paired screenshots.
- Screenshots to `/tmp/folio-jury/` first, copied to `ui/shots/` at the end: `folio-1440-{light,dark}-chat.png`, `folio-1440-{light,dark}-transcript-chat.png`, `folio-1440-dark-transcript-github.png`, `folio-2560-dark-chat.png`, `folio-390-dark-chat.png`, `folio-1440-dark-digest.png`, and `folio-1406-dark-{chromium,webkit}-chat.png` plus `folio-1406-dark-{chromium,webkit}-transcript.png`.

## Build notes

- Edit only `ui/folio/`. Do not edit `switch.js`, `ui/index.html`, `base/`, `data/`, or any other direction's directory. The coordinator has already pointed the switcher and `/` at `/ui/folio/`.
- Server: `cd weir-proto && bun ux/serve.ts` serves http://localhost:9347 and is already running. Do not restart it.
- Pitfalls from earlier rounds:
  - The server's `/__reload` SSE fires on any write under `ui/`, including screenshots. Stub `/__reload` in headless sessions and write screenshots to `/tmp/folio-jury/` first.
  - Synthetic keydown must be dispatched on `document.body`; the handler calls `e.target.matches`.
  - `render()` replaces `#app` innerHTML and resets scroll; the dialog must not trigger a full `render()` on open or close, or must restore reader scroll explicitly.
  - `全部清掉` (clearAll) skips the `beforeHide` hook.
  - Sender favicons come from Google S2; a 404 for `ust.hk` is known console noise.
