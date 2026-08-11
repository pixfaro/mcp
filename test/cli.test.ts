import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "../src/cli.js";
import { PixfaroApiError, PixfaroClient } from "../src/client.js";

const RESULT = {
  id: "img_" + "a".repeat(20),
  url: "https://api.test/i/u/x.png",
  model: "nano-banana-2",
  latency_ms: 9000,
  cost: "0.080",
  balance_after: "0.900",
  request_id: "rq_x",
};

function fakeClient(overrides: Partial<Record<keyof PixfaroClient, unknown>> = {}): PixfaroClient {
  return {
    models: async () => [
      { id: "nano-banana-2", name: "NB2", best_for: "general", p50_ms: 10700, p95_ms: 13600, price: "0.080", mode: "sync", enabled: true },
      { id: "gpt-5-image", name: "G5", best_for: "complex", p50_ms: 53000, p95_ms: 60400, price: "0.238", mode: "async", enabled: false },
    ],
    balance: async () => ({ balance: "0.900" }),
    generate: async () => RESULT,
    edit: async () => RESULT,
    ...overrides,
  } as unknown as PixfaroClient;
}

let logs: string[];
let errs: string[];
beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("parseArgs", () => {
  it("extracts flags in any position and keeps the rest", () => {
    const f = parseArgs(["a", "-m", "flux", "lighthouse", "--aspect", "16:9", "-o", "x.png"]);
    expect(f).toEqual({ model: "flux", aspect: "16:9", out: "x.png", force: false, rest: ["a", "lighthouse"] });
    expect(parseArgs(["x"]).aspect).toBeUndefined();
  });
});

describe("cli main", () => {
  it("gen prints the URL to stdout and metadata to stderr", async () => {
    const rc = await main(["gen", "a", "lighthouse"], fakeClient());
    expect(rc).toBe(0);
    expect(logs).toEqual([RESULT.url]);
    expect(errs[0]).toContain("$0.080");
  });

  it("gen -o downloads the image to the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pixfaro-cli-"));
    const file = join(dir, "out.png");
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchFn = (async () => new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })) as typeof fetch;
    try {
      const rc = await main(["gen", "x", "-o", file], fakeClient(), fetchFn);
      expect(rc).toBe(0);
      expect(new Uint8Array(readFileSync(file))).toEqual(bytes);
      expect(errs.some((l) => l.includes("saved"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edit requires both id and instruction", async () => {
    expect(await main(["edit", "img_x"], fakeClient())).toBe(2);
    expect(await main(["edit"], fakeClient())).toBe(2);
  });

  it("models lists enabled and coming-soon models", async () => {
    const rc = await main(["models"], fakeClient());
    expect(rc).toBe(0);
    expect(logs.join("\n")).toContain("nano-banana-2");
    expect(logs.join("\n")).toContain("[coming soon]");
  });

  it("API errors exit 1 with the code and a topup hint on 402", async () => {
    const failing = fakeClient({
      generate: async () => {
        throw new PixfaroApiError(402, "insufficient_balance", "Top up", "rq_1", {
          balance: "0.10",
          needed: "0.164",
          topup_url: "https://pixfaro.com/topup",
        });
      },
    });
    const rc = await main(["gen", "x"], failing);
    expect(rc).toBe(1);
    expect(errs.join("\n")).toContain("insufficient_balance");
    expect(errs.join("\n")).toContain("topup");
  });

  it("no command prints help and exits 2; help exits 0", async () => {
    expect(await main([], fakeClient())).toBe(2);
    expect(await main(["help"], fakeClient())).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
  });
});

describe("download safety", () => {
  it("refuses to overwrite an existing file without -f, overwrites with -f", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pixfaro-cli-"));
    const file = join(dir, "out.png");
    const fetchFn = (async () => new Response(new Uint8Array([1]).buffer, { status: 200 })) as typeof fetch;
    try {
      expect(await main(["gen", "x", "-o", file], fakeClient(), fetchFn)).toBe(0);
      errs = [];
      expect(await main(["gen", "x", "-o", file], fakeClient(), fetchFn)).toBe(1);
      expect(errs.join("\n")).toContain("-f to overwrite");
      expect(await main(["gen", "x", "-o", file, "-f"], fakeClient(), fetchFn)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses downloads that declare more than 64 MB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pixfaro-cli-"));
    const file = join(dir, "big.png");
    const fetchFn = (async () =>
      new Response(new Uint8Array([1]).buffer, { status: 200, headers: { "content-length": String(65 * 1024 * 1024) } })) as typeof fetch;
    try {
      expect(await main(["gen", "x", "-o", file], fakeClient(), fetchFn)).toBe(1);
      expect(errs.join("\n")).toContain("64 MB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("paid URL survives download failures", () => {
  it("prints the URL even when -o write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pixfaro-cli-"));
    const file = join(dir, "keep.png");
    const fetchFn = (async () => new Response(new Uint8Array([1]).buffer, { status: 200 })) as typeof fetch;
    try {
      await main(["gen", "x", "-o", file], fakeClient(), fetchFn); // creates the file
      logs = [];
      const rc = await main(["gen", "x", "-o", file], fakeClient(), fetchFn); // exists → download fails
      expect(rc).toBe(1);
      expect(logs).toContain(RESULT.url); // the $0.08 URL is not lost
      expect(errs.join("\n")).toContain("still valid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("edit aspect default (dogfood)", () => {
  it("edit without -a sends no aspect_ratio; gen defaults to 1:1", async () => {
    const seen: Array<string | undefined> = [];
    const spy = fakeClient({
      generate: async (a: { aspect_ratio?: string }) => (seen.push(a.aspect_ratio), RESULT),
      edit: async (a: { aspect_ratio?: string }) => (seen.push(a.aspect_ratio), RESULT),
    });
    await main(["gen", "x"], spy);
    await main(["edit", "img_" + "a".repeat(20), "fix"], spy);
    await main(["edit", "img_" + "a".repeat(20), "fix", "-a", "16:9"], spy);
    expect(seen).toEqual(["1:1", undefined, "16:9"]);
  });
});
