import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import scenarios from "../scenarios.json" with { type: "json" };
import { gmail } from "./fake-gws.ts";
import { privacyReport } from "./privacy.ts";

const fakeGwsOutputs = () => {
  const outputs: [string, unknown][] = [];
  const call = (command: string, params: Record<string, unknown>) => {
    const output = gmail(command, params);
    outputs.push([`fake-gws gmail users ${command} ${JSON.stringify(params)}`, output]);
    return output;
  };
  call("getProfile", { userId: "me" });
  call("settings sendAs list", { userId: "me" });
  call("labels list", { userId: "me" });
  let pageToken: string | undefined;
  do {
    const page = call("threads list", { userId: "me", ...(pageToken ? { pageToken } : {}) });
    for (const { id } of page.threads ?? []) call("threads get", { userId: "me", id });
    pageToken = page.nextPageToken;
  } while (pageToken);
  do {
    const page = call("history list", {
      userId: "me",
      startHistoryId: "100000",
      ...(pageToken ? { pageToken } : {}),
    });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return outputs;
};

describe("privacy", () => {
  it("keeps every address, host and IP in the fixtures and fake-gws output reserved", () => {
    const report = [
      ...privacyReport("scenarios.json", scenarios),
      ...privacyReport(
        "config.toml",
        Bun.TOML.parse(readFileSync(join(import.meta.dirname, "../config.toml"), "utf8")),
      ),
      ...fakeGwsOutputs().flatMap(([source, output]) => privacyReport(source, output)),
    ];
    expect(report.join("\n")).toBe("");
  });

  it.each([
    ["someone@gmail.com", "Forwarding to someone@gmail.com for a second look."],
    ["bit.ly", "Notes are at bit.ly/review-notes before the 10:30:00 sync."],
    ["github.blog", "Writeup is on github.blog; staging stays on 2001:db8::1."],
    ["2001:4860:4860::8888", "Connect to 2001:4860:4860::8888 at 09:00."],
    ["smtp.com", "Notes are at smtp.com/review-notes before the sync."],
  ])("names %s injected into the scenarios", (offender, line) => {
    const copy = structuredClone(scenarios);
    const message = copy.threads[3]?.messages[0];
    if (!message) throw new Error("scenarios lost threads[3].messages[0]");
    message.text += `\n${line}`;
    expect(privacyReport("scenarios.json", copy)).toEqual([
      `${offender} @ scenarios.json threads[3].messages[0].text`,
    ]);
  });

  it("exempts authentication properties only at property positions of authentication headers", () => {
    const headers = [
      { name: "Authentication-Results", value: "mx.example; spf=pass smtp.mailfrom=a@example.com" },
      { name: "Authentication-Results", value: "mx.example; spf=pass (relayed by smtp.com)" },
      { name: "X-Note", value: "smtp.mailfrom=a@example.com" },
    ];
    expect(privacyReport("headers", headers)).toEqual([
      "smtp.com @ headers [1].value",
      "smtp.mailfrom @ headers [2].value",
    ]);
  });
});
