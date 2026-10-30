import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { type Motion, motionOf, type Scene } from "./Morph.ts";
import { ConversationId } from "./Route.ts";

const scene = (status: boolean, conversation?: number): Scene => ({
  status,
  conversation:
    conversation === undefined ? Option.none() : Option.some(ConversationId.make(conversation)),
});

describe("motionOf", () => {
  it.each<[string, Scene, Scene, Motion]>([
    ["nothing changes on the list", scene(false), scene(false), { _tag: "None" }],
    ["opening a conversation", scene(false), scene(false, 1), { _tag: "Mode", open: true }],
    ["closing a conversation", scene(false, 1), scene(false), { _tag: "Mode", open: false }],
    ["opening Status from the list", scene(false), scene(true), { _tag: "Mode", open: true }],
    ["closing Status to the list", scene(true), scene(false), { _tag: "Mode", open: false }],
    ["switching conversations", scene(false, 1), scene(false, 2), { _tag: "Switch" }],
    ["reselecting the same conversation", scene(false, 1), scene(false, 1), { _tag: "None" }],
    ["opening Status over a conversation", scene(false, 1), scene(true, 1), { _tag: "StatusRise" }],
    [
      "closing Status back to a conversation",
      scene(true, 1),
      scene(false, 1),
      { _tag: "StatusRise" },
    ],
    ["picking a conversation from Status", scene(true), scene(false, 2), { _tag: "StatusRise" }],
    ["route changing under open Status", scene(true, 1), scene(true, 2), { _tag: "None" }],
  ])("%s", (_, before, after, motion) => {
    expect(motionOf(before, after)).toEqual(motion);
  });
});
