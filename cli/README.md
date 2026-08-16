# pixfaro — image generation CLI for every image model

Generate images from your terminal, scripts, or CI with any major model —
Nano Banana, Gemini, GPT Image and more. One API key, one prepaid balance,
no subscription; Pixfaro holds the provider accounts and keys.

```bash
export PIXFARO_KEY=pf_live_…   # get one at https://pixfaro.com

npx pixfaro gen "a lighthouse at night, minimal flat style" -a 16:9 -o cover.png
npx pixfaro models
npx pixfaro balance
npx pixfaro edit img_8f2a… "make the sky darker" -o v2.png
```

This package is a thin alias for the CLI that ships in
[`@pixfaro/mcp`](https://www.npmjs.com/package/@pixfaro/mcp) — the same repo
also contains the Pixfaro MCP server for Claude Desktop, Claude Code, Cursor,
Windsurf, and any MCP client.

- Repo: [github.com/pixfaro/mcp](https://github.com/pixfaro/mcp)
- Docs: [pixfaro.com](https://pixfaro.com)

MIT © Pixfaro
