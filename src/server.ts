#!/usr/bin/env node
/**
 * Deploy Doctor — MCP Server Entry Point
 *
 * This is the main process that TrueForge connects to via stdio.
 * It registers all platform adapters and serves MCP tool calls.
 *
 * Started by TrueForge as: node dist/server.js (or: npx tsx src/server.ts)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

// ── Import all adapters ──────────────────────────────────
import { RenderAdapter } from './adapters/render.js';
import { HfSpacesAdapter } from './adapters/hf-spaces.js';
import { VercelAdapter } from './adapters/vercel.js';
import { GitHubPagesAdapter } from './adapters/github-pages.js';

// ── Create MCP server ────────────────────────────────────

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

// ── Register tools ───────────────────────────────────────

// Shared tools (tier classifier, health checker)
registerSharedTools();

// Platform adapters — each registers its own tools
// Only register adapters whose env vars are present
if (process.env.RENDER_API_KEY) {
  registerAdapter(new RenderAdapter());
} else {
  console.error('[deploy-doctor] Skipping Render adapter (RENDER_API_KEY not set)');
}

if (process.env.HF_TOKEN) {
  registerAdapter(new HfSpacesAdapter());
} else {
  console.error('[deploy-doctor] Skipping HF Spaces adapter (HF_TOKEN not set)');
}

if (process.env.VERCEL_TOKEN) {
  registerAdapter(new VercelAdapter());
} else {
  console.error('[deploy-doctor] Skipping Vercel adapter (VERCEL_TOKEN not set)');
}

if (process.env.GITHUB_TOKEN) {
  registerAdapter(new GitHubPagesAdapter());
} else {
  console.error('[deploy-doctor] Skipping GitHub Pages adapter (GITHUB_TOKEN not set)');
}

// ── Handle tools/list ────────────────────────────────────

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

// ── Handle tools/call ────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = getTool(name);

  if (!tool) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(args ?? {});
    return {
      content: [{ type: 'text' as const, text: result }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[deploy-doctor] Tool ${name} error:`, message);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: message }),
        },
      ],
      isError: true,
    };
  }
});

// ── Start server ─────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[deploy-doctor] MCP server running on stdio');
  console.error(`[deploy-doctor] ${getAllTools().length} tools registered`);
}

main().catch((err) => {
  console.error('[deploy-doctor] Fatal error:', err);
  process.exit(1);
});
