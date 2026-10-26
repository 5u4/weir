# weir prototype data contract

Throwaway. The data slice writes `data/data.json`; the UX shell reads it (or `ux/fixture.json` until real data exists).

```ts
type Data = {
  generatedAt: string            // ISO
  me: string[]                   // my addresses, lowercased
  seenCutoff: string             // ISO; simulated "last time I opened weir". Items after it are unread.
  buckets: { id: string; name: string }[]   // display order = array order
  items: Item[]
  conversations: Conversation[]
  enrichRuns: EnrichRun[]        // timing evidence; UX may ignore
}

type Item = {
  id: string                     // gmail message id
  source: "gmail"
  sourceLabel: string            // short tag shown in the timeline, e.g. "Gmail · INBOX"
  threadId: string | null        // strong grouping (gmail threadId)
  containerId: string            // where it was said (primary label)
  from: { name: string; addr: string }
  to: { name: string; addr: string }[]
  cc: { name: string; addr: string }[]
  subject: string
  occurredAt: string             // ISO
  bodyNew: string                // plain text, quoted history and signature stripped
  bodyQuoted: string             // the stripped part, may be ""
  link: string                   // deep link, e.g. https://mail.google.com/mail/u/0/#all/<threadId>
}

type Conversation = {
  id: string
  title: string                  // in config language (zh-CN)
  bucket: string | null          // bucket id; null = 未分类
  summary: string                // whole-conversation summary, zh-CN
  update: string | null          // one sentence: what the items after seenCutoff added; null if none
  itemIds: string[]              // chronological
  threadIds: string[]            // gmail threads merged into this conversation (>1 means AI merged)
  mergeReason: string | null     // why the AI merged threads, if it did
  firstAt: string
  lastAt: string
}

type EnrichRun = {
  stage: "group" | "summarize" | "incremental"
  batch: number
  conversations: number
  items: number
  inputChars: number
  outputChars: number
  ms: number
  ok: boolean
  error?: string
}
```

## r5 additions

`data/r5.ts` writes `data/runs/gpt-6-luna-r5/data.json`: the `gpt-6-luna-low` run plus two synthetic long conversations authored in `data/synthetic.json`, with these fields added. `bun data/check-r5.ts` validates them.

```ts
type Item = Item & {
  source: "gmail" | "teams"       // "teams" only on the synthetic group chat
  gist: string                    // zh-CN (simplified), one sentence, ≤ ~40 Chinese chars: what this message adds
  synthetic?: true                // authored test content; sourceLabel ends with "（合成）"
}

type Conversation = Conversation & {
  points: Point[]                 // 0-5, most important first; [] when nothing qualifies (receipts, notices)
}

type Point = {
  kind: "ask" | "decision" | "date" | "info"   // ask = requested of me specifically
  text: string                    // zh-CN short phrase
  itemId: string                  // the item in this conversation the point comes from
}

type EnrichRun = EnrichRun & { stage: "group" | "summarize" | "incremental" | "digest" }
```
