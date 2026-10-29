import type { Row } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import type { Sender } from "./Notch.ts";
import type { View } from "./Route.ts";

export type Intent =
  | { readonly _tag: "Done"; readonly lastSeq: number }
  | { readonly _tag: "Restore"; readonly clearedSeq: number };

export type Intents = ReadonlyMap<number, Intent>;

export const intentFor = (view: View, row: Row): Intent =>
  view === "cleared"
    ? { _tag: "Restore", clearedSeq: row.cleared_seq }
    : { _tag: "Done", lastSeq: row.last_seq };

export const shown = (view: View, rows: ReadonlyArray<Row>, intents: Intents) =>
  rows.filter((row) => {
    const intent = intents.get(row.id);
    if (intent === undefined) return true;
    return intent._tag === "Done"
      ? view === "cleared" || row.last_seq > intent.lastSeq
      : view !== "cleared" || row.cleared_seq > intent.clearedSeq;
  });

export const neighbor = (rows: ReadonlyArray<Row>, id: number) => {
  const at = rows.findIndex((row) => row.id === id);
  if (at < 0) return Option.none<Row>();
  return Option.fromNullishOr(rows[at + 1] ?? rows[at - 1]);
};

type Face = {
  readonly from: Sender;
  readonly preview: string;
  readonly who: string;
  readonly names: string;
};

export const face = (row: Row): Face => {
  const names = row.senders
    .map(({ name, address }) => {
      const label = name.trim() === "" ? (address.split("@")[0] ?? "") : name.trim();
      return label.split(/\s+/)[0] ?? "";
    })
    .join(", ");
  const more = row.participants - row.senders.length;
  return {
    from: row.from,
    preview: row.preview,
    who: more > 0 ? (names === "" ? `+${more}` : `${names} +${more}`) : names,
    names,
  };
};
