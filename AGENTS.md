# mcp-fantastical

## What it is

An MCP server that bridges Fantastical (macOS calendar app by Flexibits) to Claude and other MCP clients. It wraps Fantastical's native MCP binary and URL scheme to expose calendar read/write as standard MCP tools.

## Where it's used

- Local MCP host only (Claude Desktop or Claude Code via `~/.claude.json`)
- macOS only; not deployed in the cluster
- No auth, no API key; works with the local Fantastical installation

## MCP surface

| Tool | What it does |
|------|-------------|
| `fantastical_create_event` | Create event via natural language ("Lunch tomorrow at noon") |
| `fantastical_get_today` | Return today's events |
| `fantastical_get_upcoming` | Return events over N days (default 7) |
| `fantastical_show_date` | Open Fantastical to a specific date |
| `fantastical_get_calendars` | List all available calendars with IDs |
| `fantastical_search` | Search events by title, location, or notes |

## How it works

Two integration paths run side-by-side:

1. **Flexibits native MCP binary** (primary for reads and programmatic creates): `callFlexibitsTool()` spawns `FantasticalMCP.app/Contents/MacOS/FantasticalMCP` as a subprocess, sends JSON-RPC over stdio (`initialize` then `tools/call`), and parses the response. Path defaults to `~/Library/Application Support/Claude/Claude Extensions/.../FantasticalMCP`; override via `FLEXIBITS_MCP_PATH` env var.

2. **`x-fantastical3://` URL scheme** (used for event creation when `addImmediately=false` or notes are present): calls `/usr/bin/open` with the URL to launch Fantastical's natural-language parse dialog.

The Swift helper (`native/FantasticalHelper.swift`, compiled to `dist/native/fantastical-helper`) was added to work around macOS TCC calendar permission errors that occur when AppleScript runs in a subprocess context. It uses EventKit directly and avoids the `-1743` permission denial that AppleScript hits.

## Code map

```
src/index.ts                  # Server entry, all tool definitions and handlers
native/
  FantasticalHelper.swift     # Swift EventKit helper (TCC workaround)
  build.sh                    # Compiles helper with swiftc + EventKit framework
dist/
  index.js                    # Compiled server
  native/fantastical-helper   # Compiled Swift binary
```

## Config / run

**Install (npm):**
```bash
npx mcp-fantastical
```

**Build from source:**
```bash
npm install
npm run build   # tsc + swiftc (requires Xcode CLI tools)
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "fantastical": {
      "command": "npx",
      "args": ["-y", "mcp-fantastical"]
    }
  }
}
```

**Env vars:**
- `FLEXIBITS_MCP_PATH` - override path to the Flexibits native binary
- `EXCLUDED_CALENDARS` - comma-separated calendar names to hide from all responses

## Gotchas

- macOS Sonoma+ TCC blocks AppleScript calendar access in subprocess contexts (MCP server spawned by Claude). The Swift EventKit helper (`dist/native/fantastical-helper`) resolves this; rebuild with `npm run build:native` if the binary is missing.
- The Flexibits native MCP binary must be present (installed by Fantastical). The path is hardcoded to the Claude Extensions dir; set `FLEXIBITS_MCP_PATH` if yours differs.
- Calendar name resolution supports fuzzy matching (case-insensitive, `source/name` qualified). Ambiguous names return an error listing valid IDs.
- `fantastical_show_date` only opens the UI; it does not return event data.
- Requires Accessibility permissions for `osascript` (System Settings > Privacy & Security > Accessibility).
