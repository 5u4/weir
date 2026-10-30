import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react/Hooks";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Cap } from "./Cap.tsx";
import { health } from "./Health.ts";
import { keys } from "./Keys.ts";
import { List } from "./List.tsx";
import { formOf } from "./Notch.ts";
import { queryText } from "./Query.ts";
import { Reader } from "./Reader.tsx";
import { route, searchOpen, statusOpen } from "./Route.ts";
import { CloseIcon, EmptyReader, StatusView } from "./Status.tsx";
import { theme } from "./Theme.ts";
import {
  arrivals,
  capCountsFeed,
  found,
  listMotion,
  live,
  searching,
  searchQuery,
  status,
  tabTitle,
} from "./Weir.ts";

export function App() {
  useAtomMount(theme);
  useAtomMount(tabTitle);
  useAtomMount(live);
  useAtomMount(arrivals);
  useAtomMount(keys);
  useAtomMount(listMotion);
  useAtomMount(capCountsFeed);
  const [current, navigate] = useAtom(route);
  const reading = Option.isSome(current.conversation);
  const opened = useAtomValue(searchOpen);
  const looking = useAtomValue(searching);
  const query = useAtomValue(searchQuery);
  const results = useAtomValue(found);
  const [open, setOpen] = useAtom(statusOpen);
  const result = useAtomValue(status);
  const loaded = AsyncResult.getOrElse(
    AsyncResult.map(result, (value) => Option.some({ value, health: health(value) })),
    Option.none,
  );
  const alert = Option.exists(loaded, ({ health }) => health.alert);
  const form = formOf({ status: open, reading, query: current.query, searching: opened });
  const sheet = open || reading;
  return (
    <>
      <div id="app" data-reading={sheet || undefined}>
        <main className="list fixed top-edge bottom-0 left-stage w-list scrollbar-thin overflow-y-auto overscroll-contain max-wide:top-list max-wide:right-0 max-wide:left-0 max-wide:w-auto max-wide:px-1.5">
          <List />
        </main>
        <section
          className={`reader fixed top-edge bottom-edge left-reader w-reader overflow-hidden rounded-reader bg-island elevation-reader max-wide:right-0 max-wide:bottom-0 max-wide:left-0 max-wide:z-dock max-wide:w-auto max-wide:rounded-b-none max-wide:elevation-sheet ${sheet ? "" : "max-wide:hidden"}`}
          aria-label="Reader"
        >
          {Option.isSome(current.conversation) && (
            <Reader id={current.conversation.value} hidden={open} />
          )}
          {(open || !reading) && (
            <div className="r-scroll">
              {AsyncResult.isFailure(result) && Option.isNone(loaded) ? (
                <div className="flex h-full flex-col items-center justify-center px-reader pb-16">
                  <p className="m-0 mb-5 font-display text-lg leading-snug font-semibold text-ink">
                    Can't reach the weir daemon.
                  </p>
                </div>
              ) : !open && looking ? (
                <div className="flex h-full items-center justify-center px-reader pb-16 text-center text-ink-3">
                  <p className="m-0 text-base">
                    {Option.exists(results, (list) => list.length === 0)
                      ? `Nothing matches “${queryText(query)}”.`
                      : "Pick a result to read it."}
                  </p>
                </div>
              ) : (
                Option.match(loaded, {
                  onNone: () => null,
                  onSome: ({ value, health }) =>
                    open ? (
                      <StatusView status={value} health={health} />
                    ) : (
                      <EmptyReader health={health} digest={value.digest} />
                    ),
                })
              )}
            </div>
          )}
          {sheet && (
            <button
              type="button"
              className="r-x absolute top-gap right-gap size-pill place-items-center rounded-circle text-ink-3 transition-tint hover:bg-hover hover:text-ink"
              title="Close (Esc)"
              aria-label="Close"
              onClick={() =>
                open
                  ? setOpen(false)
                  : navigate({ _tag: "Go", to: { ...current, conversation: Option.none() } })
              }
            >
              <CloseIcon />
            </button>
          )}
        </section>
      </div>
      <Cap form={form} alert={alert} />
    </>
  );
}
