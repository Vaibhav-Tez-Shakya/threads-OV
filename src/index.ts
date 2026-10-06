import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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

function createMcpServer() {
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
    async () => ({
      content: [
        {
          type: "text",
          text: "Threads-OV MCP server is running.",
        },
      ],
    }),
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

  return server;
}

async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

async function startHttp() {
  const host = process.env.MCP_HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? process.env.MCP_PORT ?? "3000");

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? `${host}:${port}`}`,
      );

      if (url.pathname !== "/mcp") {
        res.writeHead(404, {
          "Content-Type": "text/plain",
        });
        res.end("Not Found");
        return;
      }

      if (req.method === "POST") {
        let body = "";

        req.setEncoding("utf8");

        for await (const chunk of req) {
          body += chunk;
        }

        let parsedBody: unknown;

        if (body.length > 0) {
          parsedBody = JSON.parse(body);
        }

        const sessionId = req.headers["mcp-session-id"];

        if (typeof sessionId === "string") {
          const transport = transports.get(sessionId);

          if (!transport) {
            res.writeHead(404, {
              "Content-Type": "text/plain",
            });
            res.end("Session not found");
            return;
          }

          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        transport.onclose = () => {
          const id = transport.sessionId;

          if (id) {
            transports.delete(id);
          }
        };

        const server = createMcpServer();

        await server.connect(transport);

        await transport.handleRequest(req, res, parsedBody);

        const id = transport.sessionId;

        if (id) {
          transports.set(id, transport);
        }

        return;
      }

      if (req.method === "GET") {
        const sessionId = req.headers["mcp-session-id"];

        if (typeof sessionId !== "string") {
          res.writeHead(400, {
            "Content-Type": "text/plain",
          });
          res.end("Missing MCP session ID");
          return;
        }

        const transport = transports.get(sessionId);

        if (!transport) {
          res.writeHead(404, {
            "Content-Type": "text/plain",
          });
          res.end("Session not found");
          return;
        }

        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, {
        "Content-Type": "text/plain",
        Allow: "GET, POST",
      });
      res.end("Method Not Allowed");
    } catch (error) {
      console.error("MCP HTTP error:", error);

      if (!res.headersSent) {
        res.writeHead(500, {
          "Content-Type": "text/plain",
        });
      }

      if (!res.writableEnded) {
        res.end("Internal Server Error");
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);

    httpServer.listen(port, host, () => {
      console.error(
        `Threads-OV MCP HTTP server listening at http://${host}:${port}/mcp`,
      );
      resolve();
    });
  });
}

await testDatabaseConnection();

if (process.env.MCP_TRANSPORT === "http") {
  await startHttp();
} else {
  await startStdio();
}


