# weir prototype data contract

Throwaway, but the real build copies its shapes. All input is synthetic and committed: `data/scenarios.json` and `data/tags.toml`. `bun data/digest.ts` expands the scenarios, tags the conversations, runs the auto digests with the AI CLI and writes `data/out/data.json` and `data/out/timing.md`, both committed; per-call logs go to the ignored `data/out/logs/`. `ui/final/` reads `data/out/data.json` and `ux/serve.ts` rewrites it on manual digests. `bun data/digest.ts --structure` writes the same file without digests and without model calls.

## RawItem (what a source plugin hands over)

```ts
type RawItem = {
  externalId: string
  threadId: string | null        // gmail thread, Teams chat, or a Teams channel post's root; channels group by containerId
  containerId: string            // gmail label, Teams chat or channel
  containerName: string
  title: string
  link: string
  occurredAt: string             // ISO; ai_since compares against this, never against sync time
  from: { name: string; address: string }
  body: string                   // markdown; the plugin converts the source format
  bodyNew: string                // markdown, quoted history and signature stripped; the digest threshold counts these chars
  raw: unknown                   // what the plugin keeps of the source API response; tag rules point into it. The gws plugin
                                 // keeps Gmail users.messages.get(format=full) minus MIME body.data and transport and
                                 // signature headers (design/index.html#raw); Teams keeps the Graph chatMessage.
}
```

There is no `to`, `cc`, `mentions`, `attrs` or `labels`: a rule that needs them reads `raw` (`/raw/payload/headers`, `/raw/labelIds`, `/raw/mentions`). Changing a plugin's fetch format (for example Gmail `full` to `metadata`) silently changes what rules see.

## Scenarios (`data/scenarios.json`)

The prototype loader stands in for the plugins. `scenarios.json` holds frozen, hand-written data about a fictional user, Robin Ellis (`robin.ellis@example.com`); every person, company and domain is fictional (`example.com`, `*.example`), except public senders such as `notifications@github.com`.

```ts
type Scenarios = {
  seenCutoff: string                    // simulated "last time I opened weir"; items at or before it are read
  me: string                            // key of the user in people
  people: Record<string, { name: string; addr: string; bot?: true; signature?: string }>
  chats: { id: string; kind: "chat" | "dm" | "channel"; title: string; members: string[]; messages: { at: string; from: string; text: string; post?: string }[] }[]
  threads: { id: string; subject: string; labels: string[]; headers?: Record<string, string>; messages: { at: string; from: string; to: string[]; cc?: string[]; text: string }[] }[]
}
```

`expand()` in `data/digest.ts` turns it into plugin-shaped records, deterministically:

