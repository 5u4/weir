# weir UI round 3 brief (throwaway prototype)

Read `weir-proto/ui/BRIEF.md`, then `weir-proto/ui/BRIEF-r2.md`. Their product description, interaction contract (Navigation B, split reader, per-conversation read state with 标为未读, D1 manual 完成, undo toasts, 全部清掉, 已清理 with 恢复, row content, reader content order, 390x844 sheet) and the sentence-as-navigation rules (grammar at every count combination, quiet tail for read-but-pending buckets and 已清理) all still hold. This file records the user's verdict on round 2 and what changes.

## Round 2 verdict from the user

- `field` (color floods) is rejected and deleted.
- `sentence` was understood correctly: the greeting sentence with avatar-stack widgets as bucket navigation is right. But the sentence is far too big. Set it at normal reading size, not display size.
- The sender favicon avatars are liked. Keep them in the sentence widgets and in rows.
- On open, the split stretches across the whole viewport. The user is on a wide monitor (assume 2560x1440 and wider), so the whole screen changes when a conversation opens. That is too much change. Try an **island** design.
- "Make a few more."

## What changes

1. **Sentence at normal size.** The greeting sentence reads like a heading of a calm page, roughly 20 to 26px at 1440, never display size. It still carries the avatar-stack widgets, counts, and bucket names, and still works as the only bucket navigation. Boldness has to come from composition, material, color, and motion, not giant type.
2. **Islands.** Content lives on floating panels (islands) set on a ground: rounded, separated from the ground by spacing, tone, and restrained depth, never edge to edge. The home is one centered island (or a small cluster) holding the sentence and the selected bucket's rows.
3. **Bounded split.** Opening a conversation brings in the reader as its own island. The total composition width is capped (a stage of roughly 1200 to 1440px), centered on the ground, so at 2560 and 3440 wide the ground stays visible on both sides and most of the screen does not change. Closing returns to the home island. It is a transition, not a cut: `transform` and `opacity`, View Transitions allowed. Respect `prefers-reduced-motion`.
4. **390x844.** Islands collapse to full-width sheets with small margins; the reader is a sheet over the list, as before.

## The bar

Read `skill://award-grade-ui` in full and hold to it. Bold here means a committed composition and material with one signature moment built to perfection. It does not mean big type, decoration, or lower legibility of the zh-CN summary, which carries most of the reading. The user found `instrument` "OK but not bold enough" and liked the favicons; legibility and information per glance from instrument are the floor.

## Directions

All three share the data, behavior, and changes above. Each must look clearly different from the other two.

### twin, 双岛

- **Point of view.** Two equal citizens. List and reader are a pair of islands that belong together.
- **Composition.** Home: one island about 720 to 760px wide, centered, holding sentence and rows. Open: the list island narrows to about 400 to 440px and shifts left while the reader island (about 760 to 860px) appears to its right; the pair stays centered as one group inside the capped stage.
- **Signature moment.** The reader island grows out of the clicked row: the row's rectangle morphs into the reader island (shared-element View Transition or a FLIP), so the eye follows the conversation into its reader.
- **Language.** Your call within the bar. A tinted or mid-tone ground so islands read as objects.

### anchor, 锚定

- **Point of view.** Nothing you were looking at moves. The list is an anchor.
- **Composition.** Home: the list island is centered. Open: at viewports wide enough (stage cap plus margins), the list island does not move at all; the reader island docks to its right as a floating panel. When the viewport is too narrow for that, the list shifts left only by the minimum needed. Define and implement that rule exactly.
- **Signature moment.** The reader docks with a physical feel: it slides in from the right edge of the list island, attached at a shared seam or tether, and the list's selected row visibly connects to the reader (an indicator, a seam highlight, or a connecting shape).
- **Language.** Your call within the bar. Distinct from twin.

### capsule, 胶囊

- **Point of view.** Apple's Dynamic Island as the control surface. weir's state lives in one floating capsule.
- **Composition.** The greeting sentence with its widgets lives in a floating capsule island near the top center. With no conversation open, the capsule is expanded (the full sentence) above a centered list island. When a conversation opens, the capsule contracts to a compact form (widgets with counts, the active one marked) while list and reader islands sit below it inside the capped stage.
- **Signature moment.** The capsule is live. Undo toasts (完成, 静音, 全部清掉, 恢复) do not appear elsewhere: the capsule morphs to show the toast with its 撤销, then morphs back, and counts update in place. Morphs animate size and shape with transform and opacity (or View Transitions), never layout-thrashing width animation on large trees.
- **Language.** Your call within the bar. A dark capsule over a light ground is the obvious read; choose deliberately.

## Build notes

- Start by copying `ui/sentence/{index.html,app.js,style.css}` into `ui/<direction>/`. It already implements the full interaction, the sentence grammar, avatar widgets with favicon and monogram fallback, data loading (`DEFAULT_RUN = "gpt-6-luna-low"`), `window.weirDev`, and loads `/ui/switch.js`. Keep `weirDev` and the switch script tag. Do not edit `switch.js`, `base/`, `instrument/`, `gauge/`, `sentence/`, or another direction's directory. `switch.js` already links all three new directions.
- Server: `cd weir-proto && bun ux/serve.ts` serves http://localhost:9347 (already running; do not restart it). `/ui/<direction>/` is the URL.
- Verify in a headless browser at 1440x900, 2560x1440, and 390x844: home, bucket switch, open, close, 完成 with undo, 全部清掉, 已清理 with 恢复, 标为未读, all-zero sentence. Capture the signature moment as frames. Measure at 2560x1440 how much of the viewport's area changes between home and open (for example, the bounding box of changed islands as a share of the viewport) and report the number. Check WCAG AA contrast for body text and the summary.
- Pitfalls observed in earlier rounds:
  - The server's `/__reload` SSE fires on any write under `ui/`, including screenshots. Stub `/__reload` in headless sessions (route it to an empty response) and write screenshots to `/tmp` first, then copy them to `ui/shots/<direction>-*.png` at the end.
  - In `sentence`, rows have no `.head`; click the title text. Synthetic keydown must be dispatched on `document.body`; the handler calls `e.target.matches`.
  - `render()` replaces `#app` innerHTML and resets scroll; preserve scroll and split state explicitly if your transition needs it.
  - `全部清掉` (clearAll) skips the `beforeHide` hook.
  - Sender favicons come from Google S2; that is accepted for the prototype only.
