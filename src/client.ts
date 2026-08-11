/**
 * Thin client over the Pixfaro API — shared by the MCP server and the CLI.
 * Auth: PIXFARO_KEY env (pf_live_… / pf_test_…). Endpoint override for
 * staging/self-hosting: PIXFARO_API_URL.
 */

export const DEFAULT_API_URL = "https://api.pixfaro.com";

export interface PixfaroModel {
  id: string;
  name: string;
  best_for: string;
  p50_ms: number;
  p95_ms: number;
  price: string;
  mode: "sync" | "async";
  enabled: boolean;
}

export interface GenerationResult {
  id: string;
  url: string;
  model: string;
  latency_ms: number;
  cost: string;
  balance_after: string;
  request_id: string;
}

/** API error envelope, surfaced with the request id for support. */
export class PixfaroApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  /** Extra envelope fields (balance, needed, topup_url, charged, …). */
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, requestId?: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.extra = extra;
  }
}

export interface ClientOptions {
  apiKey?: string;
  apiUrl?: string;
  fetchFn?: typeof fetch;
}

export class PixfaroClient {
  readonly #apiKey?: string;
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.#apiKey = opts.apiKey ?? process.env.PIXFARO_KEY;
    this.#apiUrl = (opts.apiUrl ?? process.env.PIXFARO_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetchFn ?? fetch;
  }

  /**
   * API responses are UNTRUSTED input to this client (the agent's context and
   * the user's terminal render what we return): every string is bounded and
   * redacted, every shape validated, and image URLs must live on an approved
   * origin before anything downstream sees them.
   */
  #redact(s: string): string {
    return this.#apiKey ? s.replaceAll(this.#apiKey, "pf_***") : s;
  }

  #str(v: unknown, max = 300): string {
    // Control chars stripped: API strings reach terminals (ANSI escape
    // injection) and agent context — neither gets to render raw escapes.
    // eslint-disable-next-line no-control-regex
    return this.#redact(String(v ?? "")).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max);
  }

  /** Image/topup URLs must be https on the API's own origin or pixfaro.com. */
  #approvedUrl(v: unknown): string | null {
    if (typeof v !== "string") return null;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return null;
    }
    const apiOrigin = new URL(this.#apiUrl).origin;
    const ok =
      u.protocol === "https:" &&
      (u.origin === apiOrigin || u.hostname === "pixfaro.com" || u.hostname.endsWith(".pixfaro.com"));
    return ok ? u.href : null;
  }

  async #request(method: string, path: string, body?: unknown, auth = true): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) {
      if (!this.#apiKey) {
        throw new PixfaroApiError(
          401,
          "no_api_key",
          "PIXFARO_KEY is not set. Get a key at https://pixfaro.com and export PIXFARO_KEY=pf_live_…",
        );
      }
      headers.authorization = `Bearer ${this.#apiKey}`;
    }
    const res = await this.#fetch(`${this.#apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PixfaroApiError(res.status, "bad_response", `Pixfaro API returned a non-JSON ${res.status} response`);
    }
    if (!res.ok) {
      const root = isRecord(json) ? json : {};
      const envelope = isRecord(root.error) ? root.error : {};
      // Only known envelope extras survive, each type-checked — arbitrary
      // fields from a compromised API never reach a terminal or agent context.
      const extra: Record<string, unknown> = {};
      if (isDecimal(root.balance)) extra.balance = root.balance;
      if (isDecimal(root.needed)) extra.needed = root.needed;
      if (typeof root.charged === "boolean") extra.charged = root.charged;
      const topup = this.#approvedUrl(root.topup_url);
      if (topup) extra.topup_url = topup;
      throw new PixfaroApiError(
        res.status,
        this.#str(envelope.code || "error", 60),
        this.#str(envelope.message || `HTTP ${res.status}`),
        envelope.request_id ? this.#str(envelope.request_id, 40) : undefined,
        extra,
      );
    }
    return json;
  }

  #badResponse(what: string): never {
    throw new PixfaroApiError(200, "bad_response", `Pixfaro API returned an unexpected ${what} shape`);
  }

  #generation(json: unknown): GenerationResult {
    if (!isRecord(json)) this.#badResponse("generation");
    const url = this.#approvedUrl(json.url);
    if (
      typeof json.id !== "string" ||
      !/^img_[0-9a-f]{20}$/.test(json.id) ||
      !url ||
      !isDecimal(json.cost) ||
      !isDecimal(json.balance_after) ||
      !(typeof json.latency_ms === "number" && Number.isFinite(json.latency_ms) && json.latency_ms >= 0)
    ) {
      this.#badResponse("generation");
    }
    return {
      id: json.id,
      url,
      model: this.#str(json.model, 60),
      latency_ms: json.latency_ms,
      cost: json.cost,
      balance_after: json.balance_after,
      request_id: this.#str(json.request_id, 40),
    };
  }

  /** Public, no key required. */
  async models(): Promise<PixfaroModel[]> {
    const json = await this.#request("GET", "/v1/models", undefined, false);
    if (!Array.isArray(json)) this.#badResponse("models");
    return json.map((m) => {
      if (!isRecord(m) || typeof m.id !== "string" || !isDecimal(m.price)) this.#badResponse("models");
      return {
        id: this.#str(m.id, 60),
        name: this.#str(m.name, 80),
        best_for: this.#str(m.best_for, 200),
        p50_ms: typeof m.p50_ms === "number" && Number.isFinite(m.p50_ms) ? m.p50_ms : 0,
        p95_ms: typeof m.p95_ms === "number" && Number.isFinite(m.p95_ms) ? m.p95_ms : 0,
        price: m.price,
        mode: m.mode === "async" ? "async" : "sync",
        enabled: m.enabled === true,
      };
    });
  }

  async balance(): Promise<{ balance: string }> {
    const json = await this.#request("GET", "/v1/balance");
    if (!isRecord(json) || !isDecimal(json.balance)) this.#badResponse("balance");
    return { balance: json.balance };
  }

  async generate(args: { model: string; prompt: string; aspect_ratio?: string }): Promise<GenerationResult> {
    return this.#generation(await this.#request("POST", "/v1/images/generations", args));
  }

  async edit(args: { model: string; image: string; instruction: string; aspect_ratio?: string }): Promise<GenerationResult> {
    return this.#generation(await this.#request("POST", "/v1/images/edits", args));
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Bounded decimal USD string, the only money shape the API speaks. */
function isDecimal(v: unknown): v is string {
  return typeof v === "string" && v.length <= 20 && /^\d+(\.\d+)?$/.test(v);
}
