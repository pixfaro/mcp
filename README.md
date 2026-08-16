# Pixfaro MCP — image generation MCP server for every image model

One MCP connection, one prepaid balance, every major image model — Nano Banana,
Gemini, GPT Image and more. Pixfaro holds the provider accounts, keys, retries
and format differences; your agent just asks for an image.

Works with **Claude Desktop, Claude Code, Cursor, Windsurf**, and any MCP client.

## Quickstart (≈1 minute)

1. Get an API key at [pixfaro.com](https://pixfaro.com) and top up (no subscription).
2. Add the server to your MCP client config:

```json
{
  "mcpServers": {
    "pixfaro": {
      "command": "npx",
      "args": ["-y", "@pixfaro/mcp"],
      "env": { "PIXFARO_KEY": "pf_live_…" }
    }
  }
}
```

3. Ask your agent for an image. That's it.

For Claude Code:

```bash
claude mcp add pixfaro -e PIXFARO_KEY=pf_live_… -- npx -y @pixfaro/mcp
```

### Remote server (no install, OAuth)

On claude.ai, Claude Desktop, or any client that speaks streamable HTTP, add the
remote server instead — no npm, no key in a config file:

```
https://mcp.pixfaro.com/mcp
```

The client runs the OAuth flow; you sign in with your Pixfaro account.

## Tools

| Tool | What it does |
|---|---|
| `generate_image` | prompt → hosted image URL (+cost and balance in the reply) |
| `edit_image` | natural-language edit of a previous generation by its `img_…` id |
| `list_models` | models with price, latency, and what each is best for |
| `get_balance` | current prepaid balance |

Replies carry a hosted URL, never base64 — your agent's context stays small.

## CLI

The same package family ships an unscoped CLI for scripts, CI, and pipelines:

```bash
export PIXFARO_KEY=pf_live_…
npx pixfaro gen "a lighthouse at night, minimal flat style" -a 16:9 -o cover.png
npx pixfaro models
npx pixfaro balance
npx pixfaro edit img_8f2a… "make the sky darker" -o v2.png
```

## Environment

| Variable | Meaning |
|---|---|
| `PIXFARO_KEY` | your API key (`pf_live_…`) — required for generation |
| `PIXFARO_API_URL` | endpoint override (default `https://api.pixfaro.com`) |

## What this repo is

The thin open client over the Pixfaro API: the MCP server (`@pixfaro/mcp`) and
the `pixfaro` CLI share one HTTP client. The balance/provider layer lives
behind [api.pixfaro.com](https://pixfaro.com) — this code is intentionally
small enough to read before you hand it a key.

MIT © Pixfaro
