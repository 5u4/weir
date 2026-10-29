import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class GwsError extends Schema.TaggedError<GwsError>()("GwsError", {
  exitCode: Schema.Number,
  code: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

export const Header = Schema.StructWithRest(
  Schema.Struct({ name: Schema.String, value: Schema.String }),
  Rest,
);
export type Header = typeof Header.Type;

const PartBody = Schema.StructWithRest(
  Schema.Struct({ data: Schema.optionalKey(Schema.String) }),
  Rest,
);

export interface MessagePart {
  readonly mimeType: string;
  readonly headers?: ReadonlyArray<Header>;
  readonly body?: typeof PartBody.Type;
  readonly parts?: ReadonlyArray<MessagePart>;
  readonly [key: string]: unknown;
}

const MessagePart: Schema.Codec<MessagePart> = Schema.StructWithRest(
  Schema.Struct({
    mimeType: Schema.String,
    headers: Schema.optionalKey(Schema.Array(Header)),
    body: Schema.optionalKey(PartBody),
    parts: Schema.optionalKey(Schema.Array(Schema.suspend(() => MessagePart))),
  }),
  Rest,
);

export const Message = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    threadId: Schema.String,
    labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
    internalDate: Schema.String,
    payload: MessagePart,
  }),
  Rest,
);
export type Message = typeof Message.Type;

const Profile = Schema.Struct({ emailAddress: Schema.String, historyId: Schema.String });

const SendAsList = Schema.Struct({
  sendAs: Schema.optionalKey(Schema.Array(Schema.Struct({ sendAsEmail: Schema.String }))),
});

const MessageRef = Schema.Struct({ id: Schema.String });

const MessageList = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(MessageRef)),
  nextPageToken: Schema.optionalKey(Schema.String),
});

const Changes = Schema.optionalKey(Schema.Array(Schema.Struct({ message: MessageRef })));

const HistoryList = Schema.Struct({
  history: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        messagesAdded: Changes,
        messagesDeleted: Changes,
        labelsAdded: Changes,
        labelsRemoved: Changes,
      }),
    ),
  ),
  nextPageToken: Schema.optionalKey(Schema.String),
  historyId: Schema.String,
});
export type HistoryList = typeof HistoryList.Type;

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.optionalKey(Schema.Number),
      reason: Schema.optionalKey(Schema.String),
      message: Schema.String,
    }),
  }),
);

export type Command = ReadonlyArray<string>;
type Params = Record<string, unknown>;

const call = async <A>(
  command: Command,
  method: ReadonlyArray<string>,
  params: Params,
  schema: Schema.Codec<A>,
  signal?: AbortSignal,
): Promise<A> => {
  signal?.throwIfAborted();
  const proc = Bun.spawn(
    [...command, "gmail", "users", ...method, "--params", JSON.stringify(params)],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  signal?.throwIfAborted();
  if (exitCode !== 0) {
    const body = Schema.decodeUnknownOption(ErrorBody)(stdout);
    throw new GwsError(
      Option.match(body, {
        onNone: () => ({ exitCode, message: stderr.trim() || `exited with code ${exitCode}` }),
        onSome: ({ error }) => ({ exitCode, ...error }),
      }),
    );
  }
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(stdout);
};

export const getProfile = (command: Command, signal?: AbortSignal) =>
  call(command, ["getProfile"], { userId: "me" }, Profile, signal);

export const listSendAs = (command: Command) =>
  call(command, ["settings", "sendAs", "list"], { userId: "me" }, SendAsList);

export const listMessages = (
  command: Command,
  q: string,
  pageToken: string | null,
  maxResults: number,
  signal: AbortSignal,
) =>
  call(
    command,
    ["messages", "list"],
    { userId: "me", q, maxResults, ...(pageToken === null ? {} : { pageToken }) },
    MessageList,
    signal,
  );

export const getMessage = (command: Command, id: string, signal: AbortSignal) =>
  call(command, ["messages", "get"], { userId: "me", id, format: "full" }, Message, signal);

export const listHistory = (
  command: Command,
  startHistoryId: string,
  pageToken: string | null,
  signal: AbortSignal,
) =>
  call(
    command,
    ["history", "list"],
    {
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
      ...(pageToken === null ? {} : { pageToken }),
    },
    HistoryList,
    signal,
  );
