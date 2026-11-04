import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import { shortcut } from "./Dock.ts";
import { stepped } from "./PlanLayout.ts";
import { dock } from "./Reading.ts";
import { ConversationId, route, searchOpen, settingsOpen } from "./Route.ts";
import { moved } from "./Rows.ts";
import { dismiss, listedRows, picker, searching, toast, today } from "./Weir.ts";

export const keys = Atom.make((get) => {
  const onKey = (event: KeyboardEvent) => {
    const { target } = event;
    const current = get.registry.get(route);
    const command = shortcut({
      key: event.key,
      modified: event.ctrlKey || event.metaKey || event.altKey,
      editing:
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select") !== null),
      settings: Option.isSome(get.registry.get(settingsOpen)),
      mode: current.mode,
    });
    if (command === null) return;
    const open = current.conversation;
    const go = (to: typeof current) =>
      get.registry.set(route, { _tag: "Go", to, origin: "passive" });
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
        else if (Option.isSome(open)) go({ ...current, conversation: Option.none() });
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
      case "PlanMode":
        go(
          current.mode === "plan"
            ? { ...current, mode: "messages", conversation: Option.none() }
            : Option.getOrElse(
                Option.flatMap(get.registry.get(toast), ({ show }) => show),
                () => ({
                  ...current,
                  mode: "plan" as const,
                  query: "",
                  conversation: Option.none(),
                }),
              ),
        );
        return;
      case "Day":
      case "Month":
        go({ ...current, scale: command === "Day" ? "day" : "month" });
        return;
      case "Today":
        go({ ...current, date: Option.none() });
        return;
      case "Sooner":
      case "Later": {
        const now = get.registry.get(today);
        if (Option.isNone(now)) return;
        const from = Option.getOrElse(current.date, () => now.value.date);
        const next = stepped(current.scale, from, command === "Later" ? 1 : -1);
        go({ ...current, date: next === now.value.date ? Option.none() : Option.some(next) });
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
