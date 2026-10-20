/**
 * Human confirmation for actions that spend money, contact people or change call routing.
 *
 * When the connected MCP client supports form elicitation, the server asks the human directly
 * (elicitation/create) with a message naming the destination number, URL host or cost, and proceeds only on
 * an explicit accept with approve: true. The model cannot answer that prompt, so a prompt-injected model
 * cannot approve its own action.
 *
 * Clients without elicitation keep the `confirm: true` flag. That flag is MODEL-ATTESTED: the model sets it
 * after (it says) the user agreed. It is a speed bump, not a guarantee.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ClientCapabilities, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { VobizError } from "../errors.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** How long the human has to answer the prompt. */
export const ELICIT_TIMEOUT_MS = 180_000;

/** Appended to `confirm` input descriptions. */
export const CONFIRM_NOTE =
  " If your client supports MCP elicitation, the server asks the user to approve directly and this flag is not relied on; otherwise it is your attestation that the user approved.";

export interface ConfirmSpec {
  /** The model's confirm flag (used only without elicitation). */
  confirmed: boolean | undefined;
  /** Shown to the human: what will happen, with the destination number / URL host / cost hint. */
  message: string;
  /** confirmation_required text for clients without elicitation. */
  fallback: string;
}

/** True when the client accepts form-mode elicitation (an empty capability object means form). */
export function supportsFormElicitation(caps: ClientCapabilities | undefined): boolean {
  const e = caps?.elicitation as { form?: unknown; url?: unknown } | undefined;
  if (!e) return false;
  return e.form !== undefined || e.url === undefined;
}

/** Host of a URL for confirmation messages ("(invalid URL)" when it does not parse). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * Resolves when the action may proceed; throws otherwise. Returns how approval was obtained.
 * Declines, cancels and unanswered prompts never proceed (fail closed).
 */
export async function requireApproval(server: McpServer, extra: ToolExtra | undefined, spec: ConfirmSpec): Promise<"user" | "model_attested"> {
  if (!supportsFormElicitation(server.server.getClientCapabilities())) {
    if (spec.confirmed !== true) throw new VobizError("confirmation_required", spec.fallback);
    return "model_attested";
  }
  let res: { action: string; content?: Record<string, unknown> };
  try {
    res = await server.server.elicitInput(
      {
        mode: "form",
        message: spec.message,
        requestedSchema: {
          type: "object",
          properties: { approve: { type: "boolean", title: "Approve", description: "Approve this action" } },
          required: ["approve"],
        },
      },
      { timeout: ELICIT_TIMEOUT_MS, ...(extra?.requestId !== undefined ? { relatedRequestId: extra.requestId } : {}), ...(extra?.signal ? { signal: extra.signal } : {}) },
    );
  } catch {
    throw new VobizError("confirmation_required", "The user's approval could not be obtained (the prompt failed or was not answered), so nothing was done.");
  }
  if (res.action === "accept" && res.content?.approve === true) return "user";
  throw new VobizError("not_allowed", "The user did not approve this action, so nothing was done. Do not retry unless the user asks again.");
}
