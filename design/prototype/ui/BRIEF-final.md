# weir final prototype brief (throwaway, but the reference the real build copies)

`ui/final/` is the single reference. It is the round-3 digest prototype (topic briefs) moved onto the final design: structural conversations, digests as immutable non-overlapping seq ranges, and user-written tags instead of buckets. The design doc `design/index.html` is the spec; `CONTRACT.md` is the data contract. Earlier round briefs and the explorations they describe are in git history; they still hold for the shell (two islands, notch capsule, list rows, Done/Mute/Clear all/Restore, search field tokens, `body_new`-only search, amber marks, status view with Reload, theme control) wherever this file does not change them. Bucket, enrich, Unsorted/Sorting, gist, summary, update, points and asks are gone.

## Data

`bun data/digest.ts` builds `data/out/data.json` (committed, with `data/out/timing.md`) from the synthetic `data/scenarios.json` and `data/tags.toml`; a fresh checkout runs the prototype without the AI CLI. The scenarios are about a fictional user, Robin Ellis; each one keeps a UI path alive:

| scenario | conversation | exercises |
|---|---|---|
| on-call chats, many topics | `c-teams:payments-oncall`, `c-teams:release-war-room` | multi-segment auto digests, several topics per digest; the war room is all read and opens at the bottom |
| project chat over three weeks | `c-teams:q4-billing-migration` | long history before `ai_since` as a `Not digested` gap with Digest earlier |
| short DM | `c-teams:dm-hannah` | under the threshold: raw tail, the `N of 1,000` meter, Digest now |
| Teams channel | `c-teams:eng-announcements` | a channel with several posts is one conversation; Untagged |
| email thread where I reply | Northwind cutover | quoting, `fromMe`, the Me rule; replies before `ai_since` form a gap |
| one long personal email | Mom's 60th | single-topic digest |
| GitHub notifications, four threads | `[ledgerline/...]` subjects | the `GitHub` rule on the From header |
| promotions with `List-Unsubscribe` | Ridgeway trail packs, Saltmarsh Lisbon offer | `Promos` |
| loyalty mail in Primary, To only me | Kokoro Ramen "your table is waiting" | a Me misfire excluded with `not` |
| bank alerts, a newsletter, a note to myself | Northbank card and deposit alerts, The Pragmatic Ledger, Acme summary outline | Untagged noise; mail to myself is `fromMe` but not Me |

`seenCutoff` in `scenarios.json` splits read from unread. From the expanded items the build derives:

- Conversation key: source + (`threadId ?? containerId`); a Teams channel is one conversation.
- Tags: `data/rule.ts` matches each item's rule input (normalized fields plus `raw`); a conversation carries a tag when any item matches. `tags.toml` is example user config (`Me`, `On-call` with `ai = true`; `GitHub`, `Promos` without). The product ships zero tags.
- Auto digests only in conversations with an `ai = true` tag, from `since` (earliest `ai_since`) on, immediately when `bodyNew` chars since the last digest reach the `threshold` in `tags.toml` (1000); ranges over 24000 chars are cut into chunks. Model call and prompt as round 3 (`data/prompts/digest-topics.md`, `gpt-6-luna`), without asks.
- Manual: `POST /__digest` (Digest now, Digest from here, Digest earlier, Redo). See `CONTRACT.md`.

## Capsule and list

- One view at a time in the left list: a user tag or `Untagged` (conversations with no tag), plus `Cleared`. Sources have no views; a per-source view is a tag whose rule matches `/source`.
- Sentence: user tags with unread, then `Untagged`, as widgets (`5 Me, 2 On-call and 9 Untagged have updates.`); the tail lists read-but-not-done and clear tags, then `Cleared` with its count. Each user tag takes a hue in config order; `Untagged` stays neutral.
- `in:` search chips take a tag name or `Untagged`, case-insensitive (`in:Me`, `in:untagged`). `source:` stays as a search filter, not a view.

## Reader

One view: the digest view. Originals stay reachable through each topic's `N originals` and as raw runs (messages no digest covers). Top to bottom inside the reader island:

