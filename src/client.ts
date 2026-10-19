import type { Config } from "./config.js";
import { VobizError, extractBackendMessage, kindForStatus } from "./errors.js";
import type { Logger } from "./logger.js";
import { SERVER_VERSION } from "./version.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  /**
   * Set for requests that create side effects which must never be repeated
   * (call initiation). A transport failure is then reported as outcome_unknown
   * instead of a plain network error.
   */
  sideEffect?: boolean;
  /** Short label used in logs instead of the concrete path (which may hold phone numbers). */
  route: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
}

/**
 * Thin client for the public Vobiz REST API (https://api.vobiz.ai).
 * The gateway authenticates X-Auth-ID / X-Auth-Token and rejects any
 * /Account/{auth_id}/ path that does not belong to the caller, so every path
 * here is built from the configured auth ID, never from tool input.
 *
 * No automatic retries: callers decide, and call initiation must never be retried.
 */
export class VobizClient {
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  get authId(): string {
    if (!this.cfg.authId || !this.cfg.authToken) {
      throw new VobizError(
        "missing_credentials",
        "Vobiz credentials are not configured. Set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN for the MCP server.",
      );
    }
    return this.cfg.authId;
  }

  /** `/api/v1/Account/{auth_id}` + suffix. Capital "Account" keeps the gateway's tenant check on every path. */
  accountPath(suffix = ""): string {
    return `/api/v1/Account/${encodeURIComponent(this.authId)}${suffix}`;
  }

  async request<T = unknown>(method: HttpMethod, path: string, opts: RequestOptions): Promise<ApiResponse<T>> {
    const authId = this.authId; // throws missing_credentials before any network I/O
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      "X-Auth-ID": authId,
      "X-Auth-Token": this.cfg.authToken as string,
      Accept: "application/json",
      "User-Agent": `vobiz-mcp/${SERVER_VERSION}`,
    };
    // api-voice rejects POSTs without a JSON/form Content-Type, even with an empty body.
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    if (hasBody) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(opts.body ?? {}) : undefined,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      this.log.info(`${opts.route} -> ${timedOut ? "timeout" : "network error"} (${Date.now() - started}ms)`);
      if (opts.sideEffect) {
        throw new VobizError(
          "outcome_unknown",
          `${timedOut ? "The request timed out" : "The connection failed"} before Vobiz answered, so it is unknown whether the call was placed. ` +
            "Do NOT retry automatically. Check list_live_calls and list_call_records first.",
        );
      }
      throw timedOut
        ? new VobizError("timeout", `Vobiz did not respond within ${this.cfg.timeoutMs}ms.`)
        : new VobizError("network_error", "Could not reach the Vobiz API. Check VOBIZ_BASE_URL and network access.");
    } finally {
      clearTimeout(timer);
    }

    this.log.info(`${opts.route} -> ${res.status} (${Date.now() - started}ms)`);

    const text = await res.text().catch(() => "");
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }

    if (res.status >= 200 && res.status < 300) {
      if (text && data === undefined) {
        throw new VobizError("unexpected_response", "Vobiz returned a non-JSON success response.", res.status);
      }
      return { status: res.status, data: data as T };
    }

    if (res.status >= 300 && res.status < 400) {
      throw new VobizError("unexpected_response", `Vobiz answered with an unexpected redirect (${res.status}).`, res.status);
    }

    const backendMsg = extractBackendMessage(data ?? text) ?? `HTTP ${res.status}`;
    const apiId =
      data && typeof data === "object" && typeof (data as Record<string, unknown>).api_id === "string"
        ? ((data as Record<string, unknown>).api_id as string)
        : undefined;
    throw new VobizError(kindForStatus(res.status, backendMsg), backendMsg, res.status, apiId);
  }
}
