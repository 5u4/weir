# Digest run timing

Measured by `bun data/digest.ts` on 2026-10-28 (data.json written 2026-10-28T19:13:15.601Z) over the synthetic `data/scenarios.json`. Config `data/tags.toml`: threshold 1000 chars of `bodyNew`, max input 24000, context 6000. Read state: items at or before 2026-10-22T18:00:00.000Z count as read.

- Model `gpt-6-luna`; command `omp -p --no-tools --no-session --no-skills --no-rules --no-extensions --no-title --model gpt-6-luna --thinking low`, prompt on stdin, template `data/prompts/digest-topics.md`.
- Concurrency 6 across conversations; calls inside one conversation run in order. Up to 3 attempts per range.
- The auto chain replays arrival order: after each item, `autoRange(items so far, digests so far, since, threshold)`; a hit is cut into chunks of at most 24000 chars.

## Counts

- Items: 474. Conversations: 19 (gmail 14, teams 5).
- Tags (conversations, overlapping): Me 6 (ai, since 2026-10-20T00:00:00-07:00), On-call 2 (ai, since 2026-10-20T00:00:00-07:00), GitHub 4, Promos 2; Untagged 7.
- AI-enabled conversations: 6; with at least one auto digest: 5.
- Auto digests: 24 of 24 planned. Ranges that were cut into more than one chunk: 0.
- Items covered by a digest in AI-enabled conversations: 299 of 440; items before `since` (left as originals): 105.

## Calls

- Calls: 24 (24 ok, 0 failed after 3 attempts; 0 ok on a retry). Wall 75192 ms.
- Latency per call, ms (includes retries): min 3673, median 5163, p90 7005, max 7839.
- Prompt input chars: median 7302, max 11394. Context chars: median 1528.


## AI-enabled conversations

| conversation | tags | since | items | before since | auto digests |
|---|---|---|---|---|---|
| c-1a16be78f202d53f | Me | 2026-10-20T00:00:00-07:00 | 1 | 0 | #1-#1 |
| c-teams:q4-billing-migration | Me | 2026-10-20T00:00:00-07:00 | 125 | 85 | #86-#91 #92-#98 #99-#105 #106-#112 #113-#119 |
| c-teams:dm-hannah | Me | 2026-10-20T00:00:00-07:00 | 19 | 11 | none |
| c-1a13b6643008cfae | Me | 2026-10-20T00:00:00-07:00 | 13 | 9 | #10-#13 |
| c-teams:payments-oncall | Me, On-call | 2026-10-20T00:00:00-07:00 | 234 | 0 | #1-#16 #17-#30 #31-#46 #47-#62 #63-#76 #77-#92 #93-#110 #111-#127 #128-#150 #151-#169 #170-#184 #185-#204 #205-#222 |
| c-teams:release-war-room | Me, On-call | 2026-10-20T00:00:00-07:00 | 48 | 0 | #1-#10 #11-#18 #19-#28 #29-#38 |

## All conversations

| conversation | kind | title | items | read | tags |
|---|---|---|---|---|---|
| c-1a170fb9ba0d604b | email | Card purchase: $1,284.00 at SALTMARSH TRAVEL | 1 | 0 | Untagged |
| c-1a16f2d444047255 | email | Robin, your table is waiting | 1 | 0 | Untagged |
| c-1a16be78f202d53f | email | Mom's 60th: plan, dates and money | 1 | 0 | Me |
| c-teams:q4-billing-migration | chat | Q4 billing migration | 125 | 108 | Me |
| c-1a16a8455a0b0a13 | email | [ledgerline/billing-api] Run failed: CI - main (a3f9c21) | 1 | 0 | GitHub |
| c-1a16a7ed76026dfd | email | Card purchase: $42.18 at KOKORO RAMEN | 1 | 0 | Untagged |
| c-teams:dm-hannah | dm | Hannah Kim | 19 | 18 | Me |
| c-teams:eng-announcements | channel | Engineering / Announcements | 17 | 13 | Untagged |
| c-1a164a0760009f81 | email | [ledgerline/ledger-web] Payout dashboard shows duplicate rows after a retry (Issue #1312) | 2 | 1 | GitHub |
| c-1a13b6643008cfae | email | Northwind migration: cutover plan and UAT sign-off | 13 | 11 | Me |
| c-1a1691d72a022557 | email | Robin, your weekend list: 30% off trail packs ends Sunday | 1 | 0 | Promos |
| c-1a168d8c88069839 | email | The Pragmatic Ledger #212: idempotency keys are not enough | 1 | 0 | Untagged |
| c-1a1670f05001e0b3 | email | Acme incident summary: outline | 1 | 0 | Untagged |
| c-teams:payments-oncall | chat | payments-oncall | 234 | 207 | Me, On-call |
| c-1a15fc18340a7ac4 | email | [ledgerline/billing-api] Batched backfill for invoice_line_items (PR #4818) | 3 | 2 | GitHub |
| c-teams:release-war-room | chat | release-war-room | 48 | 48 | Me, On-call |
| c-1a15f6b740010be5 | email | [ledgerline/billing-api] Enforce unique (tenant_id, idempotency_key) on invoices (PR #4821) | 3 | 3 | GitHub |
| c-1a1637d52c04150f | email | Direct deposit received: $4,862.30 | 1 | 1 | Untagged |
| c-1a1612113402d3ce | email | Last call: 2 nights for the price of 1 in Lisbon | 1 | 1 | Promos |
