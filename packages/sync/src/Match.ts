import { type ItemRule, type RuleInput, TagRule } from "@weir/contract/Rule";
import type { SourcedItemRow } from "@weir/store/Rows";
import * as JsonPointer from "effect/JsonPointer";

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

export const match = (rule: TagRule, root: unknown, group: string | null): boolean =>
  TagRule.match(rule, {
    and: ({ rules }) => rules.every((inner) => match(inner, root, group)),
    or: ({ rules }) => rules.some((inner) => match(inner, root, group)),
    not: ({ rule: inner }) => !match(inner, root, group),
    eq: ({ target, is }) => resolve(root, target) === is,
    regex: ({ target, regex, flags }) => {
      const value = resolve(root, target);
      return typeof value === "string" && new RegExp(regex, flags).test(value);
    },
    exists: ({ target }) => resolve(root, target) !== undefined,
    some: ({ target, rule: inner }) => {
      const value = resolve(root, target);
      return Array.isArray(value) && value.some((element) => match(inner, element, group));
    },
    every: ({ target, rule: inner }) => {
      const value = resolve(root, target);
      return Array.isArray(value) && value.every((element) => match(inner, element, group));
    },
    group: ({ name }) => group === name,
  });

export const matchItem = (rule: ItemRule, root: unknown) => match(rule, root, null);
