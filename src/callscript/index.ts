/**
 * Call scripts for make_call (`say` / `play`): the public surface of the module.
 */
import type { Logger } from "../logger.js";
import type { MediaService } from "../media/types.js";
import type { Sealer } from "../sealer.js";
import type { SignatureMode } from "../webhooks.js";
import { createCallScriptRouter } from "./router.js";
import { mintScriptUrls } from "./service.js";
import type { CallScriptBackend } from "./types.js";

export * from "./types.js";
export {
  AUDIO_GONE_TEXT,
  INACTIVE_CALL_TEXT,
  LOOP_MAX,
  PAGE_LINK_MESSAGE,
  PLAY_URL_MAX,
  SAY_MAX_CHARS,
  SCRIPT_TTL_SEC,
  checkPlayUrl,
  cleanSayText,
  effectiveOrder,
  inactiveCallXml,
  looksLikeUrl,
  mintScriptUrls,
  openScript,
  scriptXml,
} from "./service.js";
export { createCallScriptRouter, type CallScriptRouterOptions } from "./router.js";

export interface CallScriptBackendOptions {
  /** Public https base URL of this server, as handed to Vobiz. */
  baseUrl: string;
  sealer: Sealer;
  media?: MediaService;
  log: Logger;
  signatureMode: SignatureMode;
}

export function createCallScriptBackend(o: CallScriptBackendOptions): CallScriptBackend {
  return {
    baseUrl: o.baseUrl.replace(/\/+$/, ""),
    router: createCallScriptRouter(o),
    mint: (script) => mintScriptUrls(o.sealer, o.baseUrl, script),
  };
}
