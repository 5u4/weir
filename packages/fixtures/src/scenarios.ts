import data from "../scenarios.json" with { type: "json" };

export type Person = { name: string; addr: string; bot?: boolean; signature?: string };
export type ThreadMessage = { at: string; from: string; to: string[]; cc?: string[]; text: string };
export type Thread = {
  id: string;
  subject: string;
  labels: string[];
  headers?: Record<string, string>;
  messages: ThreadMessage[];
};
export type Scenarios = {
  seenCutoff: string;
  me: string;
  people: Record<string, Person>;
  chats: unknown[];
  threads: Thread[];
};

export const scenarios: Scenarios = data;
