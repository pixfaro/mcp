#!/usr/bin/env node
/**
 * pixfaro CLI — the one-command time-to-first-image (docs/05).
 *
 *   npx pixfaro gen "a lighthouse at night" -m nano-banana-2 -o cover.png
 *   npx pixfaro edit img_… "make the sky darker" -o v2.png
 *   npx pixfaro models
 *   npx pixfaro balance
 *
 * Auth: PIXFARO_KEY env. Endpoint override: PIXFARO_API_URL.
 */
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PixfaroApiError, PixfaroClient, type GenerationResult } from "./client.js";

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const HELP = `pixfaro — image generation for agents, scripts, and pipelines

Usage:
  pixfaro gen "<prompt>" [-m <model>] [-a <w:h>] [-o <file>]
  pixfaro edit <img_id> "<instruction>" [-m <model>] [-a <w:h>] [-o <file>]
  pixfaro models
  pixfaro balance

Options:
  -m, --model <id>     model id (default nano-banana-2; see \`pixfaro models\`)
  -a, --aspect <w:h>   aspect ratio, e.g. 16:9 (default 1:1)
  -o, --out <file>     download the image to a file (default: print the URL)
  -f, --force          overwrite the -o file if it already exists

Env:
  PIXFARO_KEY          API key (pf_live_…) — required for gen/edit/balance
  PIXFARO_API_URL      endpoint override (self-hosted / staging)
`;

interface Flags {
  model: string;
  aspect: string;
  out?: string;
  force: boolean;
  rest: string[];
}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = { model: "nano-banana-2", aspect: "1:1", force: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-m" || a === "--model") flags.model = argv[++i] ?? "";
    else if (a === "-a" || a === "--aspect") flags.aspect = argv[++i] ?? "";
    else if (a === "-o" || a === "--out") flags.out = argv[++i];
    else if (a === "-f" || a === "--force") flags.force = true;
    else flags.rest.push(a);
  }
  return flags;
}

/** url has already passed the client's origin allowlist — never fetch anything else. */
async function download(url: string, file: string, force: boolean, fetchFn: typeof fetch): Promise<void> {
  if (!force && existsSync(file)) {
    throw new Error(`${file} already exists — pass -f to overwrite`);
  }
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error("download larger than 64 MB — refusing");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("download larger than 64 MB — refusing");
  await writeFile(file, bytes);
}

function printResult(r: GenerationResult): void {
  console.log(r.url);
  console.error(`id ${r.id} · ${r.model} · ${(r.latency_ms / 1000).toFixed(1)}s · $${r.cost} · balance $${r.balance_after}`);
}

/**
 * The generation is already paid for by the time we download — a failed -o
 * write must never swallow the URL the user just bought.
 */
async function finish(r: GenerationResult, out: string | undefined, force: boolean, fetchFn: typeof fetch): Promise<number> {
  if (!out) {
    printResult(r);
    return 0;
  }
  try {
    await download(r.url, out, force, fetchFn);
    console.error(`saved ${out}`);
    printResult(r);
    return 0;
  } catch (e) {
    printResult(r);
    console.error(`download failed: ${e instanceof Error ? e.message : String(e)} — the URL above is still valid`);
    return 1;
  }
}

export async function main(
  argv: string[],
  client = new PixfaroClient(),
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const [cmd, ...restArgv] = argv;
  const { model, aspect, out, force, rest } = parseArgs(restArgv);
  try {
    switch (cmd) {
      case "gen": {
        const prompt = rest.join(" ").trim();
        if (!prompt) {
          console.error('usage: pixfaro gen "<prompt>" [-m model] [-a 16:9] [-o file.png]');
          return 2;
        }
        const r = await client.generate({ model, prompt, aspect_ratio: aspect });
        return finish(r, out, force, fetchFn);
      }
      case "edit": {
        const [image, ...instr] = rest;
        const instruction = instr.join(" ").trim();
        if (!image || !instruction) {
          console.error('usage: pixfaro edit <img_id> "<instruction>" [-m model] [-o file.png]');
          return 2;
        }
        const r = await client.edit({ model, image, instruction, aspect_ratio: aspect });
        return finish(r, out, force, fetchFn);
      }
      case "models": {
        const models = await client.models();
        for (const m of models) {
          const status = m.enabled ? "" : "  [coming soon]";
          console.log(`${m.id.padEnd(20)} $${m.price}/img  ~${String(Math.round(m.p50_ms / 1000)).padStart(2)}s  ${m.best_for}${status}`);
        }
        return 0;
      }
      case "balance": {
        const { balance } = await client.balance();
        console.log(`$${balance}`);
        return 0;
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        console.log(HELP);
        return cmd === undefined ? 2 : 0;
      default:
        console.error(`unknown command: ${cmd}\n`);
        console.log(HELP);
        return 2;
    }
  } catch (e) {
    if (e instanceof PixfaroApiError) {
      console.error(`error (${e.code}): ${e.message}${e.requestId ? ` [${e.requestId}]` : ""}`);
      if (e.code === "insufficient_balance") {
        console.error(`balance $${String(e.extra.balance)}, needed $${String(e.extra.needed)} — top up: ${String(e.extra.topup_url)}`);
      }
    } else {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return 1;
  }
}

/* entrypoint wiring — exercised by the e2e smoke, not unit tests */
if (await isMain()) {
  process.exit(await main(process.argv.slice(2)));
}

async function isMain(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const { realpathSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}
