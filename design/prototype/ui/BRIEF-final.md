# weir final prototype brief (throwaway, but the reference the real build copies)

Read `design/prototype/ui/BRIEF.md`, `BRIEF-r2.md` through `BRIEF-r7.md`, and `BRIEF-r10.md` first. Everything there holds unless this file changes it. Data contract: `design/prototype/CONTRACT.md` plus r5 additions (`Item.gist`, `Conversation.points`). Run `gpt-6-luna-r5` data.

The user picked `ui/seek/` (search lives in the Dynamic Island) plus four grafts. This round also adds the two UI surfaces the design doc specifies that no round built yet (status view with Reload, in-app theme menu), and switches all UI chrome to English, because the real app's UI is English-only. After this round, `ui/final/` is the single reference the implementation copies. No more variants.

## Directory and switcher

1. Move `ui/seek/` to `ui/final/` (copy then delete `seek/`; keep `shots/seek-*.png`). Delete `ui/sift/` and `ui/lens/` (rejected). Leave every other round directory alone.
2. `ui/index.html` redirects `/` to `/ui/final/`.
3. `ui/switch.js`: the direction list shows only `final`. Keep the dev controls (run select, 模拟新消息, 重置). Remove the 主题 button (theme moves into the app, below). Add dev toggles for the status view: "break source" (personal Gmail source reports a sync error) and "break config" (the next Reload fails validation). Dev controls may stay Chinese; they are not product UI.

## Grafts onto seek

1. **Field tokens from sift.** In the capsule query field, `from:<text>`, `in:<bucket>`, and `source:<text>` become removable chips once typed (on space or blur), mirroring `weir-axi search --from --bucket --source`. Chips AND with free-text terms. `in:` accepts a bucket id or display name, case-insensitive. Backspace on an empty field removes the last chip. The results sentence and the brute-force jury must honor chips.
2. **body_new only (from lens).** Original-body matching searches `bodyNew` only, never `bodyQuoted`. A reply must not re-match text it quotes, and a hit must land on a bubble whose original actually shows the term.
3. **Delete the reader results digest.** While searching with no conversation open, the reader island shows a calm empty state (one short line such as "Pick a result to read it."), not a second copy of the result list.
4. **Amber marks in dark mode.** Replace the yellow highlight in dark theme with an amber that is quieter on the near-black ground. Marked text must still measure WCAG AA (4.5) in both themes.

## English UI

All product chrome is English. Content stays as data has it (titles, summaries, gists, points, originals are user/AI content).

