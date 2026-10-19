import { createRequire } from "node:module";

/** Single source of truth: the version in package.json (shipped with the npm package). */
export const SERVER_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
