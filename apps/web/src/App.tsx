import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { MouseEvent, ReactNode } from "react";
import { href, type Route, route, type View } from "./Route.ts";
import { status } from "./Weir.ts";

const plainLeftClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function Link({ to, current, children }: { to: Route; current: boolean; children: ReactNode }) {
  const [, navigate] = useAtom(route);
  return (
    <a
      href={href(to)}
      aria-current={current ? "page" : undefined}
      onClick={(event) => {
        if (event.defaultPrevented || !plainLeftClick(event)) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

const viewLabel = (view: View) => (view.startsWith("tag:") ? view.slice("tag:".length) : view);

export function App() {
  const [current, navigate] = useAtom(route);
  const result = useAtomValue(status);
  const tagViews = AsyncResult.match(result, {
    onInitial: () => [],
    onFailure: () => [],
    onSuccess: ({ value }) => value.tags.map(({ name }): View => `tag:${name}`),
  });
  return (
    <main>
      <nav aria-label="Views">
        {(["untagged", "cleared", ...tagViews] as const).map((view) => (
          <Link
            key={view}
            to={{ view, query: "", conversation: Option.none() }}
            current={current.query === "" && current.view === view}
          >
            {viewLabel(view)}
          </Link>
        ))}
      </nav>
      <input
        type="search"
        aria-label="Search"
        placeholder="Search"
        value={current.query}
        onChange={({ target: { value } }) =>
          navigate({
            ...current,
            query: value,
            conversation: value === "" ? current.conversation : Option.none(),
          })
        }
      />
      <pre id="status">
        {AsyncResult.match(result, {
          onInitial: () => "loading",
          onFailure: ({ cause }) => `error ${String(cause)}`,
          onSuccess: ({ value }) =>
            `home=${value.home} sync=${value.sync} tags=${value.tags.length}`,
        })}
      </pre>
    </main>
  );
}
