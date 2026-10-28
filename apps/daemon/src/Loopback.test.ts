import { describe, expect, it } from "vitest";
import { isLoopbackRequest } from "./Loopback.ts";

describe("isLoopbackRequest", () => {
  it.each([
    ["127.0.0.1:9347", undefined, 9347],
    ["localhost:9347", "http://localhost:9347", 9347],
    ["LOCALHOST:9347", "http://127.0.0.1:9347", 9347],
    ["127.0.0.1", undefined, 80],
    ["127.0.0.1:80", undefined, 80],
    ["localhost", "http://localhost", 80],
    ["127.0.0.1", "http://127.0.0.1:80", 80],
  ])("accepts Host %s with Origin %s on port %i", (host, origin, port) => {
    expect(isLoopbackRequest(host, origin, port)).toBe(true);
  });

  it.each([
    [undefined, undefined, 9347],
    ["127.0.0.1", undefined, 9347],
    ["127.0.0.1:9348", undefined, 9347],
    ["evil.example:9347", undefined, 9347],
    ["127.0.0.1:080", undefined, 80],
    ["127.0.0.1:09347", undefined, 9347],
    ["evil@127.0.0.1", undefined, 80],
    ["evil@127.0.0.1:9347", undefined, 9347],
    ["127.0.0.1:9347/", undefined, 9347],
    ["127.0.0.1.evil.example:9347", undefined, 9347],
    ["2130706433:9347", undefined, 9347],
    ["127.0.0.1:9347", "null", 9347],
    ["127.0.0.1:9347", "https://127.0.0.1:9347", 9347],
    ["127.0.0.1:9347", "http://evil.example:9347", 9347],
    ["127.0.0.1:9347", "http://127.0.0.1:9347/", 9347],
    ["127.0.0.1:9347", "http://127.0.0.1", 9347],
    ["127.0.0.1", "http://127.0.0.1:080", 80],
  ])("rejects Host %s with Origin %s on port %i", (host, origin, port) => {
    expect(isLoopbackRequest(host, origin, port)).toBe(false);
  });
});
