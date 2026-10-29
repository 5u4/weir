import type { Event } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { refetches } from "./Live.ts";

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
    expect(refetches({ type: "ready" }, Option.some(9))).toEqual({
      status: true,
      counts: true,
      list: true,
      conversation: true,
    });
    expect(refetches({ type: "ready" }, Option.none())).toMatchObject({
      list: true,
      conversation: false,
    });
  });

  it("state refetches counts and the list, since a restored row may be absent from it", () => {
    expect(refetches({ type: "state", ids: [7] }, Option.none())).toEqual({
      ...nothing,
      counts: true,
      list: true,
    });
  });

  it("state refetches the open conversation only when it is named", () => {
    expect(refetches({ type: "state", ids: [7] }, Option.some(7))).toMatchObject({
      conversation: true,
    });
    expect(refetches({ type: "state", ids: [7] }, Option.some(3))).toMatchObject({
      conversation: false,
    });
  });

  it("a finished digest refetches the list, status and its open conversation", () => {
    expect(refetches(digest(5, "done"), Option.some(5))).toEqual({
      status: true,
      counts: false,
      list: true,
      conversation: true,
    });
    expect(refetches(digest(5, "done"), Option.some(6))).toMatchObject({
      conversation: false,
    });
  });

  it.each(["queued", "running", "failed"] as const)(
    "a %s digest leaves the list alone",
    (status) => {
      expect(refetches(digest(5, status), Option.some(5))).toEqual({
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
    expect(refetches(sync, Option.some(3))).toEqual({
      status: true,
      counts: true,
      list: true,
      conversation: false,
    });
  });

  it("a successful reload refetches everything, since tags may have changed", () => {
    const ok = { type: "reload", status: "ok", at: "2026-10-28T09:00:00.000Z" } satisfies Event;
    expect(refetches(ok, Option.some(3))).toEqual({
      status: true,
      counts: true,
      list: true,
      conversation: true,
    });
  });

  it("a failed reload refetches only status, to show the config problem", () => {
    const failed = {
      type: "reload",
      status: "failed",
      error: { file: "config.toml", message: "bad", issues: [] },
      at: "2026-10-28T09:00:00.000Z",
    } satisfies Event;
    expect(refetches(failed, Option.some(3))).toEqual({ ...nothing, status: true });
  });
});
