import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliver,
  expireHistory,
  FIXTURE_NOW,
  relabel,
  remove,
  seedMailbox,
  seedThreads,
  setDelay,
  setNow,
} from "@weir/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import scenarios from "../scenarios.json" with { type: "json" };
import { fakeGws, gmail, listAll } from "./fake-gws.ts";

const scenarioMessages = scenarios.threads.flatMap((t) =>
  t.messages.map((m) => ({ thread: t.id, ...m })),
);
const at = (iso: string) => Date.parse(iso);

const dirs: string[] = [];
const tempMailbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-gws-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const snapshot = (dir: string) =>
  readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]);

type Part = { mimeType: string; body: { data?: string }; parts?: Part[] };
const plainBody = (payload: Part): string => {
  const part =
    payload.mimeType === "text/plain"
      ? payload
      : payload.parts?.find((p) => p.mimeType === "text/plain");
  return Buffer.from(part?.body.data ?? "", "base64url").toString("utf8");
};

describe("fake-gws default mailbox", () => {
  it("pages every Gmail scenario thread within newer_than:30d at FIXTURE_NOW", () => {
    const { threads, messages, pages } = listAll({ q: "newer_than:30d" });
    expect(threads).toHaveLength(scenarios.threads.length);
    expect(threads).toHaveLength(15);
    expect(messages).toHaveLength(scenarioMessages.length);
    expect(new Set(messages.map((m) => m.id)).size).toBe(32);
    expect(pages).toBeGreaterThan(1);
  });

  it("serves bodies that start with the scenario text", () => {
    const bodies = listAll({ q: "" }).messages.map((m) => plainBody(m.payload as Part));
    for (const m of scenarioMessages) {
      expect(bodies.some((b) => b === m.text || b.startsWith(`${m.text}\n\n`))).toBe(true);
    }
  });

  it("lists system labels by id and user labels under their own id", () => {
    const { labels } = gmail("labels list", { userId: "me" });
    expect(labels).toEqual(
      expect.arrayContaining([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
        { id: "Label_1", name: "Receipts", type: "user" },
      ]),
    );
  });

  it("lists a thread under a label when any of its messages carries it", () => {
    const scenarioOf = (threadId: string) => {
      const { messages } = gmail("threads get", { userId: "me", id: threadId });
      const subject = messages[0].payload.headers.find(
        (h: { name: string }) => h.name === "Subject",
      ).value;
      return scenarios.threads.find((t) => t.subject === subject)?.id;
    };
    for (const label of ["INBOX", "CATEGORY_PROMOTIONS", "Label_1"]) {
      const { threads } = listAll({ labelIds: [label] });
      expect(threads.map(scenarioOf).sort(), label).toEqual(
        scenarios.threads
          .filter((t) => t.labels.includes(label))
          .map((t) => t.id)
          .sort(),
      );
    }
    const sent = listAll({ labelIds: ["SENT"] });
    expect(sent.messages.some((m) => !m.labelIds.includes("SENT"))).toBe(true);
  });

  it("returns a whole thread oldest first, my SENT-only replies included", () => {
    const reply = listAll({ labelIds: ["SENT"] }).messages.find(
      (m) => m.labelIds.join() === "SENT",
    );
    const thread = gmail("threads get", { userId: "me", id: reply?.threadId, format: "full" });
    const expected = scenarios.threads.find((t) => t.id === "northwind-cutover")?.messages ?? [];
    expect(thread.messages.map((m: { internalDate: string }) => Number(m.internalDate))).toEqual(
      expected.map((m) => at(m.at)),
    );
  });

  it("answers an unknown thread id with a gws 404", () => {
    const run = fakeGws([
      "gmail",
      "users",
      "threads",
      "get",
      "--params",
      '{"userId":"me","id":"0"}',
    ]);
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      error: { code: 404, message: "Requested entity was not found.", reason: "notFound" },
    });
    expect(run.stderr).toBe("error[api]: Requested entity was not found.\n");
  });

  it("answers an unknown label id with a gws 400", () => {
    const run = fakeGws([
      "gmail",
      "users",
      "threads",
      "list",
      "--params",
      '{"userId":"me","labelIds":["Receipts"]}',
    ]);
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout).error).toMatchObject({ code: 400, reason: "invalidArgument" });
  });

  it("reports the profile and the single send-as identity", () => {
    expect(gmail("getProfile", { userId: "me" })).toMatchObject({
      emailAddress: "robin.ellis@example.com",
      messagesTotal: 32,
      threadsTotal: 15,
    });
    const { sendAs } = gmail("settings sendAs list", { userId: "me" });
    expect(sendAs).toHaveLength(1);
    expect(sendAs[0]).toMatchObject({
      sendAsEmail: "robin.ellis@example.com",
      displayName: "Robin Ellis",
      isPrimary: true,
      isDefault: true,
    });
  });

  it.each([
    [["--page-all"], { userId: "me" }],
    [["--dry-run"], { userId: "me" }],
    [[], { userId: "me", labelIds: ["INBOX", "SENT"] }],
    [[], { userId: "me", q: "from:someone" }],
    [[], { userId: "me", fields: "threads(id)" }],
  ])("rejects unsupported input %j %j with a validation exit", (flags, params) => {
    const run = fakeGws([
      "gmail",
      "users",
      "threads",
      "list",
      ...flags,
      "--params",
      JSON.stringify(params),
    ]);
    expect(run.exitCode).toBe(3);
    expect(JSON.parse(run.stdout).error.reason).toBe("validationError");
    expect(run.stderr).toMatch(/^error\[validation\]: /);
  });

  it.each([
    ["messages", "list"],
    ["messages", "get"],
  ])("rejects the unimplemented command %s %s", (...method) => {
    const run = fakeGws(["gmail", "users", ...method, "--params", '{"userId":"me"}']);
    expect(run.exitCode).toBe(3);
  });

  it("rejects formats other than full", () => {
    const run = fakeGws([
      "gmail",
      "users",
      "threads",
      "get",
      "--params",
      '{"userId":"me","id":"0","format":"metadata"}',
    ]);
    expect(run.exitCode).toBe(3);
  });
});

