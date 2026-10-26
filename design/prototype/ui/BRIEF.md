# weir UI round brief (throwaway prototype)

weir is a local, read-only aggregation inbox. A daemon syncs mail (later Teams, calendar) into sqlite, an AI enricher groups items into **conversations** (one conversation can merge several mail threads) and sorts each conversation into a user-defined **bucket** with a zh-CN title, summary, and a one-line `update` ("what is new since you last looked"). The user reads English slowly, so the zh-CN summary and update carry most of the reading; the English originals are the record. The user's own agents query weir separately; the web UI is for the human.

The UX round is decided. Every visual direction implements exactly this interaction:

- **Navigation B.** One tab per bucket (config order), plus an `已清理` tab. A greeting sentence above the tabs counts unread conversations per bucket, e.g. `你有 2 个「要我处理」、14 个「值得知道」有更新。`
- **Split reader.** List on the left, reader on the right. Opening a row opens the reader beside the list. No in-place expansion, no focus mode.
- **Read state is per conversation.** Opening a conversation marks it read. The reader has `标为未读`. Unread rows are visually distinct.
- **Leaving sight is D1, manual done.** `完成` hides the conversation and selects the next row. It returns as unread when a newer item arrives. `静音` hides it permanently even when new items arrive. Each bucket has `全部清掉`. Every hide shows a ~5s undo toast. `已清理` lists hidden conversations with `恢复`.
- **Row content.** Title, one line (the `update` when unread, else the first sentence of the summary), participants, item count, source tag, relative time. Only the important information. Detail lives in the reader.
- **Reader content, in this order of importance.** What this is (title, summary). What changed since I last looked (`update`, unread items highlighted). How it relates to me (`直接发给我`, `抄送我`, `我参与过`, merged-thread note). The originals (per-item sender, time, source tag, rendered body, quoted history folded, earlier read items collapsed to `之前的 N 条`, `在 Gmail 中打开`).
- **Keyboard is not a design axis.** Keep whatever minimal keys exist (j/k/e/Esc). Do not design around shortcuts.

Data: `/data/runs/<slug>/data.json` per `weir-proto/CONTRACT.md`, real Gmail data, 186 conversations, buckets from the enricher.

## Visual directions

Each direction is a full design: list, tabs, greeting, reader, toasts, empty states, the 已清理 tab. All three share the same data and behavior; they differ in visual language, composition, and the signature moment.

### ink, 邸报

- **Point of view.** weir reads like a morning dispatch edited for one person: the Chinese lede first, the English originals filed beneath as the archival record.
- **Signature moment.** `完成` presses a vermilion seal (`阅`) onto the row with a short ink-press scale and slight rotation, then the row folds shut and the list closes the gap.
- **Language.** Warm paper ground, near-black ink, one vermilion accent, hairline rules. Serif CJK for titles and summaries (Noto Serif SC), a text serif for English bodies (Newsreader or Source Serif 4), small mono or small caps for metadata. Reader set like an article: comfortable measure, summary as a standfirst, `update` as a vermilion margin note.

### weir, 堰

- **Point of view.** Mail is a river; the weir holds the flow back so only what matters rises to you.
- **Signature moment.** Each bucket tab carries a water-level gauge proportional to its pending count. `完成` sends the row down past a crest line and the tab's level drops on one spring easing while the greeting count ticks.
- **Language.** Calm dark ground (deep blue-slate), one water-teal accent, soft foam whites. Geometric sans (Geist or Inter) with Noto Sans SC, tabular numerals. Reader timeline drawn as one continuous stream line connecting items; earlier read items sit collapsed in a "deep water" band.

### instrument, 仪表

- **Point of view.** A precision instrument for a heavy reader: maximum information per glance, nothing decorative.
- **Signature moment.** The `上次读到这里` marker. Opening a conversation scrolls the reader to a full-width rule at the last-read point, and unread items below it light up with one quick highlight sweep.
- **Language.** Neutral warm-gray light theme, compact 13px base, Inter with PingFang SC / Noto Sans SC, JetBrains Mono for metadata and counts. Dense single-line rows with aligned columns. Reader header packs bucket, state, relevance chips, and actions into two tight lines.

## Award-grade bar

Follow `skill://award-grade-ui` (concept, references, build, jury pass). Time-boxed prototype: cut breadth, keep depth. Desktop 1440x900 is the primary surface (localhost only). At 390x844 the list goes full width and the reader becomes a full-screen sheet with a back control; that is the only mobile requirement. `prefers-reduced-motion` gets a designed fallback. Animate only `transform` and `opacity`.
