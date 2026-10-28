import { describe, expect, it } from "vitest";
import scenarios from "../scenarios.json" with { type: "json" };
import { privacyReport } from "./privacy.ts";

describe("privacy", () => {
  it("keeps every address, host and IP in the fixtures reserved", () => {
    expect(privacyReport("scenarios.json", scenarios).join("\n")).toBe("");
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