describe("fake-gws --mailbox", () => {
  it("excludes mail at or before the newer_than cutoff as now moves", () => {
    const dir = tempMailbox();
    seedMailbox(dir);
    const boundary = "2026-10-23T08:05:00-07:00";
    setNow(dir, "2026-11-22T08:05:00-07:00");
    const expected = scenarios.threads.filter((t) =>
      t.messages.some((m) => at(m.at) > at(boundary)),
    ).length;
    expect(expected).toBeLessThan(15);
    expect(listAll({ q: "newer_than:30d" }, dir).threads).toHaveLength(expected);
    expect(listAll({ q: "" }, dir).threads).toHaveLength(15);
  });

  it("rejects impossible clocks before writing the mailbox", () => {
    for (const impossible of ["2026-13-25T09:00:00-07:00", "2026-02-29T09:00:00-07:00"]) {
      const fresh = tempMailbox();
      expect(() => seedMailbox(fresh, { until: impossible })).toThrow(impossible);
      expect(snapshot(fresh)).toEqual([]);

      const seeded = tempMailbox();
      seedMailbox(seeded);
      const before = snapshot(seeded);
      expect(() => setNow(seeded, impossible)).toThrow(impossible);
      expect(snapshot(seeded)).toEqual(before);
    }
  });

  it("records deliveries, deletions and label changes as history", () => {
    const dir = tempMailbox();
    const until = "2026-10-24T12:00:00-07:00";
    const pendingCount = scenarioMessages.filter((m) => at(m.at) > at(until)).length;
    expect(seedMailbox(dir, { until })).toMatchObject({
      delivered: 32 - pendingCount,
      pending: pendingCount,
    });
    const start = gmail("getProfile", { userId: "me" }, dir).historyId;

    const [added] = deliver(dir);
    if (!added) throw new Error("nothing delivered");
    const listed = listAll({}, dir).messages;
    const trashed = listed.find(
      (m) => m.id !== added && listed.filter((n) => n.threadId === m.threadId).length === 1,
    );
    if (!trashed) throw new Error("no single-message thread to relabel");
    expect(() => relabel(dir, trashed.id, { add: ["Receipts"] })).toThrow(/no label Receipts/);
    relabel(dir, trashed.id, { add: ["TRASH"] });
    remove(dir, added);

    const all = gmail("history list", { userId: "me", startHistoryId: start }, dir);
    expect(all.historyId).toBe(String(Number(start) + 3));
    expect(all.history.map((h: { id: string }) => h.id)).toEqual(
      [1, 2, 3].map((n) => String(Number(start) + n)),
    );
    expect(all.history[0].messagesAdded[0].message.id).toBe(added);
    expect(all.history[1].labelsAdded[0]).toMatchObject({
      message: { id: trashed.id },
      labelIds: ["TRASH"],
    });
    expect(all.history[2].messagesDeleted[0].message.id).toBe(added);

    const labelsOnly = gmail(
      "history list",
      { userId: "me", startHistoryId: start, historyTypes: "labelAdded" },
      dir,
    );
    expect(labelsOnly.history).toHaveLength(1);
    expect(labelsOnly.history[0].messagesAdded).toBeUndefined();

    const visible = listAll({}, dir);
    expect(visible.threads).not.toContain(trashed.threadId);
    expect(visible.messages.map((m) => m.id)).not.toContain(added);
    expect(gmail("getProfile", { userId: "me" }, dir).messagesTotal).toBe(32 - pendingCount);
  });

  it("answers 404 for a history id older than the floor after expireHistory", () => {
    const dir = tempMailbox();
    seedMailbox(dir, { until: FIXTURE_NOW });
    const before = gmail("getProfile", { userId: "me" }, dir).historyId;
    expireHistory(dir);
    const run = fakeGws(
      [
        "gmail",
        "users",
        "history",
        "list",
        "--params",
        JSON.stringify({ userId: "me", startHistoryId: before }),
      ],
      dir,
    );
    const current = gmail("getProfile", { userId: "me" }, dir).historyId;
    expect(Number(current)).toBeGreaterThan(Number(before));
    expect(gmail("history list", { userId: "me", startHistoryId: current }, dir)).toEqual({
      historyId: current,
    });
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout).error).toMatchObject({ code: 404, reason: "notFound" });
  });

  it("sleeps before answering only the commands named in delay", () => {
    const dir = tempMailbox();
    seedMailbox(dir);
    setDelay(dir, { "threads list": 1500 });
    const timed = (command: string) => {
      const start = performance.now();
      const answer = gmail(command, { userId: "me" }, dir);
      return { answer, ms: performance.now() - start };
    };
    const list = timed("threads list");
    const profile = timed("getProfile");
    expect(list.ms).toBeGreaterThanOrEqual(1500);
    expect(list.answer.threads).toHaveLength(10);
    expect(profile.ms).toBeLessThan(1500);
    expect(profile.answer.messagesTotal).toBe(32);
  });

  it("seeds given threads as delivered mail with the given page size", () => {
    const dir = tempMailbox();
    const threads = Array.from({ length: 3 }, (_, i) => ({
      id: `bulk-${i}`,
      subject: `Bulk ${i}`,
      labels: ["INBOX"],
      messages: [
        { at: `2026-10-2${i}T09:00:00-07:00`, from: "priya", to: ["me"], text: "Question" },
        { at: `2026-10-2${i}T10:00:00-07:00`, from: "me", to: ["priya"], text: "Answer" },
      ],
    }));
    expect(seedThreads(dir, threads, { now: FIXTURE_NOW, pageSize: 2 })).toEqual({ delivered: 6 });
    const { threads: listed, messages, pages } = listAll({ labelIds: ["INBOX"] }, dir);
    expect(pages).toBe(2);
    expect(listed).toHaveLength(3);
    expect(messages).toHaveLength(6);
  });
});
