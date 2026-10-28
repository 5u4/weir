import { Rule } from "@weir/contract/Rule";
import type { SourcedItemRow } from "@weir/store/Rows";
import * as JsonPointer from "effect/JsonPointer";

export interface RuleInput {
  readonly source: string;
  readonly threadId: string | null;
  readonly containerId: string;
  readonly containerName: string;
  readonly title: string | null;
  readonly from: { readonly name: string; readonly address: string };
  readonly fromMe: boolean;
  readonly body: string;
  readonly raw: unknown;
}

export const ruleInput = (item: SourcedItemRow): RuleInput => ({
  source: item.sourceId,
  threadId: item.threadId,
  containerId: item.containerId,
  containerName: item.containerName,
  title: item.title,
  from: { name: item.fromName, address: item.fromAddress.toLowerCase() },
  fromMe: item.fromMe,
  body: item.body,
  raw: item.raw,
});

const resolve = (root: unknown, pointer: string): unknown => {
  if (pointer === "") return root;
  let current = root;
  for (const token of pointer.slice(1).split("/")) {
    const key = JsonPointer.unescapeToken(token);
    if (current === null || typeof current !== "object") return undefined;
    const present = Array.isArray(current)
      ? /^(0|[1-9]\d*)$/.test(key) && Number(key) < current.length
      : Object.hasOwn(current, key);
    if (!present) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
};

export const match = (rule: Rule, root: unknown): boolean =>
  Rule.match(rule, {
    and: ({ rules }) => rules.every((inner) => match(inner, root)),
    or: ({ rules }) => rules.some((inner) => match(inner, root)),
    not: ({ rule: inner }) => !match(inner, root),
    eq: ({ target, is }) => resolve(root, target) === is,
    regex: ({ target, regex, flags }) => {
      const value = resolve(root, target);
      return typeof value === "string" && new RegExp(regex, flags).test(value);
    },
    exists: ({ target }) => resolve(root, target) !== undefined,
    some: ({ target, rule: inner }) => {
      const value = resolve(root, target);
      return Array.isArray(value) && value.some((element) => match(inner, element));
    },
    every: ({ target, rule: inner }) => {
      const value = resolve(root, target);
      return Array.isArray(value) && value.every((element) => match(inner, element));
    },
  });
