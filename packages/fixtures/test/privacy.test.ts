import { describe, expect, it } from "vitest";
import scenarios from "../scenarios.json" with { type: "json" };
import { gmail, listAllIds } from "./fake-gws.ts";
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
  const { messages } = listAllIds("");
  outputs.push(["fake-gws gmail users messages list (all pages)", messages]);
  for (const m of messages) call("messages get", { userId: "me", id: m.id });
  let pageToken: string | undefined;
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
      ...fakeGwsOutputs().flatMap(([source, output]) => privacyReport(source, output)),
    ];
    expect(report.join("\n")).toBe("");
  });

  it("names a real address injected into the scenarios", () => {
    const copy = structuredClone(scenarios);
    const message = copy.threads[3]?.messages[0];
    if (!message) throw new Error("scenarios lost threads[3].messages[0]");
    message.text += "\nForwarding to someone@gmail.com for a second look.";
    expect(privacyReport("scenarios.json", copy)).toEqual([
      "someone@gmail.com @ scenarios.json threads[3].messages[0].text",
    ]);
  });
});
