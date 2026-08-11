#!/usr/bin/env node
/**
 * E2E smoke — NOT part of the vitest suite (live network, spends ~$0.12).
 * Drives the built MCP server over real stdio with the official client,
 * against the env in PIXFARO_API_URL/PIXFARO_KEY (staging in practice).
 *
 *   node test/e2e-smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.PIXFARO_KEY || !process.env.PIXFARO_API_URL) {
  console.error("set PIXFARO_KEY and PIXFARO_API_URL (this smoke is meant for staging)");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  env: { ...process.env },
});
const client = new Client({ name: "pixfaro-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
if (JSON.stringify(names) !== JSON.stringify(["edit_image", "generate_image", "get_balance", "list_models"])) {
  console.error("FAIL: unexpected tool set");
  process.exit(1);
}

const models = await client.callTool({ name: "list_models", arguments: {} });
console.log("\nlist_models →\n" + models.content[0].text);

const gen = await client.callTool({
  name: "generate_image",
  arguments: { prompt: "a lighthouse beam sweeping over a calm sea, minimal flat illustration", aspect_ratio: "16:9" },
});
console.log("\ngenerate_image →\n" + gen.content[0].text);
if (gen.isError) process.exit(1);

const imgId = /id: (img_[0-9a-f]{20})/.exec(gen.content[0].text)?.[1];
if (!imgId) {
  console.error("FAIL: no img id in reply");
  process.exit(1);
}

const edit = await client.callTool({
  name: "edit_image",
  arguments: { image: imgId, instruction: "make it a night scene with stars" },
});
console.log("\nedit_image →\n" + edit.content[0].text);
if (edit.isError) process.exit(1);

const bal = await client.callTool({ name: "get_balance", arguments: {} });
console.log("\nget_balance →\n" + bal.content[0].text);

await client.close();
console.log("\nSMOKE OK");
