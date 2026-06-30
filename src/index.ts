#!/usr/bin/env node
/**
 * MCP Server for Fantastical Calendar
 *
 * Provides calendar management through Fantastical's AppleScript interface.
 * Leverages Fantastical's powerful natural language parsing for event creation.
 *
 * Requirements:
 * - macOS only
 * - Fantastical installed
 * - Accessibility permissions for osascript
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const FLEXIBITS_MCP_PATH = process.env.FLEXIBITS_MCP_PATH ||
  "/Users/danb/Library/Application Support/Claude/Claude Extensions/ant.dir.gh.flexibits.fantastical-mcp/server/FantasticalMCP.app/Contents/MacOS/FantasticalMCP";

const EXCLUDED_CALENDARS: Set<string> = new Set(
  (process.env.EXCLUDED_CALENDARS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

function isCalendarExcluded(name: string): boolean {
  return EXCLUDED_CALENDARS.has(name);
}

type FlexibitsContent = { type: string; text?: string };
type FlexibitsResult = { content?: FlexibitsContent[]; isError?: boolean };

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function callFlexibitsTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(FLEXIBITS_MCP_PATH, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let buffer = "";
    let stderr = "";
    let nextId = 1;
    let toolCallId = 0;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Flexibits Fantastical MCP timed out calling ${name}`));
    }, 10000);

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const finish = (callback: () => void) => {
      clearTimeout(timeout);
      child.kill();
      callback();
    };

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) {
          continue;
        }

        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          toolCallId = ++nextId;
          send({
            jsonrpc: "2.0",
            id: toolCallId,
            method: "tools/call",
            params: { name, arguments: args },
          });
          continue;
        }

        if (message.id === toolCallId) {
          if (message.error) {
            finish(() => reject(new Error(message.error.message || JSON.stringify(message.error))));
            return;
          }

          const result = message.result as FlexibitsResult;
          if (result?.isError) {
            const text = result.content?.map((item) => item.text).filter(Boolean).join("\n");
            finish(() => reject(new Error(text || `Flexibits Fantastical MCP returned an error for ${name}`)));
            return;
          }

          const text = result?.content?.find((item) => item.type === "text")?.text;
          if (!text) {
            finish(() => resolve(result));
            return;
          }

          try {
            finish(() => resolve(JSON.parse(text)));
          } catch {
            finish(() => resolve(text));
          }
        }
      }
    });

    child.on("close", (code) => {
      if (toolCallId === 0 && code !== null && code !== 0) {
        finish(() => reject(new Error(stderr || `Flexibits Fantastical MCP exited with code ${code}`)));
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-fantastical-bridge", version: "1.0.0" },
      },
    });
  });
}

async function getFlexibitsCalendarMap(): Promise<Map<string, string>> {
  const calendars = await callFlexibitsTool("queryCalendars");
  const rows = Array.isArray(calendars) ? calendars : [];
  return new Map(
    rows
      .filter((calendar: any) => calendar?.id && calendar?.title)
      .map((calendar: any) => [calendar.id, calendar.title])
  );
}

async function getFlexibitsEvents(when: string, query = "") {
  const [calendarMap, rawEvents] = await Promise.all([
    getFlexibitsCalendarMap(),
    callFlexibitsTool("queryCalendarItems", query ? { query, when } : { when }),
  ]);

  const items = Array.isArray((rawEvents as any)?.items) ? (rawEvents as any).items : [];
  return items
    .map((item: any) => {
      const calendar = calendarMap.get(item.calendarId) || item.calendarId || "";
      return {
        calendar,
        title: item.title || "",
        start: item.startDate || "",
        end: item.endDate || "",
        location: item.location || "",
      };
    })
    .filter((item: { calendar: string }) => !isCalendarExcluded(item.calendar))
    .sort((a: { start: string }, b: { start: string }) => a.start.localeCompare(b.start));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function openUrl(url: string): Promise<void> {
  await execAsync(`/usr/bin/open ${shellQuote(url)}`);
}

// Helper to run AppleScript
async function runAppleScript(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    if (stderr && !stdout) {
      throw new Error(stderr);
    }
    return stdout.trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`AppleScript error: ${error.message}`);
    }
    throw error;
  }
}

// Helper to run multi-line AppleScript
async function runAppleScriptMultiline(script: string): Promise<string> {
  try {
    // Write script to temp file and execute
    const escapedScript = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const { stdout, stderr } = await execAsync(`osascript -e "${escapedScript}"`);
    if (stderr && !stdout) {
      throw new Error(stderr);
    }
    return stdout.trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`AppleScript error: ${error.message}`);
    }
    throw error;
  }
}

// Check if Fantastical is installed
async function checkFantasticalInstalled(): Promise<boolean> {
  try {
    await runAppleScript('tell application "System Events" to return exists (processes where name is "Fantastical")');
    return true;
  } catch {
    return false;
  }
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "fantastical_create_event",
    description: "Create a calendar event using Fantastical's natural language parsing. Examples: 'Meeting with John tomorrow at 3pm', 'Dentist appointment Friday 10am', 'Call with team every Monday at 9am'",
    inputSchema: {
      type: "object" as const,
      properties: {
        sentence: {
          type: "string",
          description: "Natural language description of the event (e.g., 'Lunch with Sarah tomorrow at noon')",
        },
        calendar: {
          type: "string",
          description: "Optional: Target calendar name (e.g., 'Work', 'Personal')",
        },
        notes: {
          type: "string",
          description: "Optional: Additional notes for the event",
        },
        addImmediately: {
          type: "boolean",
          description: "Add immediately without showing Fantastical UI (default: true)",
        },
      },
      required: ["sentence"],
    },
  },
  {
    name: "fantastical_get_today",
    description: "Get today's calendar events from Fantastical",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fantastical_get_upcoming",
    description: "Get upcoming calendar events from Fantastical",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description: "Number of days to look ahead (default: 7)",
        },
      },
      required: [],
    },
  },
  {
    name: "fantastical_show_date",
    description: "Open Fantastical and navigate to a specific date",
    inputSchema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description: "Date to show (e.g., '2025-01-15', 'tomorrow', 'next monday')",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "fantastical_get_calendars",
    description: "List all available calendars in Fantastical",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fantastical_search",
    description: "Search for events by text in Fantastical",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (event title, location, or notes)",
        },
      },
      required: ["query"],
    },
  },
];

// Create server instance
const server = new Server(
  {
    name: "mcp-fantastical",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "fantastical_create_event": {
        const { sentence, calendar, notes, addImmediately = true } = args as {
          sentence: string;
          calendar?: string;
          notes?: string;
          addImmediately?: boolean;
        };

        // Build URL with parameters
        const params = new URLSearchParams();
        params.append("s", sentence);
        if (addImmediately) {
          params.append("add", "1");
        }
        if (calendar) {
          params.append("calendarName", calendar);
        }
        if (notes) {
          params.append("n", notes);
        }

        const url = `x-fantastical3://parse?${params.toString()}`;
        await openUrl(url);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Event created: "${sentence}"`,
              calendar: calendar || "default",
              addedImmediately: addImmediately,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_today": {
        const today = localDateString(new Date());
        const events = await getFlexibitsEvents(today);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              date: today,
              count: events.length,
              events,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_upcoming": {
        const { days = 7 } = args as { days?: number };
        const today = new Date();
        const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
        const start = localDateString(today);
        const end = localDateString(endDate);
        const events = await getFlexibitsEvents(`from ${start} to ${end}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              range: {
                start,
                end,
                days,
              },
              count: events.length,
              events,
            }, null, 2),
          }],
        };
      }

      case "fantastical_show_date": {
        const { date } = args as { date: string };

        await openUrl(`x-fantastical3://show/calendar/${encodeURIComponent(date)}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Opened Fantastical to date: ${date}`,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_calendars": {
        const result = await callFlexibitsTool("queryCalendars");
        const calendars = (Array.isArray(result) ? result : [])
          .filter((calendar: any) => calendar?.title && !isCalendarExcluded(calendar.title))
          .map((calendar: any) => ({
            name: calendar.title,
            id: calendar.id,
            sourceName: calendar.sourceName,
            isWritable: calendar.isWritable,
            supportsEvents: calendar.supportsEvents,
            supportsTasks: calendar.supportsTasks,
          }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: calendars.length,
              calendars,
            }, null, 2),
          }],
        };
      }

      case "fantastical_search": {
        const { query } = args as { query: string };
        const events = await getFlexibitsEvents("today through 1 year from today", query);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              count: events.length,
              events,
            }, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  // Check if on macOS
  if (process.platform !== "darwin") {
    console.error("Error: This MCP server only works on macOS (Fantastical is macOS-only)");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fantastical MCP server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
