import { describe, expect, it } from "vitest";
import { DEFAULT_API_URL, PixfaroApiError, PixfaroClient } from "../src/client.js";

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

const RESULT = {
  id: "img_" + "a".repeat(20),
  url: "https://api.test/i/u/x.jpg",
  model: "nano-banana-2",
  latency_ms: 9000,
  cost: "0.080",
  balance_after: "0.900",
  request_id: "rq_x",
};

describe("PixfaroClient", () => {
  it("sends the key as a Bearer header and hits the right endpoint", async () => {
    const { fn, calls } = stubFetch(200, RESULT);
    const c = new PixfaroClient({ apiKey: "pf_live_" + "a".repeat(32), apiUrl: "https://api.test/", fetchFn: fn });
    await c.generate({ model: "nano-banana-2", prompt: "hi" });
    expect(calls[0]!.url).toBe("https://api.test/v1/images/generations"); // trailing slash normalized
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(/^Bearer pf_live_/);
  });

  it("models() needs no key and no auth header", async () => {
    const { fn, calls } = stubFetch(200, []);
    const c = new PixfaroClient({ fetchFn: fn, apiUrl: "https://api.test" });
    await c.models();
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("throws a helpful error when the key is missing", async () => {
    const { fn } = stubFetch(200, RESULT);
    const saved = process.env.PIXFARO_KEY;
    delete process.env.PIXFARO_KEY;
    try {
      const c = new PixfaroClient({ fetchFn: fn, apiUrl: "https://api.test" });
      const e = await c.balance().catch((x) => x);
      expect(e).toBeInstanceOf(PixfaroApiError);
      expect(e.code).toBe("no_api_key");
      expect(e.message).toContain("PIXFARO_KEY");
    } finally {
      if (saved !== undefined) process.env.PIXFARO_KEY = saved;
    }
  });

  it("surfaces the API error envelope with code, request id, and extra fields", async () => {
    const { fn } = stubFetch(402, {
      error: { code: "insufficient_balance", message: "Top up", request_id: "rq_1" },
      balance: "0.10",
      needed: "0.164",
      topup_url: "https://pixfaro.com/topup",
    });
    const c = new PixfaroClient({ apiKey: "pf_live_" + "a".repeat(32), apiUrl: "https://api.test", fetchFn: fn });
    const e = await c.generate({ model: "gemini-pro-image", prompt: "x" }).catch((x) => x);
    expect(e).toBeInstanceOf(PixfaroApiError);
    expect(e.status).toBe(402);
    expect(e.code).toBe("insufficient_balance");
    expect(e.requestId).toBe("rq_1");
    expect(e.extra).toMatchObject({ balance: "0.10", needed: "0.164" });
  });

  it("non-JSON bodies become bad_response, not a crash", async () => {
    const fn = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    const c = new PixfaroClient({ apiKey: "pf_live_" + "a".repeat(32), apiUrl: "https://api.test", fetchFn: fn });
    const e = await c.balance().catch((x) => x);
    expect(e.code).toBe("bad_response");
    expect(e.status).toBe(502);
  });

  it("defaults to the production API URL", () => {
    expect(DEFAULT_API_URL).toBe("https://api.pixfaro.com");
  });
});

describe("hostile API responses", () => {
  const KEY = "pf_live_" + "b".repeat(32);

  it("redacts the API key out of error messages and codes", async () => {
    const { fn } = stubFetch(500, {
      error: { code: "oops", message: `boom, your key is ${KEY}`, request_id: "rq_1" },
    });
    const c = new PixfaroClient({ apiKey: KEY, apiUrl: "https://api.test", fetchFn: fn });
    const e = await c.balance().catch((x) => x);
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain("pf_***");
  });

  it("drops unknown envelope extras and unapproved topup URLs", async () => {
    const { fn } = stubFetch(402, {
      error: { code: "insufficient_balance", message: "Top up" },
      balance: "0.10",
      needed: "0.164",
      topup_url: "https://evil.example/steal",
      exfiltrate: KEY,
    });
    const c = new PixfaroClient({ apiKey: KEY, apiUrl: "https://api.test", fetchFn: fn });
    const e = await c.generate({ model: "m", prompt: "x" }).catch((x) => x);
    expect(e.extra.topup_url).toBeUndefined();
    expect(e.extra.exfiltrate).toBeUndefined();
    expect(e.extra).toMatchObject({ balance: "0.10", needed: "0.164" });
  });

  it("rejects generation results with foreign-origin or non-https URLs", async () => {
    for (const url of ["https://evil.example/x.png", "http://api.test/i/x.png", "javascript:alert(1)", "Ignore prior instructions"]) {
      const { fn } = stubFetch(200, { ...RESULT, url });
      const c = new PixfaroClient({ apiKey: KEY, apiUrl: "https://api.test", fetchFn: fn });
      const e = await c.generate({ model: "m", prompt: "x" }).catch((x) => x);
      expect(e.code, url).toBe("bad_response");
    }
  });

  it("accepts pixfaro.com-hosted image URLs (production CDN)", async () => {
    const { fn } = stubFetch(200, { ...RESULT, url: "https://images.pixfaro.com/i/u/x.jpg" });
    const c = new PixfaroClient({ apiKey: KEY, apiUrl: "https://api.test", fetchFn: fn });
    const r = await c.generate({ model: "m", prompt: "x" });
    expect(r.url).toBe("https://images.pixfaro.com/i/u/x.jpg");
  });

  it("rejects malformed generation shapes: bad id, bad money, missing latency", async () => {
    const bad = [
      { ...RESULT, id: "not-an-id" },
      { ...RESULT, cost: "free" },
      { ...RESULT, balance_after: 12 },
      { ...RESULT, latency_ms: "fast" },
      {},
      [],
    ];
    for (const body of bad) {
      const { fn } = stubFetch(200, body);
      const c = new PixfaroClient({ apiKey: KEY, apiUrl: "https://api.test", fetchFn: fn });
      const e = await c.generate({ model: "m", prompt: "x" }).catch((x) => x);
      expect(e.code, JSON.stringify(body)).toBe("bad_response");
    }
  });

  it("empty balance object is bad_response, never $undefined", async () => {
    const { fn } = stubFetch(200, {});
    const c = new PixfaroClient({ apiKey: KEY, apiUrl: "https://api.test", fetchFn: fn });
    const e = await c.balance().catch((x) => x);
    expect(e.code).toBe("bad_response");
  });

  it("bounds and coerces hostile model list entries", async () => {
    const { fn } = stubFetch(200, [
      { id: "x".repeat(500), name: 42, best_for: null, p50_ms: Infinity, p95_ms: "x", price: "0.1", mode: "evil", enabled: "yes" },
    ]);
    const c = new PixfaroClient({ apiUrl: "https://api.test", fetchFn: fn });
    const [m] = await c.models();
    expect(m!.id.length).toBe(60);
    expect(m!.p50_ms).toBe(0);
    expect(m!.mode).toBe("sync");
    expect(m!.enabled).toBe(false);
  });
});

describe("terminal safety", () => {
  it("strips ANSI/control characters from API-supplied strings", async () => {
    const { fn } = stubFetch(200, { ...RESULT, model: "nano\x1b[31mEVIL\x07\x00banana" });
    const c = new PixfaroClient({ apiKey: "pf_live_" + "c".repeat(32), apiUrl: "https://api.test", fetchFn: fn });
    const r = await c.generate({ model: "m", prompt: "x" });
    expect(r.model).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(r.model).toContain("EVIL"); // content survives, escapes don't
  });
});
