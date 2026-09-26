/**
 * Deploy Doctor — Vercel Adapter (LAPTOP 3)
 *
 * ╔══════════════════════════════════════════════════════════╗
 * ║  SKELETON — Laptop 3 fills in the implementation.       ║
 * ║  See LAPTOP3_INSTRUCTIONS.md for full build guide.      ║
 * ║  DO NOT modify files outside this adapter.              ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * API: https://vercel.com/docs/rest-api
 * Env required: VERCEL_TOKEN
 *
 * Key Vercel API endpoints:
 *   GET  https://api.vercel.com/v6/deployments            → list deployments
 *   GET  https://api.vercel.com/v2/deployments/{id}       → deployment details
 *   GET  https://api.vercel.com/v7/deployments/{id}/events → build logs
 *   POST https://api.vercel.com/v13/deployments            → create deployment (redeploy)
 *   GET  https://api.vercel.com/v9/projects/{id}/env       → env vars
 *   POST https://api.vercel.com/v10/projects/{id}/env      → create env var
 *   PATCH https://api.vercel.com/v9/projects/{id}/env/{envId} → update env var
 *
 * Common Vercel failure shapes:
 *   - Build errors (wrong Node version, missing deps, TypeScript errors)
 *   - Serverless function timeout (10s default on Hobby)
 *   - Env var misconfiguration (missing or wrong value)
 *   - Bad deploy (500 errors after deploy)
 *   - Edge function cold start failures
 */

import { BaseAdapter } from './base-adapter.js';
import { apiRequest } from '../utils/api-client.js';
import { getPrimaryFailure } from '../utils/log-parser.js';
import { classifyTier } from '../core/tier-classifier.js';
import { checkHealth as httpHealthCheck } from '../core/health-checker.js';
import type {
  Platform,
  Diagnosis,
  FixResult,
  HealthCheck,
  ToolDefinition,
} from '../types.js';

const VERCEL_API = 'https://api.vercel.com';

function getToken(): string {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN environment variable is not set');
  return token;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}` };
}

export class VercelAdapter extends BaseAdapter {
  readonly platform: Platform = 'vercel';
  readonly displayName = 'Vercel';

  async detectFailure(serviceId: string): Promise<Diagnosis> {
    // TODO: Laptop 3 implements this
    // serviceId = project name or project ID
    // 1. GET /v6/deployments?projectId={serviceId}&limit=5
    // 2. Check latest deployment state (READY, ERROR, BUILDING, QUEUED)
    // 3. If ERROR, fetch build logs: GET /v7/deployments/{deployId}/events
    // 4. Run getPrimaryFailure() on logs
    // 5. Return Diagnosis with correct tier
    throw new Error('Vercel adapter not yet implemented — assign to Laptop 3');
  }

  async getLogs(serviceId: string, lines?: number): Promise<string> {
    // TODO: Laptop 3 implements this
    // Fetch build events from latest deployment
    throw new Error('Vercel adapter not yet implemented — assign to Laptop 3');
  }

  async restart(serviceId: string): Promise<FixResult> {
    // TODO: Laptop 3 implements this
    // Vercel doesn't have "restart" — trigger a redeploy of the latest commit
    // POST /v13/deployments with the same git source
    throw new Error('Vercel adapter not yet implemented — assign to Laptop 3');
  }

  async rollback(serviceId: string, deploymentId: string): Promise<FixResult> {
    // TODO: Laptop 3 implements this
    // Promote a previous deployment to production
    throw new Error('Vercel adapter not yet implemented — assign to Laptop 3');
  }

  async applyFix(serviceId: string, fix: Record<string, unknown>): Promise<FixResult> {
    // TODO: Laptop 3 implements this
    // Handle fix types: env_var, redeploy
    throw new Error('Vercel adapter not yet implemented — assign to Laptop 3');
  }

  async checkHealth(url: string): Promise<HealthCheck> {
    return httpHealthCheck(url);
  }

  getTools(): ToolDefinition[] {
    // TODO: Laptop 3 — register tools following the same pattern as render.ts
    // MUST include:
    //   Diagnostic (readOnlyHint: true): vercel_detect_failure, vercel_get_build_logs,
    //                                     vercel_get_deployments, vercel_get_env_vars
    //   Tier 1 (destructiveHint: false):  vercel_trigger_redeploy
    //   Tier 2 (destructiveHint: true):   vercel_update_env_var, vercel_create_deployment
    return [];
  }
}
