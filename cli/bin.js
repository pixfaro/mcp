#!/usr/bin/env node
// Thin alias so `npx pixfaro …` works: the real CLI lives in @pixfaro/mcp
// (one shared HTTP client for the MCP server and the CLI — see the repo root).
// cli.js's own entrypoint only fires when it IS argv[1], so call main() here.
import { main } from "@pixfaro/mcp/cli";

process.exit(await main(process.argv.slice(2)));
