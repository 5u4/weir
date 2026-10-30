import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import type { Row } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type CSSProperties, useCallback } from "react";
import { Avatar } from "./Avatar.tsx";
import { dayAndTime, now, plural, shortTime } from "./Health.ts";
import { Link } from "./Link.tsx";
import {
  emptyBigClass,
  emptyClass,
  emptySubClass,
  headActionClass,
  headClass,
  headMetaClass,
  headNameClass,
  rowAvatarClass,
  rowAvClass,
  rowClass,
  rowLineClass,
  rowLinkClass,
  rowMetaClass,
  rowsClass,
  rowTimeClass,
  rowTitleClass,
} from "./ListClasses.ts";
import { reading } from "./Reading.ts";
import { ResultList } from "./ResultList.tsx";
import { ConversationId, href, listTops, route, type View, viewLabel } from "./Route.ts";
import { face, shown, tagHue } from "./Rows.ts";
import { clearAll, dismiss, intents, searching, tagOrder, viewList } from "./Weir.ts";

type RowProps = {
  row: Row;
  view: View;
  selected: boolean;
  hue: number | undefined;
  onDismiss: () => void;
};

function OpenRow(props: RowProps) {
  const { seen } = useAtomValue(reading(ConversationId.make(props.row.id)));
  return <ListRow {...props} seen={seen} />;
}

function ListRow({ row, view, selected, hue, onDismiss, seen }: RowProps & { seen: number }) {
  const [current] = useAtom(route);
  const at = useAtomValue(now);
  const last = DateTime.makeUnsafe(row.last_at);
  const { from, mark, preview, who, names } = face(row);
  const cleared = view === "cleared";
  const unread = row.state === "unread" && seen < row.last_seq;
  const state = { unread, selected };
  return (
    <li
      data-k={row.id}
      className={rowClass(selected)}
      style={hue === undefined ? undefined : ({ "--bh": hue } as CSSProperties)}
    >
      <Link
        to={{ ...current, conversation: Option.some(ConversationId.make(row.id)) }}
        current={selected}
        className={rowLinkClass}
      >
        <span className={`${rowAvClass(state, hue)} row-end-4`}>
          <Avatar address={from.address} mark={mark} className={rowAvatarClass} />
        </span>
        <span className={rowTitleClass(state)}>{row.title}</span>
        <span className={`${rowLineClass(unread)} row-start-2`}>{preview}</span>
        <span className={`${rowMetaClass} row-start-3`}>
          {who !== "" && <span title={names}>{who}</span>}
          <span className={who === "" ? undefined : "before:mx-em-0.5 before:content-dot"}>
            {plural(row.items, "message")}
            {unread && row.new > 0 && `, ${row.new} new`} · {row.source}
          </span>
        </span>
        {cleared ? (
          <span className={rowTimeClass(false)}>{row.muted ? "Muted" : "Done"}</span>
        ) : (
          <time className={rowTimeClass(unread)} dateTime={row.last_at} title={dayAndTime(last)}>
            {shortTime(last, at)}
          </time>
        )}
      </Link>
      <button
        type="button"
        className={`absolute right-3.5 bottom-3 h-6 rounded-full bg-island px-3 text-xs font-semibold text-ink shadow-ring-line transition-fade-tint-ring hover:bg-ink hover:text-island hover:shadow-none active:scale-press ${cleared ? "" : "opacity-none group-focus-within:opacity-full group-hover:opacity-full"}`}
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
    <div className={emptyClass}>
      <p className={emptyBigClass}>Nothing cleared yet.</p>
      <p className={emptySubClass}>
        Done and muted conversations land here. Restore any of them at any time.
      </p>
    </div>
  ) : (
    <div className={emptyClass}>
      <p className={emptyBigClass}>{viewLabel(view)} is clear.</p>
      <p className={emptySubClass}>New messages bring a conversation back here as unread.</p>
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

function ViewList() {
  const [current, navigate] = useAtom(route);
  const { view } = current;
  const result = useAtomValue(viewList(view));
  const pending = useAtomValue(intents);
  const tags = useAtomValue(tagOrder);
  const runDismiss = useAtomSet(dismiss);
  const runClear = useAtomSet(clearAll);
  const loaded = AsyncResult.getOrElse(AsyncResult.map(result, Option.some), () => Option.none());
  const rows = Option.map(loaded, (list) => shown(view, list.conversations, pending));
  const open = Option.getOrNull(current.conversation);
  const [tops, setTops] = useAtom(listTops);
  const at = href(current);
  const top = tops.get(at);
  const restore = useCallback(
    (rows: HTMLElement | null) => {
      const list = rows?.closest(".list");
      if (list == null || top === undefined) return;
      list.scrollTop = top;
      setTops((saved) => {
        const next = new Map(saved);
        next.delete(at);
        return next;
      });
    },
    [at, top, setTops],
  );
  return (
    <>
      <header className={headClass}>
        <h1 className={headNameClass}>{viewLabel(view)}</h1>
        {Option.isSome(rows) && <span className={headMetaClass}>{headMeta(view, rows.value)}</span>}
        {view !== "cleared" &&
          Option.isSome(loaded) &&
          Option.isSome(rows) &&
          rows.value.length > 0 && (
            <button
              type="button"
              className={headActionClass}
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
        <div className={emptyClass}>
          <p className={emptyBigClass}>Can't load {viewLabel(view)}.</p>
        </div>
      ) : (
        Option.match(rows, {
          onNone: () => null,
          onSome: (list) =>
            list.length === 0 ? (
              <Empty view={view} />
            ) : (
              <ul className={rowsClass} ref={restore}>
                {list.map((row) => {
                  const props: RowProps = {
                    row,
                    view,
                    selected: open === row.id,
                    hue: tagHue(tags, view, row),
                    onDismiss: () =>
                      runDismiss({ act: view === "cleared" ? "Restore" : "Done", target: row }),
                  };
                  return props.selected ? (
                    <OpenRow key={row.id} {...props} />
                  ) : (
                    <ListRow key={row.id} {...props} seen={0} />
                  );
                })}
              </ul>
            ),
        })
      )}
    </>
  );
}

export function List() {
  return useAtomValue(searching) ? <ResultList /> : <ViewList />;
}
