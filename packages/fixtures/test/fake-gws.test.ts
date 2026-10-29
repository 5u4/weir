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
  setNow,
} from "@weir/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import scenarios from "../scenarios.json" with { type: "json" };
import { fakeGws, gmail, listAllIds } from "./fake-gws.ts";

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
  it("pages every Gmail scenario message within newer_than:30d at FIXTURE_NOW", () => {
    const { messages, pages } = listAllIds("newer_than:30d");
    expect(messages).toHaveLength(scenarioMessages.length);
    expect(messages).toHaveLength(32);
    expect(new Set(messages.map((m) => m.id)).size).toBe(32);
    expect(new Set(messages.map((m) => m.threadId)).size).toBe(scenarios.threads.length);
    expect(new Set(messages.map((m) => m.threadId)).size).toBe(15);
    expect(pages).toBeGreaterThan(1);
  });

  it("serves bodies that start with the scenario text", () => {
    const bodies = listAllIds("").messages.map((m) => {
      const message = gmail("messages get", { userId: "me", id: m.id, format: "full" });
      return plainBody(message.payload);
    });
    for (const m of scenarioMessages) {
      expect(bodies.some((b) => b === m.text || b.startsWith(`${m.text}\n\n`))).toBe(true);
    }
  });

  it("answers an unknown message id with a gws 404", () => {
    const run = fakeGws([
      "gmail",
      "users",
      "messages",
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
    [[], { userId: "me", labelIds: ["INBOX"] }],
    [[], { userId: "me", q: "from:someone" }],
  ])("rejects unsupported input %j %j with a validation exit", (flags, params) => {
    const run = fakeGws([
      "gmail",
      "users",
      "messages",
      "list",
      ...flags,
      "--params",
      JSON.stringify(params),
    ]);
    expect(run.exitCode).toBe(3);
    expect(JSON.parse(run.stdout).error.reason).toBe("validationError");
    expect(run.stderr).toMatch(/^error\[validation\]: /);
  });

  it("rejects formats other than full", () => {
    const run = fakeGws([
      "gmail",
      "users",
      "messages",
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
    const boundary = "2026-10-21T10:04:00-07:00";
    setNow(dir, "2026-11-20T10:04:00-07:00");
    const expected = scenarioMessages.filter((m) => at(m.at) > at(boundary)).length;
    expect(expected).toBeLessThan(32);
    expect(listAllIds("newer_than:30d", dir).messages).toHaveLength(expected);
    expect(listAllIds("", dir).messages).toHaveLength(32);
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
    const [trashed] = listAllIds("", dir).messages.filter((m) => m.id !== added);
    if (!trashed) throw new Error("no message to relabel");
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

    const visible = listAllIds("", dir).messages.map((m) => m.id);
    expect(visible).not.toContain(trashed.id);
    expect(visible).not.toContain(added);
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
});
