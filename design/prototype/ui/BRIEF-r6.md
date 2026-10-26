# weir UI round 6 brief: stream reader, original in a modal, dark mode (throwaway prototype)

Read `weir-proto/ui/BRIEF.md`, `BRIEF-r2.md`, `BRIEF-r3.md`, `BRIEF-r4.md`, then `BRIEF-r5.md`. Everything there still holds unless this file changes it. `weir-proto/CONTRACT.md` plus the r5 additions (`Item.gist`, `Conversation.points`) is the data contract.

## Round 5 verdict from the user

- `stream` (对话流) is the chosen reader. It reads clearer than `outline`. `pager` is rejected: no timeline rail, no left/right paging. `pager/` has been deleted.
- The 自你上次查看 block: the user likes pager's treatment and dislikes the rounded box with a left accent border used by stream and outline ("太 AI 了"). Pager's CSS was exactly:
  ```css
  .r-update { margin: 0 0 14px; padding: 2px 0 2px 14px; box-shadow: inset 3px 0 var(--cl, var(--ink)); max-width: 42em; font-size: 15.5px; line-height: 1.7; font-weight: 600; color: var(--ink); text-wrap: pretty; }
  .r-update .r-label { display: inline; margin: 0 0.8em 0 0; font-size: 12px; color: var(--ink-3); }
  ```
  markup `<p class="r-update"><span class="r-label">自你上次查看</span>${update}</p>`: no fill, no radius, a straight 3px rule, the label inline before bold text. Use that. Do not reintroduce the rounded-card-with-left-accent pattern anywhere (bubbles, points, modal, callouts).
- After toggling a bubble to its original, stream showed a back button labelled `中文`. The UI must not name a content language anywhere. The summary language is a user setting of the enricher, so the UI cannot know it. Chrome text stays in the UI locale (Chinese is fine); what is banned is naming the language of content: no 中文, 英文, Chinese, English in visible text, `aria-label`, or `title`. Refer to the AI layer as 摘要 and to the source text as 原文. Do not hardcode `lang="en"` on originals or `lang="zh"` on gists; omit `lang` unless the data carries one.
- The 原文 control must not expand in place. It opens a modal. This round explores what that modal is.
- Dark mode. The user works in dark mode, so dark is a first-class theme, designed, not inverted.

## The question this round answers

1. When you check the original of one message, should the modal be scoped to the reader island or to the whole page, and should it show just that message or the whole conversation's originals?
2. What does weir look like in dark mode?

## Shared rules (all three directions)

