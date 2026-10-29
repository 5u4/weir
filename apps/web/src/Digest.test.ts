import {
  DigestConflict,
  DigestFailed,
  DigestInterrupted,
  type Event,
  NotFound,
} from "@weir/daemon/Api";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { describe, expect, it } from "vitest";
import {
  type Block,
  closedUi,
  type Detail,
  type ItemSummary,
  reader,
  revealing,
} from "./Blocks.ts";
import {
  cause,
  type DigestEvent,
  earlierLabel,
  hereLabel,
  idle,
  observe,
  payload,
  type Run,
  reason,
  seeded,
  settle,
} from "./Digest.ts";

const item = (seq: number): ItemSummary => ({
  seq,
  occurred_at: `2026-10-20T09:${String(seq).padStart(2, "0")}:00.000Z`,
  from: { name: "Ada", address: "ada@example.com" },
  from_me: false,
  title: null,
  body_new: `message ${seq}`,
});

const detail = (
  seqs: ReadonlyArray<number>,
  digests: ReadonlyArray<readonly [id: number, from: number, to: number]>,
): Detail => ({
  id: 1,
  source: "gmail",
  title: "Northwind",
  first_at: "2026-10-20T09:00:00.000Z",
  last_at: "2026-10-20T09:59:00.000Z",
  tags: [],
  state: { seen_seq: 0, cleared_seq: 0, muted: false, state: "unread" },
  items: seqs.map(item),
  digests: digests.map(([id, from_seq, to_seq]) => ({
    id,
    conversation_id: 1,
    from_seq,
    to_seq,
    headline: `digest ${id}`,
    topics: [],
    trigger: "auto",
    ai_profile: "fake-ai",
    created_at: "2026-10-25T16:00:00.000Z",
  })),
  digest: { backlog: null, earlier: [], now: null, last_failure: null },
});

const heres = (blocks: ReadonlyArray<Block>) =>
  blocks.flatMap((block) =>
    block._tag === "Bubbles"
      ? block.items.map((item, index) => {
          const here = block.heres?.[index];
          return here === undefined
            ? `#${item.seq}: none`
            : `#${item.seq}: ${here.range.from}-${here.range.to} (${here.items}) ${hereLabel(here.items)}`;
        })
      : [],
  );

const tags = (blocks: ReadonlyArray<Block>) =>
  blocks.map((block) =>
    block._tag === "Skeleton"
      ? `Skeleton(${block.items})`
      : block._tag === "Bubbles"
        ? `[${block.items.map(({ seq }) => seq).join(",")}]`
        : block._tag,
  );

const event = (status: DigestEvent["status"], conversation_id = 1): Event => ({
  type: "digest",
  conversation_id,
  from_seq: 8,
  to_seq: 12,
  trigger: "auto",
  status,
});

describe("actions", () => {
  it("send their own payload", () => {
    expect(payload({ _tag: "Now" })).toEqual({});
    expect(payload({ _tag: "From", seq: 5 })).toEqual({ from: 5 });
    expect(payload({ _tag: "UpTo", seq: 9 })).toEqual({ up_to: 9 });
  });

  it("Digest earlier names a partial range by its count", () => {
    expect(earlierLabel({ items: 9, run_items: 9 })).toBe("Digest earlier");
    expect(earlierLabel({ items: 4, run_items: 9 })).toBe("Digest 4 earlier");
  });
});

describe("Digest from here", () => {
  const conversation = detail([1, 2, 4, 7, 9, 10, 15, 16, 18], [[1, 9, 10]]);

  it("runs to the last message before the next digest, counting messages, not seqs", () => {
    expect(heres(reader(conversation, 0, closedUi, null))).toEqual([
      "#1: 1-7 (4) Digest 4 from here",
      "#2: 2-7 (3) Digest 3 from here",
      "#4: 4-7 (2) Digest 2 from here",
      "#7: 7-7 (1) Digest this message",
      "#15: 15-18 (3) Digest 3 from here",
      "#16: 16-18 (2) Digest 2 from here",
      "#18: 18-18 (1) Digest this message",
    ]);
  });

  it("is absent without a [digest] section", () => {
    const off = { ...conversation, digest: { ...conversation.digest, earlier: null } };
    expect(heres(reader(off, 0, closedUi, null))).toContain("#1: none");
  });
});

describe("the skeleton stands where the card will land", () => {
  const conversation = detail([1, 2, 4, 7, 9, 10, 15, 16, 18], [[1, 9, 10]]);
  const blocks = (from: number, to: number) =>
    tags(reader(conversation, 18, closedUi, { from, to }));

  it("Digest now replaces the tail head", () => {
    expect(blocks(15, 18)).toEqual([
      "[1,2,4,7]",
      "GapBar",
      "DigestRow",
      "Skeleton(3)",
      "[15,16,18]",
    ]);
  });

  it("a range ending a run lands under its gap bar or at the end of the tail", () => {
    expect(blocks(4, 7)).toEqual([
      "[1,2,4,7]",
      "GapBar",
      "Skeleton(2)",
      "DigestRow",
      "Tail",
      "[15,16,18]",
    ]);
    expect(blocks(16, 18)).toEqual([
      "[1,2,4,7]",
      "GapBar",
      "DigestRow",
      "Tail",
      "[15,16,18]",
      "Skeleton(2)",
    ]);
  });

  it("a whole run is replaced in place, and a digested range shows none", () => {
    expect(blocks(1, 7)[0]).toBe("Skeleton(4)");
    expect(blocks(9, 10)).not.toContainEqual(expect.stringMatching(/Skeleton/));
  });
});

