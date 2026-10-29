import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import { shortcut } from "./Dock.ts";
import { dock } from "./Reading.ts";
import { ConversationId, route, statusOpen } from "./Route.ts";
import { moved } from "./Rows.ts";
import { searching, searchRows } from "./Search.ts";
import { dismiss, searchOpen, visibleRows } from "./Weir.ts";

export const keys = Atom.make((get) => {
  const onKey = (event: KeyboardEvent) => {
    const { target } = event;
    const command = shortcut({
      key: event.key,
      modified: event.ctrlKey || event.metaKey || event.altKey,
      editing:
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select") !== null),
      status: get.registry.get(statusOpen),
    });
    if (command === null) return;
    const current = get.registry.get(route);
    const open = current.conversation;
    switch (command) {
      case "Search":
        event.preventDefault();
        get.registry.set(statusOpen, false);
        get.registry.set(searchOpen, true);
        document.querySelector<HTMLInputElement>(".cap .cap-in")?.focus();
        return;
      case "CloseStatus":
        get.registry.set(statusOpen, false);
        return;
      case "Close":
        if (Option.isSome(open)) {
          get.registry.set(route, { _tag: "Go", to: { ...current, conversation: Option.none() } });
        }
        return;
      case "Done": {
        const shown = Option.flatMap(open, (id) => get.registry.get(dock(id)));
        if (Option.isSome(shown) && shown.value.actions.includes("Done")) {
          get.registry.set(dismiss, { act: "Done", target: shown.value.target });
        }
        return;
      }
      case "Next":
      case "Previous": {
        const rows = get.registry.get(searching)
          ? get.registry.get(searchRows)
          : get.registry.get(visibleRows(current.view));
        const next = moved(rows, open, command === "Next" ? 1 : -1);
        if (Option.isSome(next)) {
          get.registry.set(route, {
            _tag: "Replace",
            to: { ...current, conversation: Option.some(ConversationId.make(next.value.id)) },
          });
        }
      }
    }
  };
  addEventListener("keydown", onKey);
  get.addFinalizer(() => removeEventListener("keydown", onKey));
});
