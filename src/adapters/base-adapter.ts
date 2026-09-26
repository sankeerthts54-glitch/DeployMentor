/**
 * Deploy Doctor — Base Platform Adapter
 *
 * Every platform adapter (Render, Vercel, HF Spaces, GitHub Pages)
 * extends this abstract class and implements the required methods.
 *
 * RULES FOR ADAPTER AUTHORS:
 * 1. ONLY touch files inside src/adapters/<your-platform>.ts
 * 2. Import shared types from ../types.ts — do NOT modify types.ts
 * 3. Register your tools in getTools() with correct annotations
 * 4. Test against YOUR OWN real deployment, using YOUR OWN API key
 */

import type {
  Platform,
  Diagnosis,
  FixResult,
  HealthCheck,
  ToolDefinition,
} from '../types.js';

export abstract class BaseAdapter {
  abstract readonly platform: Platform;
  abstract readonly displayName: string;

  // ── Diagnostic (read-only) ────────────────────────────

  /** Check if the service is healthy, degraded, or down */
  abstract detectFailure(serviceId: string): Promise<Diagnosis>;

  /** Fetch recent logs (build or runtime) */
  abstract getLogs(serviceId: string, lines?: number): Promise<string>;

  // ── Tier 1 Actions (write, NOT destructive) ───────────

  /** Restart the service / process / container */
  abstract restart(serviceId: string): Promise<FixResult>;

  /** Roll back to a previous known-good deployment */
  abstract rollback(serviceId: string, deploymentId: string): Promise<FixResult>;

  // ── Tier 2 Actions (destructive — approval required) ──

  /** Apply a fix (env change, config update, dependency bump, code patch) */
  abstract applyFix(serviceId: string, fix: Record<string, unknown>): Promise<FixResult>;

  // ── Verification ──────────────────────────────────────

  /** Hit the live URL and verify it responds */
  abstract checkHealth(url: string): Promise<HealthCheck>;

  // ── Tool Registration ─────────────────────────────────

  /** Return all MCP tools this adapter provides, with correct annotations */
  abstract getTools(): ToolDefinition[];
}