1. Header: view names, `N new this time`, `N messages · N people` (distinct senders), date span. No To you / Cc you, no `You replied`.
2. Read digests (`toSeq <= seenSeq` when opened): one row each, `Oct 24 14:02–16:40 · 41 messages · <headline>`; click opens the card in place, `Collapse` folds it back; more than 4 collapse under `N earlier digests`.
3. `Last read` before the first unread block, a collapsed unread row included.
4. Unread digest cards: meta (time span · N messages, `Manual`), headline, topics (state mark, title, body, `N originals`). One-topic digests hide the topic title and state mark but keep headline, body and `1 original`. Every card has `Collapse` (an unread card folds into the same one-line row as a read digest until clicked; per session, not stored) and `Redo` (regenerates the same range and replaces it; `Redoing…` while it runs).
5. Originals outside every digest (history before `since`, gaps) render as original bubbles in place. A gap ends with a slim bar between its last bubble and the digest below it (where scrolling up from newer content arrives): `Not digested`, `N messages above` and `Digest earlier`, the mirror of the tail's Digest now. Digest earlier takes, by default (`step`), what one model call holds walking back from the gap's last message: `bodyNew` chars up to `max_input` (24000), at least one message, never past the previous digest; the button then reads `Digest K earlier` when that is less than the gap. The dev switcher's `run` takes the whole gap. The new card opens between the bar and the digest below, the bar keeps its place on screen and its count shrinks (it goes when the gap is empty). `Digesting…`, then `Couldn't digest N messages` with `Try again` on failure.
6. Un-digested tail: `Not digested`, the `N of 1,000` meter (the configured threshold) only in AI-enabled conversations, and `Digest now`; a skeleton card stands in while the call runs.
7. Digest from here: every bubble of a gap or the tail offers `Digest N from here` (`Digest this message` on the last one), which digests from that message to the end of its run. A chip floats over the bubble's inner top corner on hover or focus inside the message (Tab reaches it); on touch a tap on the bubble shows it and a tap elsewhere hides it. Originals unfolded under a topic have none. While Digest from here, Digest earlier or Digest now is hovered or focused (or the bubble is tapped on touch), the bubbles it would digest take a rail and a tint in the tag hue. Neither the chip nor the preview moves a bubble. Whatever a manual digest lands opens as a card, never under `N earlier digests`; that fold sits where its first hidden digest was.

Landing on open: at `Last read` when there is one, otherwise at the bottom (the latest message). Going back from search or Status restores the scroll position.

Signature moment, unchanged from round 3: `N originals` unfolds the topic's messages inline; the topic head pins at the top of the reader with `n of N` and `Fold` while you scroll through them. Reduced motion: a crossfade.

## Status view

As before (Sources, Digests, Config, Appearance), with Digests listing `AI on` (each `ai = true` tag with its `ai_since` and conversation count), `Queue` (running digest calls or conversations waiting), last run, threshold and AI profile.

## Dev switcher (`ui/switch.js`)

`final` only; `模拟新消息` (stores a Teams message through `POST /__sim`; the server auto-digests when the threshold is reached), `重置状态`, `break source`, `break config`, `earlier：step | run` (how far Digest earlier reaches back).

## Verification

`/tmp/final-jury/*.mjs` live outside the repo and were written against the earlier `data/runs/digest-final/data.json`; point them at `data/out/data.json` before reuse.

`/tmp/final-jury/jury.mjs` against `PORT=9348 bun ux/serve.ts`, at 1440 dark, 1440 light and 390 dark. It backs up `data.json`, restores it at the end, and copies screenshots to `ui/shots/final-*.png`.

`/tmp/final-jury/r15.mjs` (same server, 1440 and 390) checks the `Untagged` rename, the landing without `Last read`, collapsing an unread card under `Last read`, the gap bar's request and busy and error states, and the `of 1,000` meter.

`/tmp/final-jury/r16.mjs` (same server, 1440 and 390 with touch, dark and light) checks that no Original toggle or `o` shortcut is left, Digest from here on hover, focus and tap with its range preview and no bubble shift, the Digest earlier bar with its preview, its `step` and `run` requests, busy and error states, and the bar keeping its place when a stubbed digest lands. `node r16.mjs --real` backs up `data.json`, makes one real Digest earlier and one real Digest from here call, and restores it. r16 supersedes the `o`-driven Original checks in `jury.mjs` and the top-of-gap bar checks in `r15.mjs`; both look for UI that round 16 removed.
