import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawItem, Source, StreamDescriptor, SyncPage } from "@weir/contract/Source";
import * as Database from "@weir/store/Database";

export const storeLayer = () =>
  Database.layer(join(mkdtempSync(join(tmpdir(), "weir-sync-")), "weir.db"));

export const mailStream: StreamDescriptor = {
  id: "me@example.com",
  kind: "message",
  name: "Work mail",
  me: ["me@example.com"],
  openLabel: "Open in Gmail",
};

export const rawItem = (externalId: string, overrides: Partial<RawItem> = {}): RawItem => ({
  externalId,
  threadId: `thread-${externalId}`,
  containerId: "INBOX",
  containerName: "Inbox",
  occurredAt: "2026-10-28T09:00:00Z",
  title: null,
  from: { name: "Ada", address: "ada@example.com" },
  body: "",
  bodyNew: "",
  link: null,
  raw: {},
  ...overrides,
});

export const page = (overrides: Partial<SyncPage> & Pick<SyncPage, "cursor">): SyncPage => ({
  upserts: [],
  deletions: [],
  more: false,
  ...overrides,
});

export type Step = SyncPage | Error;

export const scriptedSource = (script: Map<string | null, Step>) => {
  const calls: Array<string | null> = [];
  const source: Source = {
    streams: async () => [mailStream],
    sync: async (_streamId, cursor) => {
      calls.push(cursor);
      const step = script.get(cursor);
      if (step === undefined) throw new Error(`no page scripted for cursor ${cursor}`);
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { source, calls };
};
