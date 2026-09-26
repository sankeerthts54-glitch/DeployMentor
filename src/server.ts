#!/usr/bin/env node
/**
 * Deploy Doctor — MCP Server Entry Point
 * Uses StreamableHTTPServerTransport (modern MCP standard, supported by TrueForge)
 */

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

import {
  registerSharedTools,
  registerAdapter,
  getAllTools,
  getTool,
} from './core/tool-registry.js';

import { RenderAdapter } from './adapters/render.js';
import { HfSpacesAdapter } from './adapters/hf-spaces.js';
import { VercelAdapter } from './adapters/vercel.js';
import { GitHubPagesAdapter } from './adapters/github-pages.js';

// ── Register tools ───────────────────────────────────────
registerSharedTools();

if (process.env.RENDER_API_KEY) {
  registerAdapter(new RenderAdapter());
  console.error('[deploy-doctor] Render adapter registered');
}
if (process.env.HF_TOKEN) {
  registerAdapter(new HfSpacesAdapter());
  console.error('[deploy-doctor] HF Spaces adapter registered');
}
if (process.env.VERCEL_TOKEN) {
  registerAdapter(new VercelAdapter());
  console.error('[deploy-doctor] Vercel adapter registered');
}
if (process.env.GITHUB_TOKEN) {
  registerAdapter(new GitHubPagesAdapter());
  console.error('[deploy-doctor] GitHub Pages adapter registered');
}

// ── Express app ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Map of sessionId → transport (for stateful connections)
const transports = new Map<string, StreamableHTTPServerTransport>();

function createMcpServer(): Server {
  const server = new Server(
    { name: 'deploy-doctor', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = getTool(name);

    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args ?? {});
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[deploy-doctor] Tool ${name} error:`, message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

// ── MCP endpoint ─────────────────────────────────────────
app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport for this session
      transport = transports.get(sessionId)!;
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      // New session initialization
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => Math.random().toString(36).slice(2),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({ error: 'Bad request: missing or invalid session' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[deploy-doctor] MCP error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ── Health check ─────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'deploy-doctor',
    status: 'running',
    tools: getAllTools().length,
    mcp_endpoint: '/mcp',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.error(`[deploy-doctor] MCP server running on http://localhost:${PORT}/mcp`);
  console.error(`[deploy-doctor] ${getAllTools().length} tools registered`);
});
