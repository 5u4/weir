import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { type Motion, motionOf, type Scene } from "./Morph.ts";
import { ConversationId } from "./Route.ts";

const scene = (settings: boolean, conversation?: number, notch = "full"): Scene => ({
  settings,
  conversation:
    conversation === undefined ? Option.none() : Option.some(ConversationId.make(conversation)),
  notch,
});

describe("motionOf", () => {
  it.each<[string, Scene, Scene, Motion]>([
    ["nothing changes on the list", scene(false), scene(false), { _tag: "None" }],
    ["opening a conversation", scene(false), scene(false, 1), { _tag: "Mode", open: true }],
    ["closing a conversation", scene(false, 1), scene(false), { _tag: "Mode", open: false }],
    ["opening Settings from the list", scene(false), scene(true), { _tag: "Mode", open: true }],
    ["closing Settings to the list", scene(true), scene(false), { _tag: "Mode", open: false }],
    ["switching conversations", scene(false, 1), scene(false, 2), { _tag: "Switch" }],
    ["reselecting the same conversation", scene(false, 1), scene(false, 1), { _tag: "None" }],
    [
      "opening Settings over a conversation",
      scene(false, 1),
      scene(true, 1),
      { _tag: "SettingsRise" },
    ],
    [
      "closing Settings back to a conversation",
      scene(true, 1),
      scene(false, 1),
      { _tag: "SettingsRise" },
    ],
    [
      "picking a conversation from Settings",
      scene(true),
      scene(false, 2),
      { _tag: "SettingsRise" },
    ],
    ["route changing under open Settings", scene(true, 1), scene(true, 2), { _tag: "None" }],
    [
      "the notch changing on the list",
      scene(false),
      scene(false, undefined, "b"),
      { _tag: "Tick" },
    ],
    ["the notch changing while reading", scene(false, 1), scene(false, 1, "b"), { _tag: "Tick" }],
    [
      "the notch changing as a conversation opens",
      scene(false),
      scene(false, 1, "b"),
      { _tag: "Mode", open: true },
    ],
    [
      "the notch changing as Settings rises",
      scene(false, 1),
      scene(true, 1, "b"),
      { _tag: "SettingsRise" },
    ],
    [
      "the notch changing as conversations switch",
      scene(false, 1),
      scene(false, 2, "b"),
      { _tag: "Switch" },
    ],
  ])("%s", (_, before, after, motion) => {
    expect(motionOf(before, after)).toEqual(motion);
  });
});
