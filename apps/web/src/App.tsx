import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react/Hooks";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Cap } from "./Cap.tsx";
import { health } from "./Health.ts";
import { List } from "./List.tsx";
import { Reader } from "./Reader.tsx";
import { route, statusOpen } from "./Route.ts";
import { CloseIcon, EmptyReader, StatusView } from "./Status.tsx";
import { theme } from "./Theme.ts";
import { live, searchOpen, status, tabTitle } from "./Weir.ts";

export function App() {
  useAtomMount(theme);
  useAtomMount(tabTitle);
  useAtomMount(live);
  const [current, navigate] = useAtom(route);
  const reading = Option.isSome(current.conversation);
  const searching = useAtomValue(searchOpen);
  const [open, setOpen] = useAtom(statusOpen);
  const result = useAtomValue(status);
  const loaded = AsyncResult.getOrElse(
    AsyncResult.map(result, (value) => Option.some({ value, health: health(value) })),
    Option.none,
  );
  const alert = Option.exists(loaded, ({ health }) => health.alert);
  const compact = open || searching || current.query !== "" || reading;
  return (
    <>
      <div id="app" className={open || reading ? "reading" : undefined}>
        <main className="list">
          <List />
        </main>
        <section className={`reader${open ? " sv-open" : ""}`} aria-label="Reader">
          {!open && Option.isSome(current.conversation) ? (
            <Reader id={current.conversation.value} />
          ) : (
            <div className="r-scroll">
              {AsyncResult.isFailure(result) && Option.isNone(loaded) ? (
                <div className="calm es warn">
                  <p className="es-alert">Can't reach the weir daemon.</p>
                </div>
              ) : (
                Option.match(loaded, {
                  onNone: () => null,
                  onSome: ({ value, health }) =>
                    open ? (
                      <StatusView status={value} health={health} />
                    ) : (
                      <EmptyReader health={health} />
                    ),
                })
              )}
            </div>
          )}
          {open ? (
            <button
              type="button"
              className="r-x"
              title="Close (Esc)"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <CloseIcon />
            </button>
          ) : (
            reading && (
              <button
                type="button"
                className="r-x"
                title="Close"
                aria-label="Close"
                onClick={() =>
                  navigate({ _tag: "Go", to: { ...current, conversation: Option.none() } })
                }
              >
                <CloseIcon />
              </button>
            )
          )}
        </section>
      </div>
      <Cap compact={compact} alert={alert} />
    </>
  );
}
