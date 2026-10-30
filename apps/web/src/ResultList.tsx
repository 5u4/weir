import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { CSSProperties } from "react";
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
import { Marked } from "./Marked.tsx";
import { queryText } from "./Query.ts";
import { cleared, fieldLabels, type Result } from "./Results.ts";
import { ConversationId, route, viewLabel } from "./Route.ts";
import { face, tagHue } from "./Rows.ts";
import {
  found,
  pickedGroup,
  searchGroup,
  searchQuery,
  searchResult,
  searchRows,
  tagOrder,
} from "./Weir.ts";

function Hit({ hit }: { hit: Result["hits"][number] }) {
  return (
    <li className="min-w-0">
      <span className="flex items-baseline gap-1.5 text-xs leading-4.5 whitespace-nowrap text-ink-3 tabular-nums">
        {hit.seq !== null && <b className="font-bold text-ink-2">#{hit.seq}</b>}
        <i className="not-italic">{fieldLabels[hit.field]}</i>
      </span>
      <span
        className={`mt-0.5 line-clamp-3 wrap-anywhere ${hit.field === "topic" || hit.field === "headline" ? "text-md leading-relaxed text-ink" : "text-sm leading-normal text-ink-2"}`}
      >
        {hit.title !== null && (
          <b className="font-semibold text-ink">
            <Marked segments={hit.title} />{" "}
          </b>
        )}
        <Marked segments={hit.text} />
      </span>
    </li>
  );
}

function ResultRow({ result, selected }: { result: Result; selected: boolean }) {
  const [current] = useAtom(route);
  const tags = useAtomValue(tagOrder);
  const at = useAtomValue(now);
  const last = DateTime.makeUnsafe(result.last_at);
  const { from, mark } = face(result);
  const hue = tagHue(tags, current.view, result);
  const unread = result.state === "unread";
  const state = { unread, selected };
  const tagged = result.tags.length > 0;
  const settled = cleared(result);
  return (
    <li
      data-k={result.id}
      className={rowClass(selected)}
      style={hue === undefined ? undefined : ({ "--bh": hue } as CSSProperties)}
    >
      <Link
        to={{ ...current, conversation: Option.some(ConversationId.make(result.id)) }}
        current={selected}
        className={rowLinkClass}
      >
        <span className={`${rowAvClass(state, hue)} row-end-5`}>
          <Avatar address={from.address} mark={mark} className={rowAvatarClass} />
        </span>
        <span className={rowTitleClass(state)}>{result.title}</span>
        <time className={rowTimeClass(unread)} dateTime={result.last_at} title={dayAndTime(last)}>
          {shortTime(last, at)}
        </time>
        <span className={`${rowMetaClass} row-start-2`}>
          {tagged && <span className="font-semibold text-ink-2">{result.tags.join(" · ")}</span>}
          {settled && (
            <span
              className={`rounded-sm px-1.5 py-px text-2xs font-semibold text-ink-2 shadow-ring-g-line ${tagged ? "ml-em-0.6" : ""}`}
            >
              {result.state === "muted" ? "Muted" : "Done"}
            </span>
          )}
          <span className={tagged || settled ? "ml-em-0.6" : undefined}>
            {result.hits.length === 0
              ? "Matches the filters"
              : plural(result.hits.length, "matching line")}{" "}
            · {result.source}
          </span>
        </span>
        {result.hits.length === 0 ? (
          <span className={`${rowLineClass(unread)} row-start-3`}>{result.preview}</span>
        ) : (
          <ol className="col-start-2 col-end-4 row-start-4 mx-0 mt-2.5 mb-0.5 grid min-w-0 list-none gap-2.5 overflow-hidden p-0 text-ellipsis">
            {result.hits.map((hit) => (
              <Hit key={`${hit.field}:${hit.seq}:${hit.digest_id}`} hit={hit} />
            ))}
          </ol>
        )}
      </Link>
    </li>
  );
}

export function ResultList() {
  const [current] = useAtom(route);
  const result = useAtomValue(searchResult);
  const all = useAtomValue(found);
  const rows = useAtomValue(searchRows);
  const picked = useAtomValue(pickedGroup);
  const query = useAtomValue(searchQuery);
  const setGroup = useAtomSet(searchGroup);
  const open = Option.getOrNull(current.conversation);
  return (
    <>
      <header className={headClass}>
        <h1 className={headNameClass}>
          {Option.match(picked, {
            onNone: () => "Results",
            onSome: (view) => `In ${viewLabel(view)}`,
          })}
        </h1>
        {Option.isSome(all) && (
          <span className={headMetaClass}>
            {plural(rows.length, "conversation")} ·{" "}
            {query.text === "" ? "newest first" : "newest match first"}
          </span>
        )}
        {Option.isSome(picked) && Option.isSome(all) && (
          <button type="button" className={headActionClass} onClick={() => setGroup(Option.none())}>
            Show all {all.value.length}
          </button>
        )}
      </header>
      {Option.match(all, {
        onNone: () =>
          AsyncResult.isFailure(result) ? (
            <div className={emptyClass}>
              <p className={emptyBigClass}>Can't search right now.</p>
            </div>
          ) : null,
        onSome: (list) =>
          list.length === 0 ? (
            <div className={emptyClass}>
              <p className={emptyBigClass}>Nothing matches “{queryText(query)}”.</p>
              <p className={emptySubClass}>Done and muted conversations were searched too.</p>
            </div>
          ) : (
            <ul className={rowsClass}>
              {rows.map((row) => (
                <ResultRow key={row.id} result={row} selected={open === row.id} />
              ))}
            </ul>
          ),
      })}
    </>
  );
}
