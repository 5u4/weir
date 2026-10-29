import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import type { Row } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { CSSProperties } from "react";
import { Avatar } from "./Avatar.tsx";
import { dayAndTime, now, plural, shortTime } from "./Health.ts";
import { Link } from "./Link.tsx";
import { ConversationId, route, type View } from "./Route.ts";
import { face, neighbor, shown, tagHue } from "./Rows.ts";
import { clearAll, counts, dismiss, intents, viewList } from "./Weir.ts";

const viewLabel = (view: View) =>
  view === "untagged" ? "Untagged" : view === "cleared" ? "Cleared" : view.slice("tag:".length);

function ListRow({
  row,
  view,
  selected,
  hue,
  onDismiss,
}: {
  row: Row;
  view: View;
  selected: boolean;
  hue: number | undefined;
  onDismiss: () => void;
}) {
  const [current] = useAtom(route);
  const at = useAtomValue(now);
  const last = DateTime.makeUnsafe(row.last_at);
  const { from, preview, who, names } = face(row);
  const cleared = view === "cleared";
  return (
    <li
      className={`row${row.state === "unread" ? " unread" : ""}${selected ? " sel" : ""}`}
      style={hue === undefined ? undefined : ({ "--bh": hue } as CSSProperties)}
    >
      <Link
        to={{ ...current, conversation: Option.some(ConversationId.make(row.id)) }}
        current={selected}
        className="row-link"
      >
        <span className="row-av">
          <Avatar sender={from} />
        </span>
        <span className="row-title">{row.title}</span>
        <span className="row-line">{preview}</span>
        <span className="row-meta">
          {who !== "" && (
            <span className="row-who" title={names}>
              {who}
            </span>
          )}
          <span className="row-n">
            {plural(row.items, "message")}
            {row.new > 0 && `, ${row.new} new`} · {row.source}
          </span>
        </span>
        {cleared ? (
          <span className="row-badge">{row.muted ? "Muted" : "Done"}</span>
        ) : (
          <time className="row-time" dateTime={row.last_at} title={dayAndTime(last)}>
            {shortTime(last, at)}
          </time>
        )}
      </Link>
      <button
        type="button"
        className={`row-act${cleared ? " restore" : ""}`}
        title={cleared ? undefined : "Done. It leaves the list until something new arrives."}
        onClick={onDismiss}
      >
        {cleared ? "Restore" : "Done"}
      </button>
    </li>
  );
}

function Empty({ view }: { view: View }) {
  return view === "cleared" ? (
    <div className="empty">
      <p className="empty-big">Nothing cleared yet.</p>
      <p className="empty-sub">
        Done and muted conversations land here. Restore any of them at any time.
      </p>
    </div>
  ) : (
    <div className="empty">
      <p className="empty-big">{viewLabel(view)} is clear.</p>
      <p className="empty-sub">New messages bring a conversation back here as unread.</p>
    </div>
  );
}

const headMeta = (view: View, rows: ReadonlyArray<Row>) => {
  if (view === "cleared") {
    const muted = rows.filter((row) => row.muted).length;
    return `${rows.length} · ${rows.length - muted} done · ${muted} muted`;
  }
  const unread = rows.filter((row) => row.state === "unread").length;
  const state = unread > 0 ? ` · ${unread} unread` : rows.length > 0 ? " · all read" : "";
  return `${plural(rows.length, "conversation")}${state}`;
};

export function List() {
  const [current, navigate] = useAtom(route);
  const { view } = current;
  const result = useAtomValue(viewList(view));
  const pending = useAtomValue(intents);
  const tags = AsyncResult.getOrElse(
    AsyncResult.map(useAtomValue(counts), (value) => value.tags.map(({ name }) => name)),
    () => [],
  );
  const runDismiss = useAtomSet(dismiss);
  const runClear = useAtomSet(clearAll);
  const loaded = AsyncResult.getOrElse(AsyncResult.map(result, Option.some), () => Option.none());
  const rows = Option.map(loaded, (list) => shown(view, list.conversations, pending));
  const open = Option.getOrNull(current.conversation);
  return (
    <>
      <header className="l-head">
        <h1 className="l-name">{viewLabel(view)}</h1>
        {Option.isSome(rows) && <span className="l-meta">{headMeta(view, rows.value)}</span>}
        {view !== "cleared" &&
          Option.isSome(loaded) &&
          Option.isSome(rows) &&
          rows.value.length > 0 && (
            <button
              type="button"
              className="clearall"
              onClick={() => {
                const ids = rows.value.map((row) => row.id);
                if (open !== null && ids.includes(open)) {
                  navigate({ _tag: "Replace", to: { ...current, conversation: Option.none() } });
                }
                runClear({ view, seq: loaded.value.seq, ids });
              }}
            >
              Clear all
            </button>
          )}
      </header>
      {AsyncResult.isFailure(result) && Option.isNone(loaded) ? (
        <div className="empty">
          <p className="empty-big">Can't load {viewLabel(view)}.</p>
        </div>
      ) : (
        Option.match(rows, {
          onNone: () => null,
          onSome: (list) =>
            list.length === 0 ? (
              <Empty view={view} />
            ) : (
              <ul className={`rows${view === "cleared" ? " cleared" : ""}`}>
                {list.map((row) => (
                  <ListRow
                    key={row.id}
                    row={row}
                    view={view}
                    selected={open === row.id}
                    hue={tagHue(tags, view, row)}
                    onDismiss={() => {
                      if (open === row.id) {
                        navigate({
                          _tag: "Replace",
                          to: {
                            ...current,
                            conversation: Option.map(neighbor(list, row.id), (next) =>
                              ConversationId.make(next.id),
                            ),
                          },
                        });
                      }
                      runDismiss({ view, row });
                    }}
                  />
                ))}
              </ul>
            ),
        })
      )}
    </>
  );
}
