/**
 * Deploy Doctor — Hugging Face Spaces Adapter (LAPTOP 2)
 *
 * ╔══════════════════════════════════════════════════════════╗
 * ║  SKELETON — Laptop 2 fills in the implementation.       ║
 * ║  See LAPTOP2_INSTRUCTIONS.md for full build guide.      ║
 * ║  DO NOT modify files outside this adapter.              ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * API: https://huggingface.co/docs/hub/api
 * Env required: HF_TOKEN
 *
 * Key HF API endpoints:
 *   GET  https://huggingface.co/api/spaces/{owner}/{repo}          → space info + status
 *   GET  https://huggingface.co/api/spaces/{owner}/{repo}/runtime   → runtime status (stage, hardware)
 *   POST https://huggingface.co/api/spaces/{owner}/{repo}/restart   → restart space
 *   GET  build/runtime logs via Space runtime API
 *
 * Common HF Spaces failure shapes:
 *   - Space sleeping (needs wake/restart)
 *   - Quota exhaustion on external APIs (Spotify, TMDB, Gemini)
 *   - Stale dependencies in requirements.txt
 *   - Build failure from bad requirements
 *   - OOM on free-tier hardware
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

const HF_API = 'https://huggingface.co/api';

function getToken(): string {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error('HF_TOKEN environment variable is not set');
  return token;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}` };
}

export class HfSpacesAdapter extends BaseAdapter {
  readonly platform: Platform = 'hf-spaces';
  readonly displayName = 'Hugging Face Spaces';

  async detectFailure(serviceId: string): Promise<Diagnosis> {
    // TODO: Laptop 2 implements this
    // serviceId format: "owner/repo-name"
    // 1. GET /api/spaces/{serviceId} → check runtime.stage
    // 2. GET /api/spaces/{serviceId}/runtime → get detailed status
    // 3. Fetch logs and run getPrimaryFailure()
    // 4. Return Diagnosis with correct tier
    throw new Error('HF Spaces adapter not yet implemented — assign to Laptop 2');
  }

  async getLogs(serviceId: string, lines?: number): Promise<string> {
    // TODO: Laptop 2 implements this
    // Fetch build + runtime logs from HF API
    throw new Error('HF Spaces adapter not yet implemented — assign to Laptop 2');
  }

  async restart(serviceId: string): Promise<FixResult> {
    // TODO: Laptop 2 implements this
    // POST /api/spaces/{serviceId}/restart
    throw new Error('HF Spaces adapter not yet implemented — assign to Laptop 2');
  }

  async rollback(serviceId: string, deploymentId: string): Promise<FixResult> {
    // TODO: Laptop 2 implements this
    // HF doesn't have a native rollback — may need to redeploy from a prior commit
    throw new Error('HF Spaces adapter not yet implemented — assign to Laptop 2');
  }

  async applyFix(serviceId: string, fix: Record<string, unknown>): Promise<FixResult> {
    // TODO: Laptop 2 implements this
    // Handle fix types: update_requirements, update_secrets, redeploy
    throw new Error('HF Spaces adapter not yet implemented — assign to Laptop 2');
  }

  async checkHealth(url: string): Promise<HealthCheck> {
    return httpHealthCheck(url);
  }

  getTools(): ToolDefinition[] {
    // TODO: Laptop 2 — register tools following the same pattern as render.ts
    // MUST include:
    //   Diagnostic (readOnlyHint: true): hf_detect_failure, hf_get_logs, hf_get_space_status
    //   Tier 1 (destructiveHint: false):  hf_restart_space
    //   Tier 2 (destructiveHint: true):   hf_update_requirements, hf_redeploy
    return [];
  }
}
