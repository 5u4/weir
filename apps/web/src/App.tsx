import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react/Hooks";
import type { Status } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { MouseEvent, ReactNode } from "react";
import { health, plural } from "./Health.ts";
import { href, type Route, route, type View } from "./Route.ts";
import { CloseIcon, EmptyReader, StatusIcon, StatusView } from "./Status.tsx";
import { theme } from "./Theme.ts";
import { status, statusOpen } from "./Weir.ts";

const plainLeftClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function Link({ to, current, children }: { to: Route; current: boolean; children: ReactNode }) {
  const [, navigate] = useAtom(route);
  return (
    <a
      className={`cw${current ? " on" : ""}`}
      href={href(to)}
      aria-current={current ? "page" : undefined}
      onClick={(event) => {
        if (event.defaultPrevented || !plainLeftClick(event)) return;
        event.preventDefault();
        navigate({ _tag: "Go", to });
      }}
    >
      {children}
    </a>
  );
}

const viewLabel = (view: View) =>
  view === "untagged" ? "Untagged" : view === "cleared" ? "Cleared" : view.slice("tag:".length);

const viewCounts = (value: Status, view: View) =>
  view === "untagged"
    ? Option.some(value.untagged)
    : Option.fromNullishOr(value.tags.find(({ name }) => `tag:${name}` === view));

export function App() {
  useAtomMount(theme);
  const [current, navigate] = useAtom(route);
  const [open, setOpen] = useAtom(statusOpen);
  const result = useAtomValue(status);
  const loaded = AsyncResult.getOrElse(
    AsyncResult.map(result, (value) => Option.some({ value, health: health(value) })),
    Option.none,
  );
  const tagViews = Option.match(loaded, {
    onNone: () => [],
    onSome: ({ value }) => value.tags.map(({ name }): View => `tag:${name}`),
  });
  const counts = Option.flatMap(loaded, ({ value }) => viewCounts(value, current.view));
  const alert = Option.exists(loaded, ({ health }) => health.alert);
  return (
    <>
      <div id="app" className={open ? "reading" : undefined}>
        <div className="list">
          <header className="l-head">
            <h1 className="l-name">{viewLabel(current.view)}</h1>
            {Option.isSome(counts) && (
              <span className="l-meta">
                {plural(counts.value.conversations, "conversation")}
                {counts.value.unread > 0 && ` · ${counts.value.unread} unread`}
              </span>
            )}
          </header>
        </div>
        <section className={`reader${open ? " sv-open" : ""}`} aria-label="Reader">
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
          {open && (
            <button
              type="button"
              className="r-x"
              title="Close (Esc)"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <CloseIcon />
            </button>
          )}
        </section>
      </div>
      <div className="cap compact" role="region" aria-label="weir">
        <div className="cap-nav">
          <input
            className="cap-in"
            type="search"
            aria-label="Search"
            placeholder="Search"
            value={current.query}
            onChange={({ target: { value } }) => navigate({ _tag: "Type", query: value })}
          />
          <span className="cap-div" />
          <nav className="cws" aria-label="Views">
            {(["untagged", "cleared", ...tagViews] as const).map((view) => (
              <Link
                key={view}
                to={{ view, query: "", conversation: Option.none() }}
                current={current.query === "" && current.view === view}
              >
                <span className="cw-name">{viewLabel(view)}</span>
              </Link>
            ))}
          </nav>
          <span className="cap-div" />
          <button
            type="button"
            className={`cw cw-st${alert ? " alert" : ""}${open ? " on" : ""}`}
            aria-label="Status"
            title="Status"
            aria-pressed={open}
            aria-description={alert ? "Needs attention" : undefined}
            onClick={() => setOpen(!open)}
          >
            <StatusIcon />
            <i className="st-dot" aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );
}
