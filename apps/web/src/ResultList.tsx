import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { CSSProperties } from "react";
import { Avatar } from "./Avatar.tsx";
import { dayAndTime, now, plural, shortTime } from "./Health.ts";
import { Link } from "./Link.tsx";
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
    <li className="hl">
      <span className="hl-k">
        {hit.seq !== null && <b>#{hit.seq}</b>}
        <i>{fieldLabels[hit.field]}</i>
      </span>
      <span className={`hl-t${hit.field === "topic" || hit.field === "headline" ? " hl-z" : ""}`}>
        {hit.title !== null && (
          <b className="hl-g">
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
  return (
    <li
      className={`row${result.state === "unread" ? " unread" : ""}${selected ? " sel" : ""}`}
      style={hue === undefined ? undefined : ({ "--bh": hue } as CSSProperties)}
    >
      <Link
        to={{ ...current, conversation: Option.some(ConversationId.make(result.id)) }}
        current={selected}
        className="row-link"
      >
        <span className="row-av">
          <Avatar address={from.address} mark={mark} />
        </span>
        <span className="row-title">{result.title}</span>
        <time className="row-time" dateTime={result.last_at} title={dayAndTime(last)}>
          {shortTime(last, at)}
        </time>
        <span className="row-meta">
          {result.tags.length > 0 && <span className="row-b">{result.tags.join(" · ")}</span>}
          {cleared(result) && (
            <span className="row-st">{result.state === "muted" ? "Muted" : "Done"}</span>
          )}
          <span className="row-n">
            {result.hits.length === 0
              ? "Matches the filters"
              : plural(result.hits.length, "matching line")}{" "}
            · {result.source}
          </span>
        </span>
        {result.hits.length === 0 ? (
          <span className="row-line">{result.preview}</span>
        ) : (
          <ol className="hits">
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
      <header className="l-head">
        <h1 className="l-name">
          {Option.match(picked, {
            onNone: () => "Results",
            onSome: (view) => `In ${viewLabel(view)}`,
          })}
        </h1>
        {Option.isSome(all) && (
          <span className="l-meta">
            {plural(rows.length, "conversation")} ·{" "}
            {query.text === "" ? "newest first" : "newest match first"}
          </span>
        )}
        {Option.isSome(picked) && Option.isSome(all) && (
          <button type="button" className="clearall" onClick={() => setGroup(Option.none())}>
            Show all {all.value.length}
          </button>
        )}
      </header>
      {Option.match(all, {
        onNone: () =>
          AsyncResult.isFailure(result) ? (
            <div className="empty">
              <p className="empty-big">Can't search right now.</p>
            </div>
          ) : null,
        onSome: (list) =>
          list.length === 0 ? (
            <div className="empty">
              <p className="empty-big">Nothing matches “{queryText(query)}”.</p>
              <p className="empty-sub">Done and muted conversations were searched too.</p>
            </div>
          ) : (
            <ul className="rows res">
              {rows.map((row) => (
                <ResultRow key={row.id} result={row} selected={open === row.id} />
              ))}
            </ul>
          ),
      })}
    </>
  );
}
