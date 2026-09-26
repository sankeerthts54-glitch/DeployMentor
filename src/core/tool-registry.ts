/**
 * Deploy Doctor — Tool Registry
 *
 * Collects tools from all platform adapters and registers them
 * with the MCP server. Handles the tools/list and tools/call dispatch.
 *
 * DO NOT MODIFY THIS FILE unless you are Laptop 1 (core).
 */

import type { ToolDefinition } from '../types.js';
import { classifyTier, getTierExplanation } from './tier-classifier.js';
import { checkHealth } from './health-checker.js';
import type { BaseAdapter } from '../adapters/base-adapter.js';

// ── Global tool registry ──────────────────────────────────

const tools = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  if (tools.has(tool.name)) {
    throw new Error(`Tool "${tool.name}" is already registered`);
  }
  tools.set(tool.name, tool);
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(tools.values());
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

// ── Register shared tools (platform-independent) ─────────

export function registerSharedTools(): void {
  registerTool({
    name: 'classify_tier',
    description:
      'Given a failure type string, returns the remediation tier (1=auto-fix, 2=approval-required, 3=report-only) ' +
      'and a human-readable explanation of what that tier means.',
    inputSchema: {
      type: 'object',
      properties: {
        failure_type: {
          type: 'string',
          description: 'The failure type to classify (e.g. "crash_loop", "build_failure", "quota_exceeded")',
        },
      },
      required: ['failure_type'],
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const failureType = args.failure_type as string;
      const tier = classifyTier(failureType as any);
      const explanation = getTierExplanation(tier);
      return JSON.stringify({ tier, explanation, failure_type: failureType });
    },
  });

  registerTool({
    name: 'check_health',
    description:
      'HTTP health probe: sends a GET request to a URL and reports status code, response time, and whether it is healthy.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to probe' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 10000)' },
      },
      required: ['url'],
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const result = await checkHealth(args.url as string, (args.timeout_ms as number) || 10000);
      return JSON.stringify(result);
    },
  });
}

// ── Register all tools from an adapter ────────────────────

export function registerAdapter(adapter: BaseAdapter): void {
  const adapterTools = adapter.getTools();
  for (const tool of adapterTools) {
    registerTool(tool);
  }
  console.error(`[deploy-doctor] Registered ${adapterTools.length} tools from ${adapter.displayName}`);
}