1. **Base.** Start from a copy of `ui/stream/{index.html,app.js,style.css}`. Keep everything stream has: the notch shell (flat list column, reader island, capsule inset in the island's top edge that shrinks to a pill while reading), the digest empty state, bottom dock, bucket nav, conversation-level read state, 完成 with undo and auto-open of next, 标为未读, 静音, 全部清掉, 已清理/恢复, the folding context card, gist bubbles grouped by sender, day separators, the 上次读到这里 divider and landing, 之前 N 条 collapse, points jump, and the 390x844 sheet layout.
2. **自你上次查看** uses the pager treatment quoted above, inside the stream context card. When the card folds to one line, nothing changes from stream.
3. **No content-language words** (see verdict). The per-bubble control is a quiet 原文. Nothing in a bubble toggles in place anymore; remove `ui.orig` in-place swapping, `b-back`, and the `中文` button.
4. **原文 opens a modal**, shaped per direction below. Every modal:
   - is a real dialog: `role="dialog"`, `aria-modal="true"`, labelled by its header; focus moves into it and returns to the 原文 control that opened it; Tab stays inside.
   - closes on Esc, on a visible close control, and on a click outside its surface.
   - shows the original in full by default (no clamp: the modal is where full text lives), at a reading measure of about 68ch, with 显示引用 for quoted history.
   - has a header with sender, avatar, time, `#n`, the source label, and that message's gist as a lede, so the 摘要 and the 原文 can be compared.
   - scrolls internally; the page behind does not scroll while it is open.
   - leaves the reader exactly as it was: same reader scroll position and same folded/unfolded context card after close (record `scrollTop` before open and after close; they must be equal).
   - renders bodies better than r5: strip the inline HTML tags listed in BRIEF-r5 rule 8, render fenced code blocks (```` ``` ````, including GitHub `suggestion` blocks) as `<pre>`, and keep plain line breaks as line breaks instead of turning each line into a list item. Only real `- `/`* `/`1. ` list runs become lists.
5. **Dark mode.**
   - Theme contract: `document.documentElement.dataset.theme` is `"light"` or `"dark"`. Each direction's `index.html` gets an inline script in `<head>` (before the stylesheet paints) that reads `localStorage["weir.proto.theme"]` (`"system"` | `"light"` | `"dark"`, default `"system"`), resolves `"system"` through `matchMedia("(prefers-color-scheme: dark)")`, sets the attribute, and while on `"system"` follows OS changes. `/ui/switch.js` (owned by the coordinator, already updated) has a 主题 button that cycles system/light/dark, writes the key, and sets the attribute directly.
   - All colors go through custom properties; `:root[data-theme="dark"]` overrides them. No hardcoded colors left in component rules.
   - Design dark, do not invert. Ground near-black, the reader island one step lighter with a hairline edge instead of a drop shadow, the flat list on the ground, the capsule still the darkest object with a faint ring so it separates from the island. Bucket colors retuned per theme. Favicons and letter avatars sit on a plate that reads on dark. Bubbles, my own right-aligned bubbles, points, chips, the divider, the dock, toasts, focus rings, scrollbars (`color-scheme`), and the modal and its backdrop all have dark values.
   - Contrast: body text, gists, lede, labels, and bucket-colored small text meet WCAG AA (4.5:1) on their real backgrounds in both themes; measure with a script and report the minimum per theme.
6. `DEFAULT_RUN = "gpt-6-luna-r5"`.

## Directions

Each must look and feel clearly different at a glance in the modal; outside the modal they are the same stream reader.

### sheet, 岛内抽屉

- **Scope:** the reader island only. The list column stays visible and undimmed.
- **Form:** the original rises from the island's bottom edge as a sheet covering most of the island's height (leave the top of the stream visible and dimmed behind it, inside the island). The sheet's corner radii are concentric with the island's.
- **Signature moment:** the notch pill morphs into the sheet's title (sender, `#n`) while the sheet is up, and shrinks back to the pill on close.
- **Content:** one message.
- Clicking a list row while the sheet is open closes it and opens that conversation. At 390x844 the sheet takes the full height.
- **Question:** does keeping the original inside the island keep your place better than a page-level dialog?

### lightbox, 居中对话框

- **Scope:** the whole page, dimmed and softly blurred behind.
- **Form:** a centered dialog about 760px wide, max-height about 86vh.
- **Signature moment:** the bubble grows into the dialog (View Transition or FLIP) and the dialog shrinks back into the same bubble on close.
- **Content:** one message.
- **Question:** is a focused page-level dialog the clearest way to check one original?

### transcript, 原文对照

- **Scope:** the whole page; the dialog spans roughly the stage width (the list column plus the island) and most of the viewport height.
- **Form:** two columns inside the dialog. Left, a narrow column of every message's gist in order (the 摘要 side). Right, every message's original in order, each with its header. The dialog opens scrolled to the clicked message, which is marked; scrolling the right side keeps the matching gist highlighted on the left (scroll-spy), and clicking a gist on the left scrolls the right side to it. Read history is not collapsed here.
- **Signature moment:** opening lands precisely on the clicked message with its gist and its original aligned on the same horizontal line.
- **Content:** the whole conversation.
- At 390x844 the left column becomes a top strip or is dropped; the dialog is full screen.
- **Question:** when checking an original, do you want the surrounding conversation, not just one message?

## The bar

Read `skill://award-grade-ui` in full and hold to it. The gists and the original carry the reading; their legibility is the floor in both themes. One signature moment per direction, named above.

## Build notes

- Copy `ui/stream/{index.html,app.js,style.css}` into `ui/<direction>/`. Keep `window.weirDev` and the `/ui/switch.js` script tag. Do not edit `switch.js`, `ui/index.html`, `base/`, `data/`, or any other direction's directory.
- Server: `cd weir-proto && bun ux/serve.ts` serves http://localhost:9347 and is already running. Do not restart it. `/ui/<direction>/` is the URL.
- Verify in a headless browser at 1440x900, 2560x1440, and 390x844, in light and in dark, on the r5 run. For each of the synthetic group chat, the synthetic long email thread, the longest real GitHub notification conversation, and a 1-message conversation: open the conversation, open 原文 on a message in the middle of the stream (the last message for the 1-message one), screenshot the modal, close it each of the three ways, and record reader `scrollTop` before and after. Check focus return. Check 显示引用 inside the modal. For transcript, check landing alignment and scroll-spy. Run the regression set from BRIEF-r4 (完成 with undo and auto-open of next, 标为未读, 全部清掉, 已清理/恢复) once per theme at 1440. Scan the rendered DOM text plus every `aria-label` and `title` for 中文, 英文, Chinese, English and report zero hits. Measure contrast per theme.
- Screenshots: at minimum `<direction>-1440-{light,dark}-chat.png`, `<direction>-1440-{light,dark}-modal-chat.png`, `<direction>-1440-dark-modal-github.png`, `<direction>-2560-dark-modal-thread.png`, `<direction>-390-dark-modal-chat.png`, `<direction>-1440-dark-digest.png`.
- Pitfalls from earlier rounds:
  - The server's `/__reload` SSE fires on any write under `ui/`, including screenshots. Stub `/__reload` in headless sessions and write screenshots to `/tmp/<direction>-jury/` first, then copy them to `ui/shots/` at the end.
  - Synthetic keydown must be dispatched on `document.body`; the handler calls `e.target.matches`.
  - `render()` replaces `#app` innerHTML and resets scroll; the modal must not trigger a full `render()` on open or close, or must restore reader scroll explicitly.
  - `全部清掉` (clearAll) skips the `beforeHide` hook.
  - Sender favicons come from Google S2; a 404 for `ust.hk` is known console noise.
