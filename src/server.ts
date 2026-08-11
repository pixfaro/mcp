#!/usr/bin/env node
/**
 * Pixfaro MCP server (stdio). Tools mirror docs/10: generate_image, edit_image,
 * list_models, get_balance. Responses are agent-readable text with the image
 * URL — never base64 into context (R2-first; agents fetch the URL if needed).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PixfaroApiError, PixfaroClient } from "./client.js";

const LOW_BALANCE_WARN = 0.5; // USD; appended to tool replies (docs/10)

export function buildServer(client: PixfaroClient): McpServer {
  const server = new McpServer({ name: "pixfaro", version: "0.1.0" });

  const fail = (e: unknown) => {
    const msg =
      e instanceof PixfaroApiError
        ? `${e.message}${e.code === "insufficient_balance" ? ` — top up at ${String(e.extra.topup_url ?? "https://pixfaro.com/topup")}` : ""}${e.requestId ? ` (request ${e.requestId})` : ""}`
        : String(e instanceof Error ? e.message : e);
    return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
  };

  const balanceLine = (after: string) =>
    Number(after) < LOW_BALANCE_WARN ? `\n⚠ Balance is low ($${after}) — top up at https://pixfaro.com/topup` : "";

  server.tool(
    "generate_image",
    "Generate an image from a text prompt. Returns a hosted image URL (valid long-term) plus cost and balance. Pick a model with list_models; nano-banana-2 is the general-purpose default.",
    {
      prompt: z.string().min(1).max(4000).describe("What to draw. Be specific about style, mood, and composition."),
      model: z.string().default("nano-banana-2").describe("Model id from list_models"),
      aspect_ratio: z.string().regex(/^[1-9]\d?:[1-9]\d?$/).default("1:1").describe('e.g. "1:1", "16:9", "9:16"'),
    },
    async ({ prompt, model, aspect_ratio }) => {
      try {
        const r = await client.generate({ model, prompt, aspect_ratio });
        return {
          content: [
            {
              type: "text" as const,
              text: `Image ready: ${r.url}\nid: ${r.id} · model: ${r.model} · ${(r.latency_ms / 1000).toFixed(1)}s · cost $${r.cost} · balance $${r.balance_after}${balanceLine(r.balance_after)}`,
            },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "edit_image",
    "Edit a previously generated image with a natural-language instruction (e.g. \"make the sky darker\", \"remove the text\"). Pass the img_… id returned by generate_image.",
    {
      image: z.string().regex(/^img_[0-9a-f]{20}$/).describe("The img_… id of a previous generation"),
      instruction: z.string().min(1).max(4000).describe("What to change; everything else stays the same"),
      model: z.string().default("nano-banana-2").describe("Model id from list_models"),
      aspect_ratio: z.string().regex(/^[1-9]\d?:[1-9]\d?$/).optional().describe('omit to keep the source image\'s shape; e.g. "16:9" to reshape'),
    },
    async ({ image, instruction, model, aspect_ratio }) => {
      try {
        const r = await client.edit({ model, image, instruction, aspect_ratio });
        return {
          content: [
            {
              type: "text" as const,
              text: `Edited image: ${r.url}\nid: ${r.id} · model: ${r.model} · ${(r.latency_ms / 1000).toFixed(1)}s · cost $${r.cost} · balance $${r.balance_after}${balanceLine(r.balance_after)}`,
            },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "list_models",
    "List available image models with pricing, latency, and what each is best for.",
    {},
    async () => {
      try {
        const models = await client.models();
        const lines = models
          .filter((m) => m.enabled)
          .map((m) => `- ${m.id} — $${m.price}/image, ~${(m.p50_ms / 1000).toFixed(0)}s. Best for: ${m.best_for}`);
        const disabled = models.filter((m) => !m.enabled).map((m) => m.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `${lines.join("\n")}${disabled.length ? `\n(coming soon: ${disabled.join(", ")})` : ""}`,
            },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool("get_balance", "Show the current prepaid balance in USD.", {}, async () => {
    try {
      const { balance } = await client.balance();
      return { content: [{ type: "text" as const, text: `Balance: $${balance}${balanceLine(balance)}` }] };
    } catch (e) {
      return fail(e);
    }
  });

  return server;
}

/* entrypoint wiring — exercised by the e2e smoke, not unit tests */
if (await isMain()) {
  const server = buildServer(new PixfaroClient());
  await server.connect(new StdioServerTransport());
}

async function isMain(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const { realpathSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  try {
    // npm bin shims are symlinks; compare against the resolved real path.
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}
