# weir UI round 4 brief (throwaway prototype)

Read `weir-proto/ui/BRIEF.md`, `weir-proto/ui/BRIEF-r2.md`, then `weir-proto/ui/BRIEF-r3.md`. Their product description, interaction contract (Navigation B, split reader, per-conversation read state with 标为未读, D1 manual 完成 that auto-opens the next conversation, undo toasts, 全部清掉, 已清理 with 恢复, row content, reader content order, 390x844 sheet), the sentence-as-navigation rules (grammar at every count combination, quiet tail for read-but-pending buckets and 已清理), the 22px sentence, favicon avatars, and the capsule mechanics all still hold. This file records the user's verdict on round 3 and what changes.

## Round 3 verdict from the user

- `capsule` is liked. The Dynamic-Island capsule (sentence expanded on home, compact when reading, undo toasts morph out of it, counts roll in place) is the keeper.
- `anchor` is liked for one property: nothing you were looking at moves. Its downside is that the composition is not centered on a wide screen.
- `twin` got no comment. It stays in the switcher for reference.
- The user asks for a **persistent two-column layout** (常驻双栏): list and reader are both on screen from the first paint, so opening a conversation no longer changes the composition and the capsule is the only thing that changes shape.
- The user asks to try **a flat left column with an island on the right**: the list sits directly on the ground, not on a panel; only the reader is a floating island.
- "Make a few more."

## What changes

1. **Persistent two columns.** From first paint, the stage holds the list column on the left and the reader column on the right. Opening, switching, and closing a conversation swap the reader's content only. No column moves, resizes, appears, or disappears on open or close. The stage is capped (about 1240 to 1440px total) and centered on the ground, so at 2560 and 3440 wide the ground stays visible on both sides.
2. **Reader empty state.** With no conversation open (first load, after Esc or close, after the last conversation in a bucket is 完成), the reader column is not blank. It shows a digest of the selected bucket: the bucket name and count, then one line per unread conversation with its `update` line (or the first sentence of its summary when there is no update), each clickable to open it. Never auto-open a conversation on load, because opening marks it read. When the bucket is empty, show a calm "这里看完了" state with the quiet tail of other buckets.
3. **Capsule.** Starts from `capsule`'s behavior. Expanded (the full sentence) when no conversation is open, compact (widgets with counts, active one marked) when one is open, and every undo toast morphs out of it. Each direction decides where the capsule lives; see below.
4. **390x844.** Keep the r3 behavior: list full width, reader as a sheet over it, capsule at top.

## The bar

Read `skill://award-grade-ui` in full and hold to it. The zh-CN summary carries most of the reading; its legibility is the floor. Bold comes from composition, material, and one signature moment, not from big type.

## Directions

All three share the data, behavior, and changes above. Start each from a copy of `ui/capsule/{index.html,app.js,style.css}`; keep capsule's visual language (dark capsule, cool light ground) unless the direction says otherwise, because the user liked it. The directions differ in column treatment and where the capsule lives. Each must look clearly different from the other two at a glance.

### pier, 双岛常驻

- **Columns.** Both columns are islands: a list island about 400 to 440px and a reader island about 780 to 880px, with a 16 to 24px gutter, centered as one group in the stage.
- **Capsule.** Floats above the stage at top center, as in `capsule`.
- **Question it answers.** Does capsule plus persistent islands feel calm enough, with the capsule as the only moving part?

### quay, 平栏加岛

- **Columns.** The list column is flat: no panel, no shadow, no rounded container. Rows sit directly on the ground, separated by hairlines or spacing; the ground tone is the list's surface. The reader is the only island, raised above the ground, so the eye knows where reading happens.
- **Capsule.** Floats above the stage at top center.
- **Selected row.** Since the list has no panel, the selected row needs a clear but quiet mark that ties it to the reader island (for example a tint that matches the island, or the row visually lifting toward it). Your call.
- **Question it answers.** Does flat-left plus island-right read as calmer and more "app-like" than two islands?

### notch, 岛上刘海

- **Columns.** Same flat left column as quay. The reader is the only island.
- **Capsule.** Fused into the top edge of the reader island, like the Dynamic Island cut into a phone: centered on the reader island's top edge, half overhanging it or sitting just inside it. Expanded state carries the full sentence across the reader's width; compact state shrinks to a pill on the reader's top edge. Undo toasts morph out of it in place.
- **Signature moment.** The capsule and the reader island are one object: when a conversation opens, the capsule contracts into the island's edge and the reader content rises under it; when the last conversation in the bucket is 完成, the capsule expands back into the sentence over the digest.
- **Question it answers.** Is "the reader is the device, the capsule is its island" a stronger idea than a capsule floating over the whole stage?

## Build notes

- Copy `ui/capsule/{index.html,app.js,style.css}` into `ui/<direction>/`. Keep `window.weirDev` and the `/ui/switch.js` script tag. Do not edit `switch.js`, `index.html` at `ui/`, `base/`, or any other direction's directory; `switch.js` already links pier, quay, and notch.
- Server: `cd weir-proto && bun ux/serve.ts` serves http://localhost:9347 and is already running. Do not restart it. `/ui/<direction>/` is the URL.
- Verify in a headless browser at 1440x900, 2560x1440, and 390x844: first load (empty reader digest), bucket switch, open from the list, open from the digest, close with Esc, 完成 with undo and auto-open of the next, 完成 on the last conversation in a bucket (reader returns to empty state), 全部清掉, 已清理 with 恢复, 标为未读, all-zero sentence. Capture the signature moment as frames. Measure at 2560x1440 and 1440x900 the share of viewport pixels that change between first load and an open conversation, and separately the share inside vs outside the reader column. Report the numbers. Check WCAG AA contrast for body text, the summary, and list rows on the flat ground.
- Pitfalls observed in earlier rounds:
  - The server's `/__reload` SSE fires on any write under `ui/`, including screenshots. Stub `/__reload` in headless sessions (route it to an empty response) and write screenshots to `/tmp` first, then copy them to `ui/shots/<direction>-*.png` at the end.
  - Synthetic keydown must be dispatched on `document.body`; the handler calls `e.target.matches`.
  - `render()` replaces `#app` innerHTML and resets scroll; preserve list scroll and reader state explicitly, since the columns are now persistent.
  - `全部清掉` (clearAll) skips the `beforeHide` hook.
  - Sender favicons come from Google S2; accepted for the prototype only. A 404 for `ust.hk` falls back to a monogram and is known console noise.
