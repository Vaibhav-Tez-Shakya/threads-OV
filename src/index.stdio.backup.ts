import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createThread,
  getThread,
  listThreads,
  saveMessage,
  testDatabaseConnection,
} from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

const server = new McpServer({
  name: "threads-ov",
  version: "0.1.0",
});

server.registerTool(
  "health_check",
  {
    title: "Health Check",
    description: "Checks whether the Threads-OV MCP server is running.",
    inputSchema: {},
  },
  async () => {
    return {
      content: [
        {
          type: "text",
          text: "Threads-OV MCP server is running.",
        },
      ],
    };
  },
);

server.registerTool(
  "create_thread",
  {
    title: "Create Thread",
    description: "Creates a new saved conversation thread.",
    inputSchema: {
      title: z.string().optional().describe("Optional title for the thread."),
    },
  },
  async ({ title }) => {
    const thread = await createThread(randomUUID(), title);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(thread, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "save_message",
  {
    title: "Save Message",
    description: "Saves a message to an existing thread.",
    inputSchema: {
      thread_id: z.string().describe("UUID of the thread."),
      role: z.string().describe("Message role, such as user or assistant."),
      content: z.string().describe("The message content."),
    },
  },
  async ({ thread_id, role, content }) => {
    const message = await saveMessage(
      randomUUID(),
      thread_id,
      role,
      content,
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(message, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "get_thread",
  {
    title: "Get Thread",
    description: "Retrieves a thread and all of its messages.",
    inputSchema: {
      thread_id: z.string().describe("UUID of the thread."),
    },
  },
  async ({ thread_id }) => {
    const result = await getThread(thread_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "list_threads",
  {
    title: "List Threads",
    description: "Lists all saved conversation threads.",
    inputSchema: {},
  },
  async () => {
    const threads = await listThreads();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(threads, null, 2),
        },
      ],
    };
  },
);

await testDatabaseConnection();

const transport = new StdioServerTransport();

await server.connect(transport);
