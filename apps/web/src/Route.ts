import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

export const View = Schema.Union([
  Schema.Literals(["untagged", "cleared"]),
  Schema.TemplateLiteral(["tag:", Schema.NonEmptyString]),
]);
export type View = typeof View.Type;

export const ConversationId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ConversationId"),
);
export type ConversationId = typeof ConversationId.Type;

const param = <S extends Schema.Top>(
  type: S,
  fromParam: (raw: string) => Option.Option<S["Type"]>,
  toParam: (value: S["Type"]) => string,
  fallback: S["Type"],
) =>
  Schema.optionalKey(Schema.String).pipe(
    Schema.decodeTo(Schema.toType(type), {
      decode: SchemaGetter.transformOptional((raw: Option.Option<string>) =>
        Option.some(Option.getOrElse(Option.flatMap(raw, fromParam), () => fallback)),
      ),
      encode: SchemaGetter.transformOptional((value: Option.Option<S["Type"]>) =>
        Option.filter(Option.map(value, toParam), (raw) => raw !== toParam(fallback)),
      ),
    }),
  );

const decodeView = Schema.decodeUnknownOption(View);
const decodeConversation = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.decodeTo(ConversationId)),
);

export const Route = Schema.Struct({
  view: param(View, decodeView, String, "untagged"),
  query: param(Schema.String, Option.some, String, ""),
  conversation: param(
    Schema.Option(ConversationId),
    (raw) => Option.map(decodeConversation(raw), Option.some),
    Option.match({ onNone: () => "", onSome: String }),
    Option.none(),
  ),
}).pipe(Schema.encodeKeys({ view: "v", query: "q", conversation: "c" }));
export type Route = typeof Route.Type;

const decodeRoute = Schema.decodeSync(Route);
const encodeRoute = Schema.encodeSync(Route);

export const parse = (search: string): Route =>
  decodeRoute(Object.fromEntries(new URLSearchParams(search)));

export const href = (route: Route) => {
  const search = new URLSearchParams(encodeRoute(route)).toString();
  return search === "" ? "/" : `/?${search}`;
};

const closedChip = /(?:^|\s)(?:from|in|source):\S+(?=\s)/gi;

export const chips = (query: string) => query.match(closedChip)?.map((chip) => chip.trim()) ?? [];

export type Write = "push" | "replace" | "none";

export const writeKind = (previous: Route, next: Route): Write => {
  if (href(previous) === href(next)) return "none";
  const typingInSearch =
    previous.view === next.view &&
    Option.getOrNull(previous.conversation) === Option.getOrNull(next.conversation) &&
    previous.query !== "" &&
    next.query !== "" &&
    chips(previous.query).join(" ") === chips(next.query).join(" ");
  return typingInSearch ? "replace" : "push";
};

export const route = Atom.writable(
  (get) => {
    const sync = () => get.setSelf(parse(location.search));
    addEventListener("popstate", sync);
    get.addFinalizer(() => removeEventListener("popstate", sync));
    return parse(location.search);
  },
  (ctx, next: Route) => {
    const kind = writeKind(ctx.get(route), next);
    if (kind === "none") return;
    if (kind === "push") history.pushState(null, "", href(next));
    else history.replaceState(null, "", href(next));
    ctx.setSelf(next);
  },
);
