/**
 * Deploy Doctor — Render Adapter (LAPTOP 1)
 *
 * Full implementation. Talks to the Render REST API.
 * API Docs: https://api-docs.render.com/reference/introduction
 *
 * Env required: RENDER_API_KEY
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

const RENDER_API = 'https://api.render.com/v1';

function getApiKey(): string {
  const key = process.env.RENDER_API_KEY;
  if (!key) throw new Error('RENDER_API_KEY environment variable is not set');
  return key;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getApiKey()}` };
}

// ── Render API response types ─────────────────────────────

interface RenderService {
  id: string;
  name: string;
  type: string;
  slug: string;
  suspended: string;
  serviceDetails?: {
    url?: string;
    buildCommand?: string;
    startCommand?: string;
    healthCheckPath?: string;
    envSpecificDetails?: {
      dockerCommand?: string;
    };
  };
}

interface RenderDeploy {
  id: string;
  status: string;
  commit?: { id: string; message: string };
  createdAt: string;
  finishedAt?: string;
}

export class RenderAdapter extends BaseAdapter {
  readonly platform: Platform = 'render';
  readonly displayName = 'Render';

  // ── Diagnostic ────────────────────────────────────────

  async detectFailure(serviceId: string): Promise<Diagnosis> {
    // 1. Get service info
    const svc = await apiRequest<{ service: RenderService }>(`${RENDER_API}/services/${serviceId}`, {
      headers: authHeaders(),
    });

    if (!svc.ok) {
      return {
        platform: 'render',
        service_id: serviceId,
        service_name: 'unknown',
        status: 'unknown',
        failure_type: 'unknown',
        root_cause: `Could not fetch service: ${svc.error}`,
        evidence: [svc.error || ''],
        suggested_tier: 3,
        suggested_action: 'Check if the service ID is correct and RENDER_API_KEY has access.',
        confidence: 'low',
      };
    }

    const service = svc.data.service || svc.data as unknown as RenderService;
    const serviceName = service.name || serviceId;

    // 2. Get latest deploy
    const deploys = await apiRequest<RenderDeploy[]>(`${RENDER_API}/services/${serviceId}/deploys?limit=5`, {
      headers: authHeaders(),
    });

    // 3. Get logs for analysis
    const logs = await this.getLogs(serviceId, 100);
    const { failureType, evidence } = getPrimaryFailure(logs);

    // 4. Determine status
    let status: Diagnosis['status'] = 'unknown';
    const latestDeploy = deploys.ok && Array.isArray(deploys.data) ? deploys.data[0] : null;

    if (service.suspended === 'suspended') {
      status = 'down';
    } else if (latestDeploy?.status === 'build_failed' || latestDeploy?.status === 'update_failed') {
      status = 'failing';
    } else if (latestDeploy?.status === 'live') {
      // Check health
      const url = service.serviceDetails?.url;
      if (url) {
        const health = await httpHealthCheck(url);
        status = health.healthy ? 'healthy' : 'degraded';
      } else {
        status = 'healthy'; // No URL to check, assume OK
      }
    } else if (latestDeploy?.status === 'deactivated') {
      status = 'down';
    } else {
      status = 'degraded';
    }

    const tier = classifyTier(failureType);

    return {
      platform: 'render',
      service_id: serviceId,
      service_name: serviceName,
      status,
      failure_type: failureType,
      root_cause: failureType === 'unknown'
        ? `Service status: ${status}. Latest deploy: ${latestDeploy?.status || 'none'}. No specific error pattern found in logs.`
        : `Detected ${failureType}: ${evidence.join('; ')}`,
      evidence,
      suggested_tier: tier,
      suggested_action: this.suggestAction(failureType, tier),
      confidence: failureType === 'unknown' ? 'low' : 'high',
    };
  }

  async getLogs(serviceId: string, lines: number = 100): Promise<string> {
    // Render's log API — fetch recent logs
    const res = await apiRequest<{ id: string; log: string }[]>(
      `${RENDER_API}/services/${serviceId}/logs?limit=${lines}`,
      { headers: authHeaders() },
    );

    if (!res.ok) {
      return `[Error fetching logs: ${res.error}]`;
    }

    if (Array.isArray(res.data)) {
      return res.data.map((entry) => entry.log || JSON.stringify(entry)).join('\n');
    }

    return JSON.stringify(res.data);
  }

  // ── Tier 1 Actions ────────────────────────────────────

  async restart(serviceId: string): Promise<FixResult> {
    const res = await apiRequest(`${RENDER_API}/services/${serviceId}/restart`, {
      method: 'POST',
      headers: authHeaders(),
    });

    return {
      success: res.ok,
      action_taken: 'restart',
      details: res.ok ? 'Service restart triggered successfully.' : `Restart failed: ${res.error}`,
      rollback_available: false,
    };
  }

  async rollback(serviceId: string, deploymentId: string): Promise<FixResult> {
    const res = await apiRequest(`${RENDER_API}/services/${serviceId}/deploys/${deploymentId}/rollback`, {
      method: 'POST',
      headers: authHeaders(),
    });

    return {
      success: res.ok,
      action_taken: 'rollback',
      details: res.ok
        ? `Rolled back to deployment ${deploymentId}.`
        : `Rollback failed: ${res.error}`,
      rollback_available: false,
      rollback_id: deploymentId,
    };
  }

  // ── Tier 2 Actions ────────────────────────────────────

  async applyFix(serviceId: string, fix: Record<string, unknown>): Promise<FixResult> {
    const fixType = fix.type as string;

    if (fixType === 'env_var') {
      // Update or create an environment variable
      const res = await apiRequest(`${RENDER_API}/services/${serviceId}/env-vars`, {
        method: 'PUT',
        headers: authHeaders(),
        body: [{ key: fix.key as string, value: fix.value as string }],
      });

      return {
        success: res.ok,
        action_taken: `Set env var ${fix.key}`,
        details: res.ok ? `Environment variable ${fix.key} updated.` : `Failed: ${res.error}`,
        rollback_available: true,
        rollback_id: undefined,
      };
    }

    if (fixType === 'redeploy') {
      const res = await apiRequest<RenderDeploy>(`${RENDER_API}/services/${serviceId}/deploys`, {
        method: 'POST',
        headers: authHeaders(),
      });

      return {
        success: res.ok,
        action_taken: 'trigger_redeploy',
        details: res.ok
          ? `New deploy triggered (ID: ${res.data?.id}).`
          : `Redeploy failed: ${res.error}`,
        rollback_available: true,
        rollback_id: res.ok ? res.data?.id : undefined,
      };
    }

    return {
      success: false,
      action_taken: 'unknown_fix_type',
      details: `Unknown fix type: ${fixType}. Supported: env_var, redeploy.`,
      rollback_available: false,
    };
  }

  // ── Verification ──────────────────────────────────────

  async checkHealth(url: string): Promise<HealthCheck> {
    return httpHealthCheck(url);
  }

  // ── Tools ─────────────────────────────────────────────

  getTools(): ToolDefinition[] {
    return [
      // ── Diagnostic (read-only) ──
      {
        name: 'render_detect_failure',
        description: 'Check a Render service status and diagnose any failures. Returns diagnosis with tier classification.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID (e.g. srv-xxxxxxxxxxxxx)' },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => JSON.stringify(await this.detectFailure(args.service_id as string)),
      },
      {
        name: 'render_get_logs',
        description: 'Fetch recent logs from a Render service (build + runtime).',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID' },
            lines: { type: 'number', description: 'Number of log lines (default 100)' },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => await this.getLogs(args.service_id as string, (args.lines as number) || 100),
      },
      {
        name: 'render_get_service_info',
        description: 'Get details about a Render service (name, URL, build command, health check path).',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID' },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const res = await apiRequest(`${RENDER_API}/services/${args.service_id}`, { headers: authHeaders() });
          return JSON.stringify(res.data);
        },
      },
      {
        name: 'render_list_deploys',
        description: 'List recent deployments for a Render service.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID' },
            limit: { type: 'number', description: 'Max deploys to return (default 10)' },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const limit = (args.limit as number) || 10;
          const res = await apiRequest(`${RENDER_API}/services/${args.service_id}/deploys?limit=${limit}`, { headers: authHeaders() });
          return JSON.stringify(res.data);
        },
      },
      {
        name: 'render_get_env_vars',
        description: 'List environment variables for a Render service (values may be redacted by Render API).',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID' },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const res = await apiRequest(`${RENDER_API}/services/${args.service_id}/env-vars`, { headers: authHeaders() });
          return JSON.stringify(res.data);
        },
      },

      // ── Tier 1: Write (approval via @write) ──
      {
        name: 'render_restart_service',
        description: 'Restart a Render service. This is a Tier 1 action — reversible, low blast radius.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID to restart' },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        handler: async (args) => JSON.stringify(await this.restart(args.service_id as string)),
      },
      {
        name: 'render_rollback',
        description: 'Roll back a Render service to a previous deployment. Tier 1 action.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID' },
            deploy_id: { type: 'string', description: 'Deployment ID to roll back to' },
          },
          required: ['service_id', 'deploy_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        handler: async (args) =>
          JSON.stringify(await this.rollback(args.service_id as string, args.deploy_id as string)),
      },

      // ── Tier 2: Destructive (always requires approval) ──
      {
        name: 'render_update_env_var',
        description:
          'Create or update an environment variable on a Render service. ' +
          'Tier 2 action — this changes the deployed configuration and requires human approval.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID' },
            key: { type: 'string', description: 'Environment variable name' },
            value: { type: 'string', description: 'Environment variable value' },
          },
          required: ['service_id', 'key', 'value'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: async (args) =>
          JSON.stringify(
            await this.applyFix(args.service_id as string, {
              type: 'env_var',
              key: args.key,
              value: args.value,
            }),
          ),
      },
      {
        name: 'render_trigger_deploy',
        description:
          'Trigger a new deployment for a Render service. ' +
          'Tier 2 action — this deploys new code and requires human approval.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: 'Render service ID' },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: async (args) =>
          JSON.stringify(
            await this.applyFix(args.service_id as string, { type: 'redeploy' }),
          ),
      },
    ];
  }

  // ── Helpers ───────────────────────────────────────────

  private suggestAction(failureType: string, tier: number): string {
    const actions: Record<string, string> = {
      crash_loop: 'Restart the service to recover from the crash loop.',
      health_check_failure: 'Restart the service and verify the health check endpoint.',
      timeout: 'Restart the service — may be a transient hang.',
      rate_limited: 'Wait and retry — rate limit should clear shortly.',
      build_failure: 'Check build logs, fix the build error, and trigger a new deploy.',
      dependency_conflict: 'Update dependencies in requirements/package.json and redeploy.',
      env_misconfiguration: 'Check and fix the environment variable configuration.',
      port_binding_error: 'Ensure the service binds to the PORT environment variable provided by Render.',
      config_error: 'Review and fix the service configuration.',
      code_bug: 'Analyze the error, draft a fix, test in sandbox, then deploy.',
      auth_expired: 'Rotate or refresh the expired credential.',
      auth_revoked: 'MANUAL ACTION REQUIRED: Re-create credentials in the provider dashboard.',
      quota_exceeded: 'MANUAL ACTION REQUIRED: Upgrade plan or wait for quota reset.',
      platform_outage: 'WAIT: Render platform issue — nothing to remediate on our side.',
    };
    return actions[failureType] || 'Investigate further — failure type not recognized.';
  }
}
