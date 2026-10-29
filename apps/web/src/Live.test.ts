import type { Event } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { refetches } from "./Live.ts";

const listed = [3, 4];
const nothing = { status: false, counts: false, list: false, conversation: false };
const digest = (conversation_id: number, status: "queued" | "running" | "done" | "failed") =>
  ({
    type: "digest",
    conversation_id,
    from_seq: 1,
    to_seq: 4,
    trigger: "auto",
    status,
  }) satisfies Event;

describe("refetches per event", () => {
  it("ready refetches everything, the open conversation when one is open", () => {
    expect(refetches({ type: "ready" }, listed, Option.some(9))).toEqual({
      status: true,
      counts: true,
      list: true,
      conversation: true,
    });
    expect(refetches({ type: "ready" }, [], Option.none())).toMatchObject({
      list: true,
      conversation: false,
    });
  });

  it("state always refetches counts, the list only when it shows a named row", () => {
    expect(refetches({ type: "state", ids: [7] }, listed, Option.none())).toEqual({
      ...nothing,
      counts: true,
    });
    expect(refetches({ type: "state", ids: [7, 4] }, listed, Option.none())).toEqual({
      ...nothing,
      counts: true,
      list: true,
    });
  });

  it("state refetches the open conversation only when it is named", () => {
    expect(refetches({ type: "state", ids: [7] }, listed, Option.some(7))).toMatchObject({
      conversation: true,
    });
    expect(refetches({ type: "state", ids: [7] }, listed, Option.some(3))).toMatchObject({
      conversation: false,
    });
  });

  it("a finished digest refetches the list, status and its open conversation", () => {
    expect(refetches(digest(5, "done"), listed, Option.some(5))).toEqual({
      status: true,
      counts: false,
      list: true,
      conversation: true,
    });
    expect(refetches(digest(5, "done"), listed, Option.some(6))).toMatchObject({
      conversation: false,
    });
  });

  it.each(["queued", "running", "failed"] as const)(
    "a %s digest leaves the list alone",
    (status) => {
      expect(refetches(digest(5, status), listed, Option.some(5))).toEqual({
        status: true,
        counts: false,
        list: false,
        conversation: true,
      });
    },
  );

  it("sync refetches status, counts and the list", () => {
    const sync = {
      type: "sync",
      source: "gmail",
      status: "done",
      at: "2026-10-28T09:00:00.000Z",
    } satisfies Event;
    expect(refetches(sync, listed, Option.some(3))).toEqual({
      status: true,
      counts: true,
      list: true,
      conversation: false,
    });
  });
});