- Teams: one item per message; `raw` is a Graph chatMessage with `from.user` (or `from.application` for bots), `body` as HTML, `mentions[]` for every `@Name` or `@First` of a chat member, `messageType`, `replyToId` (channel replies point at their post's root), `chatId` or `channelIdentity`, `@odata.type`. Graph user ids are a hash of the address; Robin's is `cd40ef40-540e-43c4-a09d-cc3aacb7cdc8`.
- Gmail: one item per message; `raw` is what the gws plugin would keep: `id` (a millisecond timestamp in the high bits, as Gmail's), `threadId`, `labelIds`, `snippet`, `sizeEstimate`, `internalDate`, and a `multipart/alternative` `payload` with `text/plain` and `text/html` parts that carry `body.size` but no `body.data`. Payload headers: `MIME-Version`, `Date`, `Message-ID`, `Subject`, `From`, `To`, `Content-Type`; `In-Reply-To` and `References` on replies; `Cc` when there is one; the thread's extra headers (such as `List-Unsubscribe`) on messages not from me. A message from me has `labelIds: ["SENT"]`, plus the thread labels when it is addressed to me; other messages carry the thread labels. `containerId` is the first category label, else `SENT`, else `INBOX` (`containerName` Promotions, Updates, Social, Forums, Primary, Sent, Inbox). `bodyQuoted` holds the sender's signature, and on a reply the previous message with its signature, quoted; list mail (a thread with `List-ID`) quotes nothing.

## Rules and tags (`data/rule.ts`, `data/tags.toml`)

`Rule` is an Effect Schema recursive union tagged on `type` (`and`, `or`, `not`, `eq`, `regex`, `exists`, `some`, `every`) with JSON Pointer targets, decoded with `onExcessProperty: "error"`. `match(rule, input)` runs over one item's input:

```ts
type RuleInput = { source; threadId; containerId; containerName; title; from: { name; address }; fromMe; body; raw }
```

A tag applies to a conversation when any of its items matches. `[tag_state]` in `tags.toml` is prototype only: it stands in for the daemon's `tag_state` table (`ai_since` per `ai = true` tag).

## data.json

```ts
type Data = {
  generatedAt: string
  seenCutoff: string             // simulated "last time I opened weir"
  me: { addrs: string[]; names: string[] }
  digest: { threshold: number; maxInput: number; context: number }
  tags: { name: string; ai: boolean; aiSince: string | null }[]   // config order; the product ships none
  sources: { id: "gmail" | "teams"; name: string }[]               // filter views, not tags
  items: Item[]
  conversations: Conv[]
  digests: Digest[]
}

type Item = {
  id: string; source: "gmail" | "teams"; sourceLabel: string
  threadId: string | null; containerId: string; containerName: string; title: string
  from: { name: string; addr: string }
  occurredAt: string; bodyNew: string; bodyQuoted: string; link: string
  conversationId: string; seq: number   // 1-based, per conversation, arrival order
  fromMe: boolean
}

type Conv = {
  id: string                     // "c-" + (Teams: containerId, Gmail: threadId)
  source: "gmail" | "teams"; kind: "email" | "chat" | "dm" | "channel"; title: string
  itemIds: string[]; lastSeq: number; seenSeq: number; firstAt: string; lastAt: string
  tags: string[]                 // user tag names, [] means the Untagged view
  since: string | null           // earliest ai_since among its ai = true tags; null: no auto digests
}

type Digest = {
  id: string; conversationId: string
  fromSeq: number; toSeq: number // never overlaps another digest of the conversation; gaps allowed
  trigger: "auto" | "manual"
  headline: string
  topics: { title: string; state: "open" | "resolved" | "fyi"; body: string; seqs: number[] }[]
  contextChars: number; inputChars: number; ms: number; model: string; createdAt: string
}
```

Raw objects are not copied into data.json; tags are computed from them when the file is built. `bun data/rule-bench.ts` times the rules over the expanded items, or over a directory of Gmail JSON files given as its argument.

## Endpoints (`ux/serve.ts`)

- `POST /__digest {conversationId, fromSeq?, upTo?, whole?, redo?: {fromSeq, toSeq}}`, one variant per request (when several are sent, `manualRange` in `data/digest.ts` reads `redo`, then `fromSeq`, then `upTo`):
  - none of them: Digest now, range (last digest's `toSeq`, last seq].
  - `fromSeq`: Digest from here, range [fromSeq, next digest's `fromSeq` - 1], or to the last seq when no digest follows.
  - `upTo`: Digest earlier, a range that ends at `upTo` (an undigested seq; the reader sends a gap's last seq). `whole: true`: it starts after the previous digest's `toSeq` (or at seq 1). Otherwise it walks back from `upTo` while the summed `bodyNew` chars stay within `digest.maxInput` (24000), takes at least `upTo` itself, and never crosses the previous digest. `generate` chunks a range over `maxInput` as for every other range.
  - `redo`: the exact range of an existing digest, which the new digest replaces (it keeps the old `trigger`).

  Answers `{replaced, digests}`; 409 when the range is empty, when `fromSeq` or `upTo` is outside the conversation or inside a digest, when `redo` names no existing digest's exact range, or when the range would overlap one; 404 for an unknown conversation; 502 with the last error when generation fails. Requests run one at a time. The reader models the request as `{kind: "now"} | {kind: "here", fromSeq} | {kind: "earlier", upTo} | {kind: "redo", id}` and sends `whole` from the dev switcher's `earlier: step | run`.
- `POST /__sim {conversationId, from, text}`: the dev switcher's simulated Teams message. Appends it and, in an AI-enabled conversation, digests at once when the text since the last digest reaches the threshold.