- Bucket display names come from config in the real app. In the prototype use: `action` → Action, `fyi` → FYI, `reading` → Reading, `alerts` (the data's notify bucket) → Alerts, unsorted → Unsorted. Keep each bucket's hue.
- Use these exact strings (the design doc's mapping table): Done, Mark unread, Mute, Original, Open in Gmail / Open in Teams (from source label), Clear all, Cleared, Restore, Undo, Unsorted, Re-analyze, Since you last looked, Last read, `N earlier`, Summary / Original (transcript column heads).
- Sentence grammar: one widget → `13 Action has updates.`; two → `13 Action and 12 FYI have updates.`; three or more → `13 Action, 12 FYI, 8 Reading and 31 Alerts have updates.` (no Oxford comma). All zero → `All caught up.` The quiet tail lists read-not-done buckets and Cleared, still clickable; pick a short English lead-in.
- Search strings: field placeholder `Search`, control label `Search`; results sentence `“freeze” appears in 1 Action and 2 Reading.` (same widget grammar, plus a `Cleared` widget when cleared or muted results exist); zero state `Nothing matches “q”.`; state labels on results `Done` and `Muted`; stepper `1/4` with previous/next/close icon buttons labeled `Previous match`, `Next match`, `Close search`.
- Status strings: control label `Status`; view title `Status`; section heads `Sources`, `Enrichment`, `Config`, `Appearance`; `Synced 3m ago`, `Sync failed`, `Reload`, `Reloading…`, `Config loaded`, `Sync and enrich stopped`, theme options `System`, `Light`, `Dark`.
- Times and dates in English short form (`14:03`, `Yesterday`, `Oct 21`).
- Tab title stays `(N) weir`.
- Language rule from BRIEF-r6 still holds: no language names anywhere in visible text, `aria-label`, or `title`.

## Status view (new)

Design doc `design/index.html` §09 (`#reload`, `#no-settings`) is the spec: no settings page, a read-only status view that answers "is it working right now", with Reload.

- Entry point: a small status control in the capsule (full and pill forms). Healthy: quiet. Any source error or config error: an amber dot on it, visible in pill form too. Do not add a third column or move the two columns.
- The view opens inside the reader island, replacing the reader content like opening a conversation (Esc or close returns to what was there, including reader scroll).
- Contents, from fake in-page status data:
  - Sources: each stream (personal Gmail, the synthetic Teams `#release-war-room`) with last sync relative time, item count, and the last error text when "break source" is on.
  - Enrichment: conversations waiting for enrich, last run time and duration, the AI profile name (`luna`), last failure with its log path `~/.weir/logs/enrich/<file>.txt`.
  - Config: path `~/.weir/config.toml`, loaded-at time, and the Reload button.
  - Appearance: theme segmented control System / Light / Dark, stored in localStorage `weir.proto.theme`, applied to `html[data-theme]` (same key and attribute the switcher used).
- Reload flow: button shows `Reloading…` for ~1s (the real daemon waits for in-flight sync and AI calls). Success: `Config loaded` with the new time. With "break config" on: the view lists errors with file and config path (for example `~/.weir/config.toml  bucket[2].ai: unknown AI profile "carefull"` and `prompts/action.md: file not found`), shows `Sync and enrich stopped`, the capsule gets the amber dot, and conversations stay readable. The next Reload with the toggle off clears it. No fallback to a previous config.

## The bar

Read `skill://award-grade-ui` in full and hold to it. Dark is the main mode; light must work. No rounded-card-with-left-accent. The status view must feel like part of the notch shell, not an admin page.

## Verification

Playwright from `/tmp/yabcmp` (has WebKit and Chromium), scripts in `/tmp/final-jury/`, `NODE_PATH=/tmp/yabcmp/node_modules`. Reuse `/tmp/seek-jury/jury.mjs` as the starting point.

- Re-run the seek jury's search checks with brute-force expected sets, now including: a chip query (`from:` plus a term), an `in:` chip, and a term that appears only in some reply's quoted history (assert it does not match via the quoted copy).
- Assert no results digest appears in the reader while searching.
- Contrast of marked text and hit lines, both themes (amber in dark ≥ 4.5).
- Status view: open/close restores reader content and scroll; break source → amber dot in both capsule forms and error text; break config + Reload → errors listed, `Sync and enrich stopped`; toggle off + Reload → cleared; theme control switches `data-theme` and persists across reload.
- English scan: no CJK characters in chrome (visible text excluding conversation content, `aria-label`, `title`). Build the exclusion from the content containers, and report any hits.
- Regression set from BRIEF-r4 once at 1440 dark (Done with Undo and auto-open next, Mark unread, Clear all, Cleared/Restore). Sentence grammar for 1, 2, 3+ widgets and all-zero.
- Screenshots to `/tmp/final-jury/out/` first, then copy into `ui/shots/`: `final-1440-dark-home.png`, `final-1440-dark-reader.png`, `final-1440-dark-search.png`, `final-1440-dark-search-reader.png`, `final-1440-dark-transcript.png`, `final-1440-dark-status.png`, `final-1440-dark-status-error.png`, `final-1440-light-home.png`, `final-390-dark-home.png`, `final-1406-dark-webkit-reader.png`.

## Build notes

- Server: `cd weir-proto && bun ux/serve.ts` on http://localhost:9347 is already running. Do not restart it.
- `/__reload` SSE fires on any write under `ui/`, including screenshots: stub it in headless sessions and write screenshots under `/tmp` first.
- Synthetic keydown on `document.body`; the handler calls `e.target.matches`.
- `render()` replaces `#app` innerHTML and resets scroll; preserve scrolls you promise to restore.
- No `text-wrap: pretty`. Inline SVG icons, not glyphs.
- Throwaway code: no tests, no abstractions, no step-narrating comments. Do not edit `data/`, `base/`, or other round directories.

## r12: empty reader, Cleared at 0, Unsorted first, scrolling pill

- **Empty reader.** With no conversation open and no search, the reader no longer lists the bucket's unread updates (the list already shows them). It shows one of three variants, picked in the dev switcher (`empty: quiet | status | brief`, stored in `weir.proto.dev.empty`, default `status`). The variant applies in every bucket, Cleared included, whether or not anything is pending. The old calm state and its "Elsewhere" and Clear all links are gone, because the expanded capsule above and the list head already carry them.
  - `quiet`: one centered line, `Pick a conversation.` (or `Nothing to read here.` when the list is empty).
  - `status`: one line per source (`Personal Gmail  Synced 3m ago`) and one for enrichment (`Caught up` or `N conversations waiting`), from the same fake status data as the status view. With `break source` the failing source turns amber with its error text. A failed Reload adds `Sync and enrich stopped. The config did not load.` Either way an `Open Status` button opens the full view.
  - `brief`: the bucket's AI brief from `data/runs/<run>/briefs.json`, with a meta line (`Brief of 30 conversations · generated 08:26`) and 2 to 5 lines. Under each line, sender avatars stand for the conversations it drew on. Hovering one lights its row in the list, and clicking opens it in the current bucket. Ids no longer in the bucket are dropped. A missing file or bucket (Unsorted, simulated buckets) shows `No brief yet.`
- **Cleared at 0.** The Cleared widget is not rendered at count 0 in the home tail or the pill. The one exception is while the Cleared tab is the one you are on. With no clause left, the tail element is not rendered.
- **Unsorted first.** Unsorted (no bucket, or a bucket id the config does not know) comes before the configured buckets in the sentence, the tail, the pill and the search groups. Rows still being classified (`pending`) carry a small `Sorting` tag. Rows with an unknown bucket id carry none.
- **Pill.** Only `.cws` scrolls sideways. Search, Cleared and status stay at the ends. The scrollbar is hidden. A 32px edge fade shows on a side only while chips hide past it (`fl`/`fr` classes, `mask-image` plus `-webkit-mask-image`). It updates on scroll and through a ResizeObserver. Each paint keeps the strip's offset. When the active bucket or the open conversation changes, or the pill reappears (opening from home, leaving search), the active chip is centered with `scrollTo` on `.cws`. A vertical wheel over an overflowing strip scrolls it sideways.
- **Home sentence** wraps with any number of buckets. It never truncates.
- **Dev toggles** (`weir.proto.dev.sim`, applied on load, data files untouched): `simulate unsorted` takes the 7 conversations that are unread at the cutoff with the lowest ids, makes 4 of them `pending` with no bucket and gives 3 the unknown id `old-receipts`. `many buckets` adds Travel, Family, Finance, Shopping, School, Health, Home, Projects, Events and Receipts, and spreads every conversation over the 14 buckets by id hash. `HUES` has 14 entries.
- **Jury.** `/tmp/final-jury/jury.mjs` runs the r12 checks in Chromium and WebKit at 1440x900 dark, and the many-bucket sentence check at 1440 light and 390 dark. Screenshots are `shots/final-r12-*.png`.

## r13: no undo, status-only empty reader, Cleared always shown

- **No undo, nothing in the capsule.** Undo is out of the MVP. The capsule toast system is gone with it: no `.cap-toast` element, no toast forms of the capsule, no drain bar, no `Undo` or `View` buttons. Done, Mute, Clear all, Restore and Mark unread give feedback through the row leaving the list and the counts changing. Done and Mute still auto-open the next conversation. The capsule has four forms: `full`, `pill`, `q-full`, `q-pill`.
- **Simulate new message** (switcher) still brings a Done or muted conversation back with a new reply, unread in its bucket. It shows no capsule feedback. With nothing to simulate it logs a `console.info` line.
- **Empty reader is status only.** The `quiet` and `brief` variants, the switcher's `empty` select and the `weir.proto.dev.empty` key are removed. With nothing open the reader shows the sync status lines described in r12. The AI per-bucket brief will not be built: `data/briefs.ts` and `data/runs/gpt-6-luna-r5/briefs.json` are deleted and nothing fetches them.
- **Cleared always shown.** The Cleared widget renders at every count, 0 included, in the home tail and in the pill. The tail sentence therefore always renders and always ends with `Cleared N.`
- **Jury.** `/tmp/final-jury/jury.mjs` drops the undo, toast, quiet, brief and hidden-Cleared checks and adds: no `Undo` text or `.cap-toast` after Done, Mute, Clear all and Restore; the empty reader shows status lines and no list titles; Cleared 0 in the home tail and the pill; simulate new message brings a conversation back unread. Screenshots are `shots/final-r13-*.png`.

## r14: pill scroll chevrons, bucket colors from config

- **Pill chevrons.** A mouse wheel without a horizontal axis, or no wheel habit at all, could not find its way along an overflowing bucket strip. `.cws` now sits in a `.cws-w` wrapper with two chevron buttons overlaid on its ends. They stay put while the strip scrolls. The left one shows exactly when the `fl` fade does and the right one exactly when `fr` does, through a CSS sibling selector, so a strip that fits (the four default buckets at 1440) shows neither and looks as before. A click scrolls by the strip's visible width minus the two 32px fades, smoothly unless reduced motion is set. Repeated clicks end with the last chip fully visible, the right chevron gone and the left one shown. The buttons are labelled `Scroll buckets left` and `Scroll buckets right` and carry `tabindex="-1"`: chips stay in the Tab order and the chevrons add no stop. The icon is the inline SVG chevron the stepper uses, in `--cap-2` on a `--capbg` disc (the search icon's colour and contrast). The fade is now clear for its outer 18px and ramps over the inner 14px, so chips do not show through under the chevron. The vertical-wheel conversion, active-chip centering and Unsorted-first order are unchanged.
- **Bucket colors.** Each `[[bucket]]` in the real config takes an optional `color`, one of 14 palette names. In spread order with their oklch hue: red 29, blue 262, green 158, purple 305, amber 75, cyan 200, pink 350, lime 120, sky 235, orange 50, teal 180, indigo 280, yellow 100, rose 5. An unknown name is a config error in the real app. The prototype does not validate it. The per-theme lightness and chroma (`--bh`, `--bk` in `style.css`) are unchanged.
- **Assignment** (`bucketHues` in `app.js`, the only source of a bucket's hue). Buckets with an explicit color take that slot first. Then, in config order, each bucket without one starts at slot `fnv1a32(id) % 14` (FNV-1a 32-bit over the id's UTF-8 bytes, offset 2166136261, prime 16777619, unsigned) and walks forward through the order above, wrapping, to the first free slot. Past 14 buckets every slot is taken and a bucket keeps its start slot, so hues repeat. A bucket's hue follows its id, not its position, so adding or reordering buckets does not repaint the others. Unsorted and unknown bucket ids stay neutral grey (`--bk:0`). `HUES` and the index-based `hueOf` are gone.
- **Simulated config.** `BUCKET_COLORS` next to `BUCKET_NAMES` stands in for the config: action red, fyi blue, reading and feed green, alerts and notify purple, so the default view keeps its hues. The `many buckets` extras have no color and go through the hash. All 14 get distinct hues.
- **Jury.** `/tmp/final-jury/jury.mjs` adds `r14` checks in Chromium and WebKit at 1440x900 dark (`R14_ONLY=1` runs only them): no chevrons with the default buckets; with `many buckets`, right clicks reach the last chip, then right hidden and left shown, and left clicks return to 0; exact labels and `tabindex="-1"`; search, Cleared and status keep their x; chevron contrast against the search icon in both themes; default hues 29, 262, 158, 305; the 14 hues equal an assignment the jury recomputes from this spec; Unsorted neutral. Screenshots are `shots/final-r14-*.png`.
