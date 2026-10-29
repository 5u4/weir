import type { Event } from "@weir/daemon/Api";
import * as Option from "effect/Option";

export type Refetch = {
  readonly status: boolean;
  readonly counts: boolean;
  readonly list: boolean;
  readonly conversation: boolean;
};

export const refetches = (event: Event, open: Option.Option<number>): Refetch => {
  switch (event.type) {
    case "ready":
      return { status: true, counts: true, list: true, conversation: Option.isSome(open) };
    case "state":
      return {
        status: false,
        counts: true,
        list: true,
        conversation: Option.exists(open, (id) => event.ids.includes(id)),
      };
    case "digest":
      return {
        status: true,
        counts: false,
        list: event.status === "done",
        conversation: Option.contains(open, event.conversation_id),
      };
    case "sync":
      return { status: true, counts: true, list: true, conversation: false };
  }
};
