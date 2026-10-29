import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { parseQuery, sameParams, searchParams } from "./Query.ts";
import { narrowed, picked, type Result } from "./Results.ts";
import { route, type View } from "./Route.ts";
import { tagOrder, Weir } from "./Weir.ts";

const debounce = Duration.millis(150);

export const searchQuery = Atom.make((get) => parseQuery(get(route).query, get(tagOrder)));

const searchRequest = Atom.make((get) => searchParams(get(searchQuery))).pipe(
  Atom.withEquality(Option.makeEquivalence(sameParams)),
);

export const searching = Atom.make((get) => Option.isSome(get(searchRequest)));

export const searchResult = Weir.runtime
  .atom((get) =>
    Option.match(get(searchRequest), {
      onNone: () => Effect.succeed(Option.none<ReadonlyArray<Result>>()),
      onSome: (query) =>
        Effect.gen(function* () {
          yield* Effect.sleep(debounce);
          const client = yield* Weir;
          const { conversations } = yield* client.search({ query });
          return Option.some(conversations);
        }),
    }),
  )
  .pipe(Atom.withReactivity(["list"]));

export const searchGroup = Atom.make(Option.none<View>());

export const found = Atom.make((get) => Option.flatten(AsyncResult.value(get(searchResult))));

export const pickedGroup = Atom.make((get) =>
  Option.flatMap(get(found), (results) => picked(results, get(tagOrder), get(searchGroup))),
);

export const searchRows = Atom.make((get) =>
  Option.match(get(found), {
    onNone: (): ReadonlyArray<Result> => [],
    onSome: (results) => narrowed(results, get(pickedGroup)),
  }),
);
