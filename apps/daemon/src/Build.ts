import { join } from "node:path";

declare const WEIR_VERSION: string;

const bundledVersion: string | undefined =
  typeof WEIR_VERSION === "undefined" ? undefined : WEIR_VERSION;

export const version = bundledVersion ?? "dev";

export const bundleFile = (name: string): string | undefined =>
  bundledVersion === undefined ? undefined : join(import.meta.dirname, name);