describe("rejections", () => {
  it("map each error tag to a cause", () => {
    expect(cause(new DigestFailed({ error: "bad json", log_path: "/tmp/run.log" }))).toEqual({
      _tag: "Failed",
      error: "bad json",
      log_path: "/tmp/run.log",
    });
    expect(cause(new DigestConflict({ message: "over max_input" }))).toEqual({
      _tag: "Conflict",
      message: "over max_input",
    });
    expect(cause(new NotFound({ message: "no digest 3" }))).toEqual({
      _tag: "NotFound",
      message: "no digest 3",
    });
    expect(cause(new DigestInterrupted({ message: "reloaded" }))).toEqual({
      _tag: "Interrupted",
      message: "reloaded",
    });
  });

  it("a request that never reaches the daemon is Unreachable, any other client error Unexpected", () => {
    const request = HttpClientRequest.post("http://weir.test/conversations/1/digest");
    const unreachable = cause(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "Failed to fetch" }),
      }),
    );
    expect(unreachable).toEqual({ _tag: "Unreachable" });
    expect(reason(unreachable)).toBe("Couldn't reach weir");
    expect(
      cause(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.EncodeError({ request, description: "bad body" }),
        }),
      ),
    ).toEqual({
      _tag: "Unexpected",
      message: "Encode: bad body (POST http://weir.test/conversations/1/digest)",
    });
  });
});

describe("run state", () => {
  const tab: Run = {
    _tag: "Running",
    range: { from: 1, to: 4 },
    origin: { _tag: "Tab", action: { _tag: "Now" } },
  };
  const remote: Run = { _tag: "Running", range: { from: 8, to: 12 }, origin: { _tag: "Remote" } };
  const failed: Run = {
    _tag: "Failed",
    action: { _tag: "UpTo", seq: 4 },
    range: { from: 1, to: 4 },
    items: 3,
    cause: { _tag: "Interrupted", message: "reloaded" },
  };
  const digestEvent = (status: DigestEvent["status"]) => event(status) as DigestEvent;

  it("queued and running from the daemon start a remote run over the event's range", () => {
    expect(observe(idle, digestEvent("queued"))).toEqual(remote);
    expect(observe(failed, digestEvent("running"))).toEqual(remote);
  });

  it("done and failed end a remote run and leave other states alone", () => {
    expect(observe(remote, digestEvent("done"))).toEqual(idle);
    expect(observe(remote, digestEvent("failed"))).toEqual(idle);
    expect(observe(failed, digestEvent("done"))).toBe(failed);
  });

  it("a run this tab holds ignores the daemon's events for it", () => {
    for (const status of ["queued", "running", "done", "failed"] as const) {
      expect(observe(tab, digestEvent(status))).toBe(tab);
    }
  });

  it("ready clears only remote runs", () => {
    expect(settle(remote)).toEqual(idle);
    expect(settle(tab)).toBe(tab);
    expect(settle(failed)).toBe(failed);
  });

  it("a last failure seeds an idle conversation with a retry from its first message", () => {
    const failure = {
      conversation_id: 1,
      from_seq: 2,
      to_seq: 7,
      trigger: "manual" as const,
      at: "2026-10-25T16:00:00.000Z",
      ms: 12,
      ok: false,
      error: "bad json",
      log_path: "/tmp/run.log",
    };
    expect(seeded(idle, failure, [1, 2, 4, 7, 9].map(item), [])).toEqual({
      _tag: "Failed",
      action: { _tag: "From", seq: 2 },
      range: { from: 2, to: 7 },
      items: 3,
      cause: { _tag: "Failed", error: "bad json", log_path: "/tmp/run.log" },
    });
    expect(seeded(failed, failure, [], [])).toBe(failed);
    expect(seeded(idle, null, [], [])).toBe(idle);
  });

  it("a last failure on a range a digest covers seeds a Redo of that digest and opens its card", () => {
    const failure = {
      conversation_id: 1,
      from_seq: 4,
      to_seq: 7,
      trigger: "manual" as const,
      at: "2026-10-25T16:00:00.000Z",
      ms: 12,
      ok: false,
      error: "bad json",
      log_path: "/tmp/redo.log",
    };
    const read = detail(
      [1, 2, 4, 7, 9],
      [
        [3, 1, 2],
        [8, 4, 7],
      ],
    );
    const run = seeded(idle, failure, read.items, read.digests);
    expect(run).toEqual({
      _tag: "Failed",
      action: { _tag: "Redo", id: 8 },
      range: { from: 4, to: 7 },
      items: 2,
      cause: { _tag: "Failed", error: "bad json", log_path: "/tmp/redo.log" },
    });
    expect(tags(reader(read, 9, closedUi, null))).toEqual([
      "DigestRow",
      "DigestRow",
      "Tail",
      "[9]",
    ]);
    expect(tags(reader(read, 9, revealing(closedUi, run), null))).toEqual([
      "DigestRow",
      "DigestCard",
      "Tail",
      "[9]",
    ]);
    const collapsed = { ...closedUi, shapes: new Map([[8, "row" as const]]) };
    expect(revealing(collapsed, run)).toBe(collapsed);
  });
});
