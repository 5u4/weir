import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import { shortcut } from "./Dock.ts";
import { dock } from "./Reading.ts";
import { ConversationId, route, searchOpen, settingsOpen } from "./Route.ts";
import { moved } from "./Rows.ts";
import { dismiss, listedRows, picker, searching } from "./Weir.ts";

export const keys = Atom.make((get) => {
  const onKey = (event: KeyboardEvent) => {
    const { target } = event;
    const command = shortcut({
      key: event.key,
      modified: event.ctrlKey || event.metaKey || event.altKey,
      editing:
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select") !== null),
      settings: Option.isSome(get.registry.get(settingsOpen)),
    });
    if (command === null) return;
    const current = get.registry.get(route);
    const open = current.conversation;
    switch (command) {
      case "Search":
        event.preventDefault();
        get.registry.set(settingsOpen, Option.none());
        get.registry.set(searchOpen, true);
        document.querySelector<HTMLInputElement>(".cap .cap-in")?.focus();
        return;
      case "CloseSettings":
        get.registry.set(settingsOpen, Option.none());
        return;
      case "Settings":
        get.registry.set(
          settingsOpen,
          Option.isSome(get.registry.get(settingsOpen))
            ? Option.none()
            : Option.some({ section: "appearance" }),
        );
        return;
      case "Close":
        if (current.query !== "") get.registry.set(route, { _tag: "Leave" });
        else if (Option.isSome(open)) {
          get.registry.set(route, {
            _tag: "Go",
            to: { ...current, conversation: Option.none() },
            origin: "passive",
          });
        }
        return;
      case "Done": {
        const shown = Option.flatMap(open, (id) => get.registry.get(dock(id)));
        if (Option.isSome(shown) && shown.value.actions.includes("Done")) {
          get.registry.set(dismiss, { act: "Done", target: shown.value.target });
        }
        return;
      }
      case "Plan": {
        if (Option.isNone(open)) return;
        const shown = get.registry.get(dock(open.value));
        if (Option.isSome(shown) && shown.value.actions.includes("Plan")) {
          event.preventDefault();
          get.registry.set(picker, Option.some({ id: open.value, tab: "plan" }));
        }
        return;
      }
      case "Next":
      case "Previous": {
        const next = moved(get.registry.get(listedRows), open, command === "Next" ? 1 : -1);
        if (Option.isSome(next)) {
          get.registry.set(route, {
            _tag: "Replace",
            to: { ...current, conversation: Option.some(ConversationId.make(next.value.id)) },
            origin: get.registry.get(searching) ? "passive" : "active",
          });
        }
      }
    }
  };
  addEventListener("keydown", onKey);
  get.addFinalizer(() => removeEventListener("keydown", onKey));
});
