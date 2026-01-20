# StreamShortcut

A lightweight Shortcut MCP for Claude Code. One tool, eight actions.

## Why?

The official `@shortcut/mcp` uses **~11,652 tokens** for tool definitions (52 tools).

StreamShortcut uses **~393 tokens** — a **96.6% reduction**.

## Design Philosophy

Instead of 52 separate tools, StreamShortcut has **one tool with action dispatch**:

```json
{"action": "search"}
{"action": "get", "id": "704"}
{"action": "update", "id": "704", "state": "Done"}
{"action": "comment", "id": "704", "body": "Fixed!"}
{"action": "create", "name": "New bug", "type": "bug"}
{"action": "epic", "id": "308"}
{"action": "api", "method": "GET", "path": "/workflows"}
{"action": "help"}
```

Based on [StreamLinear](https://github.com/obra/streamlinear) by Jesse Vincent.

## Actions

| Action | Purpose |
|--------|---------|
| `search` | Find stories (smart defaults: your active stories) |
| `get` | Story details by 704, sc-704, or URL |
| `update` | Change state, estimate, owner, type |
| `comment` | Add comment to story |
| `create` | Create new story |
| `epic` | Get epic with its stories |
| `api` | Raw REST API for anything else |
| `help` | Full documentation |

## Installation

Add to your MCP config:

```json
{
  "mcpServers": {
    "shortcut": {
      "command": "npx",
      "args": ["-y", "github:stayce/streamshortcut"],
      "env": {
        "SHORTCUT_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

Or clone and run locally:

```bash
git clone https://github.com/stayce/streamshortcut
cd streamshortcut
npm run build
SHORTCUT_API_TOKEN=xxx node mcp/dist/index.js
```

## Smart Defaults

- Workflow states shown in tool description (fetched at startup)
- `search` with no params → your assigned stories, not archived
- IDs accept 704, sc-704, or Shortcut URLs
- State names are fuzzy matched ("done" → "Done", "in prog" → "In Progress")
- `owner: "me"` uses the authenticated user
- Error messages show valid options when things fail

## The API Escape Valve

For anything not covered by the main actions, use raw REST:

```json
{
  "action": "api",
  "method": "GET",
  "path": "/workflows"
}

{
  "action": "api",
  "method": "POST",
  "path": "/stories/search",
  "query": {"epic_ids": [308]}
}
```

Use `{"action": "help"}` for full documentation.

## Token Comparison

| MCP | Tokens | Tools | Reduction |
|-----|--------|-------|-----------|
| @shortcut/mcp | ~11,652 | 52 | — |
| StreamShortcut | ~393 | 1 | **96.6%** |

## Related

- [streamshortcut-cloudflare](https://github.com/stayce/streamshortcut-cloudflare) - Cloudflare Workers version with remote MCP support

## Credits

Inspired by [MCPs Are Not Like Other APIs](https://blog.fsck.com/2025/10/19/mcps-are-not-like-other-apis/) and forked from [StreamLinear](https://github.com/obra/streamlinear).

## License

MIT
