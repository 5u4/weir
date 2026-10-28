import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamDescriptor } from "@weir/contract/Source";
import * as Database from "../src/Database.ts";
import type { StoredItem } from "../src/Write.ts";

export const tempDbFile = () => join(mkdtempSync(join(tmpdir(), "weir-store-")), "weir.db");

export const storeLayer = () => Database.layer(tempDbFile());

export const mailStream: StreamDescriptor = {
  id: "me@example.com",
  kind: "message",
  name: "Work mail",
  me: ["Me@Example.com"],
  openLabel: "Open in Gmail",
};

export const rawItem = (externalId: string, overrides: Partial<StoredItem> = {}): StoredItem => ({
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
