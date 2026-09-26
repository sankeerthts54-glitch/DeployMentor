#!/usr/bin/env node
/**
 * Deploy Doctor — MCP Server Entry Point
 *
 * This is the main process that serves the MCP tools over HTTP/SSE.
 * Started by: npm start (or: npx tsx src/server.ts)
 */

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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

const app = express();
app.use(cors());

const server = new Server(
  {
    name: 'deploy-doctor',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Register tools
registerSharedTools();

if (process.env.RENDER_API_KEY) registerAdapter(new RenderAdapter());
if (process.env.HF_TOKEN) registerAdapter(new HfSpacesAdapter());
if (process.env.VERCEL_TOKEN) registerAdapter(new VercelAdapter());
if (process.env.GITHUB_TOKEN) registerAdapter(new GitHubPagesAdapter());

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = getAllTools();
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = getTool(name);

  if (!tool) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(args ?? {});
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[deploy-doctor] Tool ${name} error:`, message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// SSE endpoint
let transport: SSEServerTransport;

app.get('/mcp', async (req, res) => {
  transport = new SSEServerTransport('/mcp/message', res);
  await server.connect(transport);
});

app.post('/mcp/message', express.json(), async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(500).send('SSE not initialized');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[deploy-doctor] MCP server running on http://localhost:${PORT}/mcp`);
  console.log(`[deploy-doctor] ${getAllTools().length} tools registered`);
});
