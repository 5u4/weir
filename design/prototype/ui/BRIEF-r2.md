# weir UI round 2 brief (throwaway prototype)

Read `weir-proto/ui/BRIEF.md` first. Its product description, interaction contract (Navigation B semantics, split reader, per-conversation read state, D1 manual done, undo toasts, 全部清掉, 已清理 with 恢复, row content, reader content order, 390x844 sheet) and award-grade bar all still hold. This file changes three things and adds a bar.

## Round 1 verdict from the user

Round 1 had three directions. `ink` (邸报, warm paper serif) and `weir` (堰, dark water) are rejected and deleted. `instrument` (仪表, dense warm-gray Inter/JetBrains Mono) "looks OK" and survives as `ui/instrument/`, but none of the three was bold enough.

## What changes

1. **Centered composition.** With no conversation open, the page is one centered column on a full-bleed ground. No sidebar, no full-width list.
2. **The greeting sentence is the navigation.** Delete the tab bar. The user's model is the home of a macOS mail app (frame: `/Users/senhung/.agent-fold/-Workspaces-random/omp/20261025060009-63c66b21/zaynhao-mail.mp4`, read it with `:1s`): `晚上好，Zayn。你有 [avatars] 1 封来信、[avatars] 15 篇待读 和 [avatars] 3 条通知。` For weir that reads like the user's own example: `你有 11 个「要我处理」、12 个「值得知道」、8 个「订阅阅读」、31 个「通知」有更新。` Each bucket clause is an inline **widget**: a small overlapping avatar stack of up to 3 distinct senders from that bucket's unread conversations, the count, and the bucket name. Clicking a widget selects that bucket; the selected widget is visibly active. Rules:
   - Avatars: sender-domain favicon (`https://www.google.com/s2/favicons?domain=<domain>&sz=64`), monogram fallback for personal domains (gmail.com, outlook.com, qq.com, 163.com, icloud.com) and on image error. Monogram colors are deterministic per sender.
   - Every bucket and `已清理` stays reachable from the sentence region, including buckets with 0 unread but still pending (read, not done). Choose your own grammar for that quieter tail, for example `另有 4 个已读未清。` and an `已清理 42` entry.
   - The sentence must read as grammatical Chinese at every count combination: one clause, several clauses (`、` and a final `和`), and all zero (an empty state that still lets the user reach pending and cleared).
   - The bucket list (rows) for the selected bucket sits below the sentence in the same centered column.
3. **Split on open, centered on close.** Opening a row turns the centered column into the list column of a split and brings the reader in to its right, as in the reference video. Closing the reader (close control, `Esc`, or the last conversation leaving via `完成`) returns to the centered home. This is a transition, not a cut. Prefer `transform` and `opacity`; the View Transitions API is allowed. When the reader is open, the sentence condenses but stays usable as navigation.

Row cards keep only the important information (title, one line, participants, count, source, time). The reader shows as much detail as fits; its content order is unchanged.

## The bar

Bold means a committed visual language: display type used as image, decisive color, a composition that takes a stand, one signature moment built to perfection. Bold does not mean decoration, gradients for their own sake, or reduced legibility of the zh-CN summary, which carries most of the reading for a user who reads English slowly.

## Directions

All three share the data, behavior, and changes above.

### gauge, 刻度

- **Point of view.** `instrument`, the direction the user liked, pushed to conviction: a precision readout for a heavy reader.
- **Signature moment.** Each sentence widget is a compact readout with oversized tabular numerals. `完成` rolls the count down odometer-style in the sentence while the row leaves.
- **Language.** Keep instrument's density and information per glance. Raise contrast: near-white ground with near-black ink and one loud signal accent (international orange or similar), monumental tabular numerals, mono metadata, hard hairline grid. Centered column wide enough for dense rows.

### sentence, 一句话

- **Point of view.** weir's whole state is one sentence; the home is that sentence set at display size.
- **Signature moment.** The sentence is live. Counts change in place, a clause whose bucket empties drops out and the sentence re-flows into new grammar (`、` and `和` move, the final clause collapses to `全部看完了。`), animated with transform and opacity.
- **Language.** Typography as image: the greeting set very large (roughly 56 to 88px at 1440), a bold CJK display face with a matched Latin grotesk, stark monochrome ground, one strong color per bucket used only on its widget. When the reader opens, the sentence condenses into a one-line header and the list slides under it.

### field, 色场

- **Point of view.** Each bucket is a place with its own color; switching bucket changes where you are.
- **Signature moment.** Clicking a widget floods the ground with that bucket's color from the clicked widget outward (a scaled circle or View Transition, not animated `background-color` on large areas), and the centered column of cards settles in.
- **Language.** Saturated, confident per-bucket color fields with carefully tuned foreground contrast (WCAG AA for body text on every field), large rounded cards on the field, generous space. Opening a card morphs it into the reader's header (View Transitions shared element is fine).

## Build notes

- Start by copying `ui/instrument/{index.html,app.js,style.css}` into `ui/<direction>/`. It already implements the full interaction, data loading (`DEFAULT_RUN = "gpt-6-luna-low"`), `window.weirDev`, and loads `/ui/switch.js`. Keep `weirDev` and the switch script tag. Do not edit `switch.js`, `base/`, `instrument/`, or another direction's directory.
- Server: `cd weir-proto && bun ux/serve.ts` serves http://localhost:9347 (already running; do not restart it). `/ui/<direction>/` is the URL.
- Pitfalls observed in round 1:
  - The server's `/__reload` SSE fires on any write under `ui/`, including screenshots. Stub `/__reload` in headless sessions (route it to an empty response) and write screenshots to `/tmp` first, then copy them to `ui/shots/<direction>-*.png` at the end.
  - Row clicks need to target the row's `.head` element.
  - Synthetic keydown must be dispatched on `document.body`; the handler calls `e.target.matches`.
  - `render()` replaces `#app` innerHTML and resets scroll; preserve scroll and the split state explicitly if your transition needs it.
  - `全部清掉` (clearAll) skips the `beforeHide` hook.
