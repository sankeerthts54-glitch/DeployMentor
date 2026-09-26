/**
 * Deploy Doctor — Hugging Face Spaces Adapter
 *
 * Full implementation using the Hugging Face Hub REST API.
 * API docs: https://huggingface.co/docs/hub/api
 *
 * Env required: HF_TOKEN
 *
 * Key HF API endpoints used:
 *   GET  https://huggingface.co/api/spaces/{owner}/{repo}          → space info
 *   GET  https://huggingface.co/api/spaces/{owner}/{repo}/runtime  → runtime status
 *   POST https://huggingface.co/api/spaces/{owner}/{repo}/restart  → restart space
 *   GET  https://huggingface.co/api/spaces/{owner}/{repo}/secrets  → list secret keys
 *   PUT  https://huggingface.co/api/spaces/{owner}/{repo}/secrets/{name} → upsert secret
 *
 * serviceId format throughout: "owner/repo-name"  (e.g. "username/my-space")
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

// ── Auth ───────────────────────────────────────────────────

function getToken(): string {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error('HF_TOKEN environment variable is not set');
  return token;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}` };
}

// ── HF API response shapes ─────────────────────────────────

interface HfSpaceRuntime {
  /** e.g. "RUNNING" | "BUILDING" | "SLEEPING" | "STOPPED" | "PAUSED" | "ERROR" | "NO_APP_FILE" | "CONFIG_ERROR" | "RUNTIME_ERROR" */
  stage: string;
  hardware?: {
    current: string;
    requested: string;
  };
  errorMessage?: string;
  gcTimeout?: number | null;
}

interface HfSpaceInfo {
  id: string;        // "owner/repo"
  author: string;
  sha: string;
  lastModified: string;
  private: boolean;
  gated: boolean;
  disabled: boolean;
  likes: number;
  tags: string[];
  host?: string;     // public URL host
  subdomain?: string;
  runtime?: HfSpaceRuntime;
  sdk?: string;      // "gradio" | "streamlit" | "docker" | "static"
}

interface HfLogEntry {
  timestamp?: string;
  type?: string;
  data?: string;
}

// ── Stage → ServiceStatus mapping ─────────────────────────

type HfStage = 'RUNNING' | 'BUILDING' | 'SLEEPING' | 'STOPPED' | 'PAUSED' | 'ERROR' | 'NO_APP_FILE' | 'CONFIG_ERROR' | 'RUNTIME_ERROR';

function stageToStatus(stage: string): Diagnosis['status'] {
  switch (stage.toUpperCase() as HfStage) {
    case 'RUNNING':
      return 'healthy';
    case 'BUILDING':
      return 'degraded';
    case 'SLEEPING':
    case 'STOPPED':
    case 'PAUSED':
      return 'down';
    case 'ERROR':
    case 'RUNTIME_ERROR':
    case 'NO_APP_FILE':
    case 'CONFIG_ERROR':
      return 'failing';
    default:
      return 'unknown';
  }
}

// ── Adapter ────────────────────────────────────────────────

export class HfSpacesAdapter extends BaseAdapter {
  readonly platform: Platform = 'hf-spaces';
  readonly displayName = 'Hugging Face Spaces';

  // ── Diagnostic ──────────────────────────────────────────

  async detectFailure(serviceId: string): Promise<Diagnosis> {
    // 1. Fetch space info (includes runtime stage)
    const infoRes = await apiRequest<HfSpaceInfo>(`${HF_API}/spaces/${serviceId}`, {
      headers: authHeaders(),
    });

    if (!infoRes.ok) {
      return {
        platform: 'hf-spaces',
        service_id: serviceId,
        service_name: serviceId,
        status: 'unknown',
        failure_type: 'unknown',
        root_cause: `Could not fetch space info: ${infoRes.error}`,
        evidence: [infoRes.error ?? ''],
        suggested_tier: 3,
        suggested_action: 'Verify the space ID (owner/repo) and that HF_TOKEN has read access.',
        confidence: 'low',
      };
    }

    const info = infoRes.data;
    const spaceName = info.id ?? serviceId;

    // 2. Fetch detailed runtime status
    const runtimeRes = await apiRequest<HfSpaceRuntime>(`${HF_API}/spaces/${serviceId}/runtime`, {
      headers: authHeaders(),
    });

    const runtime = runtimeRes.ok ? runtimeRes.data : info.runtime;
    const stage = runtime?.stage ?? 'unknown';
    const status = stageToStatus(stage);

    // 3. Fetch logs and run pattern analysis
    const logs = await this.getLogs(serviceId, 150);
    const { failureType: logFailure, evidence: logEvidence } = getPrimaryFailure(logs);

    // 4. Derive failure type — stage takes precedence for structural failures
    let failureType = logFailure;
    const extraEvidence: string[] = [];

    const upperStage = stage.toUpperCase();
    if (upperStage === 'BUILDING') {
      failureType = 'build_failure';
      extraEvidence.push(`Space is currently in BUILDING stage`);
    } else if (upperStage === 'CONFIG_ERROR' || upperStage === 'NO_APP_FILE') {
      failureType = 'config_error';
      extraEvidence.push(`Space runtime stage: ${stage}`);
    } else if (upperStage === 'SLEEPING') {
      // Sleeping is normal for free tier — only a problem if callers want it up
      failureType = logFailure === 'unknown' ? 'timeout' : logFailure;
      extraEvidence.push('Space is sleeping (free-tier idle timeout)');
    } else if (upperStage === 'RUNTIME_ERROR' || upperStage === 'ERROR') {
      failureType = logFailure === 'unknown' ? 'crash_loop' : logFailure;
      extraEvidence.push(`Space runtime error — stage: ${stage}`);
    }

    if (runtime?.errorMessage) {
      extraEvidence.push(`Runtime error message: ${runtime.errorMessage}`);
    }

    const allEvidence = [...extraEvidence, ...logEvidence];
    const tier = classifyTier(failureType);

    // 5. Optionally verify via HTTP if space is supposedly running
    if (status === 'healthy' && (info.subdomain || info.host)) {
      const spaceUrl = info.subdomain
        ? `https://${info.subdomain}.hf.space`
        : `https://${info.host}`;
      const health = await httpHealthCheck(spaceUrl);
      if (!health.healthy) {
        allEvidence.push(`HTTP health check failed: ${health.error ?? `HTTP ${health.status_code}`}`);
      }
    }

    return {
      platform: 'hf-spaces',
      service_id: serviceId,
      service_name: spaceName,
      status,
      failure_type: failureType,
      root_cause:
        failureType === 'unknown'
          ? `Space stage: ${stage}. No specific error pattern detected in logs.`
          : `Detected ${failureType}: ${allEvidence.slice(0, 3).join('; ')}`,
      evidence: allEvidence,
      suggested_tier: tier,
      suggested_action: this.suggestAction(failureType, stage, tier),
      confidence: failureType === 'unknown' ? 'low' : allEvidence.length > 1 ? 'high' : 'medium',
    };
  }

  async getLogs(serviceId: string, lines: number = 100): Promise<string> {
    // HF Hub exposes build and runtime logs under /events (server-sent events).
    // The REST API also returns a last-N log snapshot via the /logs endpoint when available.
    // We try both and concatenate what we can.

    const segments: string[] = [];

    // Attempt 1: Build logs
    const buildRes = await apiRequest<HfLogEntry[] | string>(
      `${HF_API}/spaces/${serviceId}/build-logs`,
      { headers: authHeaders() },
    );
    if (buildRes.ok) {
      const raw = buildRes.data;
      if (typeof raw === 'string') {
        segments.push(`=== Build Logs ===\n${raw}`);
      } else if (Array.isArray(raw)) {
        const text = raw
          .map((e) => `[${e.timestamp ?? ''}] ${e.data ?? JSON.stringify(e)}`)
          .join('\n');
        segments.push(`=== Build Logs ===\n${text}`);
      }
    }

    // Attempt 2: Runtime / container logs
    const runtimeRes = await apiRequest<HfLogEntry[] | string>(
      `${HF_API}/spaces/${serviceId}/runtime-logs`,
      { headers: authHeaders() },
    );
    if (runtimeRes.ok) {
      const raw = runtimeRes.data;
      if (typeof raw === 'string') {
        segments.push(`=== Runtime Logs ===\n${raw}`);
      } else if (Array.isArray(raw)) {
        const text = raw
          .map((e) => `[${e.timestamp ?? ''}] ${e.data ?? JSON.stringify(e)}`)
          .join('\n');
        segments.push(`=== Runtime Logs ===\n${text}`);
      }
    }

    if (segments.length === 0) {
      // Fall back: include error message from runtime info
      const runtimeInfo = await apiRequest<HfSpaceRuntime>(`${HF_API}/spaces/${serviceId}/runtime`, {
        headers: authHeaders(),
      });
      if (runtimeInfo.ok && runtimeInfo.data.errorMessage) {
        segments.push(`=== Runtime Error ===\n${runtimeInfo.data.errorMessage}`);
      } else {
        segments.push('[No logs available — the space may not have generated any output yet]');
      }
    }

    const combined = segments.join('\n\n');
    // Trim to the requested line count (from the end, most recent first)
    const allLines = combined.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  // ── Tier 1 Actions ────────────────────────────────────

  async restart(serviceId: string): Promise<FixResult> {
    // POST /api/spaces/{owner}/{repo}/restart
    const res = await apiRequest(`${HF_API}/spaces/${serviceId}/restart`, {
      method: 'POST',
      headers: authHeaders(),
    });

    return {
      success: res.ok,
      action_taken: 'restart',
      details: res.ok
        ? `Space ${serviceId} restart triggered successfully. It will transition through BUILDING → RUNNING.`
        : `Restart failed: ${res.error}`,
      rollback_available: false,
    };
  }

  async rollback(serviceId: string, deploymentId: string): Promise<FixResult> {
    // HF Spaces doesn't have a native rollback API. The closest approximation is
    // to factory-reset the Space to a prior commit via git operations on the Space's
    // repository, which requires Hugging Face git access. We surface this limitation
    // clearly and direct the user to the manual git reset workflow.
    return {
      success: false,
      action_taken: 'rollback_not_supported',
      details:
        `HF Spaces does not expose a native rollback API. ` +
        `To roll back to commit ${deploymentId}, clone the Space repo, ` +
        `run \`git revert\` or \`git reset --hard ${deploymentId}\`, ` +
        `and force-push to the Space's Hugging Face remote. ` +
        `Alternatively, use applyFix with type "redeploy" after reverting your source.`,
      rollback_available: false,
      rollback_id: deploymentId,
    };
  }

  // ── Tier 2 Actions ────────────────────────────────────

  async applyFix(serviceId: string, fix: Record<string, unknown>): Promise<FixResult> {
    const fixType = fix.type as string;

    // ── update_secret: add/update a Space secret (replaces env var for HF) ──
    if (fixType === 'update_secret') {
      const key = fix.key as string;
      const value = fix.value as string;

      // PUT /api/spaces/{owner}/{repo}/secrets/{secret_name}
      const res = await apiRequest(`${HF_API}/spaces/${serviceId}/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: { value },
      });

      return {
        success: res.ok,
        action_taken: `update_secret:${key}`,
        details: res.ok
          ? `Secret "${key}" updated on Space ${serviceId}. A restart may be required for changes to take effect.`
          : `Failed to update secret "${key}": ${res.error}`,
        rollback_available: false,
      };
    }

    // ── delete_secret ────────────────────────────────────────────────────────
    if (fixType === 'delete_secret') {
      const key = fix.key as string;

      const res = await apiRequest(`${HF_API}/spaces/${serviceId}/secrets/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });

      return {
        success: res.ok,
        action_taken: `delete_secret:${key}`,
        details: res.ok
          ? `Secret "${key}" deleted from Space ${serviceId}.`
          : `Failed to delete secret "${key}": ${res.error}`,
        rollback_available: false,
      };
    }

    // ── redeploy: restart the space (triggers rebuild from HEAD) ────────────
    if (fixType === 'redeploy') {
      // For HF Spaces, a "redeploy" means factory-restart so the space rebuilds
      // from the current HEAD of its repo.
      const res = await apiRequest(`${HF_API}/spaces/${serviceId}/restart`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          // factory=true causes a cold restart (wipes cache, full rebuild)
        },
        body: { factory: true },
      });

      return {
        success: res.ok,
        action_taken: 'factory_restart_redeploy',
        details: res.ok
          ? `Factory restart triggered for Space ${serviceId}. The space will fully rebuild from its current repository HEAD.`
          : `Redeploy (factory restart) failed: ${res.error}`,
        rollback_available: false,
      };
    }

    // ── update_metadata: change visibility, hardware tier, etc. ─────────────
    if (fixType === 'update_metadata') {
      const payload = fix.payload as Record<string, unknown>;

      // PATCH /api/spaces/{owner}/{repo}/settings
      const res = await apiRequest(`${HF_API}/spaces/${serviceId}/settings`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: payload,
      });

      return {
        success: res.ok,
        action_taken: 'update_space_settings',
        details: res.ok
          ? `Space settings updated: ${JSON.stringify(payload)}`
          : `Settings update failed: ${res.error}`,
        rollback_available: false,
      };
    }

    return {
      success: false,
      action_taken: 'unknown_fix_type',
      details: `Unknown fix type: "${fixType}". Supported types: update_secret, delete_secret, redeploy, update_metadata.`,
      rollback_available: false,
    };
  }

  // ── Verification ──────────────────────────────────────

  async checkHealth(url: string): Promise<HealthCheck> {
    return httpHealthCheck(url);
  }

  // ── MCP Tool Definitions ──────────────────────────────

  getTools(): ToolDefinition[] {
    return [
      // ── Diagnostic (read-only) ─────────────────────────────────────────────

      {
        name: 'hf_detect_failure',
        description:
          'Diagnose a Hugging Face Space. Checks the runtime stage (RUNNING, BUILDING, ' +
          'SLEEPING, ERROR, etc.), fetches logs, and returns a structured Diagnosis with ' +
          'failure type, root cause, and recommended remediation tier.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'HF Space ID in "owner/repo" format (e.g. "username/my-space")',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) =>
          JSON.stringify(await this.detectFailure(args.service_id as string), null, 2),
      },

      {
        name: 'hf_get_logs',
        description:
          'Fetch recent build and runtime logs from a Hugging Face Space. ' +
          'Useful for diagnosing build errors, import failures, and crash loops.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'HF Space ID in "owner/repo" format',
            },
            lines: {
              type: 'number',
              description: 'Maximum number of log lines to return (default 100)',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) =>
          await this.getLogs(args.service_id as string, (args.lines as number) || 100),
      },

      {
        name: 'hf_get_space_status',
        description:
          'Get the current runtime status and metadata for a Hugging Face Space. ' +
          'Returns stage, hardware tier, SDK, and basic space info.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'HF Space ID in "owner/repo" format',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const [infoRes, runtimeRes] = await Promise.all([
            apiRequest<HfSpaceInfo>(`${HF_API}/spaces/${args.service_id}`, { headers: authHeaders() }),
            apiRequest<HfSpaceRuntime>(`${HF_API}/spaces/${args.service_id}/runtime`, { headers: authHeaders() }),
          ]);
          return JSON.stringify(
            {
              info: infoRes.ok ? infoRes.data : { error: infoRes.error },
              runtime: runtimeRes.ok ? runtimeRes.data : { error: runtimeRes.error },
            },
            null,
            2,
          );
        },
      },

      {
        name: 'hf_list_secrets',
        description:
          'List the secret key names (not values) configured on a Hugging Face Space. ' +
          'Helps identify missing or misconfigured secrets causing env_misconfiguration failures.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'HF Space ID in "owner/repo" format',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const res = await apiRequest(`${HF_API}/spaces/${args.service_id}/secrets`, {
            headers: authHeaders(),
          });
          return JSON.stringify(res.ok ? res.data : { error: res.error }, null, 2);
        },
      },

      // ── Tier 1: Restart (non-destructive write) ───────────────────────────

      {
        name: 'hf_restart_space',
        description:
          'Restart a Hugging Face Space. ' +
          'Tier 1 action — low blast radius. Wakes a sleeping space, clears transient ' +
          'crash loops, and reloads the runtime without modifying code or config. ' +
          'Idempotent: safe to call multiple times.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'HF Space ID in "owner/repo" format to restart',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        handler: async (args) =>
          JSON.stringify(await this.restart(args.service_id as string), null, 2),
      },

      // ── Tier 2: Destructive (always requires human approval) ──────────────

      {
        name: 'hf_update_secret',
        description:
          'Create or update a secret (environment variable) on a Hugging Face Space. ' +
          'Tier 2 action — changes the space configuration. Requires human approval. ' +
          'A restart may be needed for the new value to take effect.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'HF Space ID in "owner/repo" format',
            },
            key: {
              type: 'string',
              description: 'Secret name (environment variable key)',
            },
            value: {
              type: 'string',
              description: 'Secret value to set',
            },
          },
          required: ['service_id', 'key', 'value'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: async (args) =>
          JSON.stringify(
            await this.applyFix(args.service_id as string, {
              type: 'update_secret',
              key: args.key,
              value: args.value,
            }),
            null,
            2,
          ),
      },

      {
        name: 'hf_redeploy',
        description:
          'Trigger a factory restart (full rebuild) of a Hugging Face Space from its ' +
          'current repository HEAD. Tier 2 action — clears the build cache and ' +
          're-installs all dependencies. Requires human approval.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'HF Space ID in "owner/repo" format',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: async (args) =>
          JSON.stringify(
            await this.applyFix(args.service_id as string, { type: 'redeploy' }),
            null,
            2,
          ),
      },

      {
        name: 'hf_delete_secret',
        description:
          'Delete a secret from a Hugging Face Space. ' +
          'Tier 2 action — permanently removes the secret. Requires human approval.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'HF Space ID in "owner/repo" format',
            },
            key: {
              type: 'string',
              description: 'Secret name to delete',
            },
          },
          required: ['service_id', 'key'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: async (args) =>
          JSON.stringify(
            await this.applyFix(args.service_id as string, {
              type: 'delete_secret',
              key: args.key,
            }),
            null,
            2,
          ),
      },
    ];
  }

  // ── Helpers ──────────────────────────────────────────

  private suggestAction(failureType: string, stage: string, tier: number): string {
    const actions: Record<string, string> = {
      crash_loop:
        'Use hf_restart_space to clear the crash loop. If it recurs, check logs with hf_get_logs for the root cause.',
      health_check_failure:
        'Restart the space with hf_restart_space, then verify the public URL responds.',
      timeout:
        stage.toUpperCase() === 'SLEEPING'
          ? 'Space is sleeping (free-tier idle). Use hf_restart_space to wake it up.'
          : 'Restart the space with hf_restart_space — may be a transient hang.',
      rate_limited:
        'Wait for the rate limit window to reset, then retry. Consider caching API calls in your app.',
      build_failure:
        'Inspect build logs with hf_get_logs. Fix requirements.txt/packages.txt or app.py, then use hf_redeploy.',
      dependency_conflict:
        'Check build logs for the conflicting package. Pin versions in requirements.txt and use hf_redeploy.',
      env_misconfiguration:
        'Use hf_list_secrets to see what is set, then hf_update_secret to add or correct missing secrets.',
      port_binding_error:
        'Ensure the app listens on port 7860 (Gradio) or the PORT env var. Fix the code and use hf_redeploy.',
      config_error:
        `Space stage is ${stage}. Check README.md YAML front-matter and app file. Use hf_redeploy after fixing.`,
      code_bug:
        'Analyze logs for the traceback, draft a fix, test locally, push to the Space repo, then use hf_redeploy.',
      auth_expired:
        'Rotate the expired API key/token and update it with hf_update_secret, then restart with hf_restart_space.',
      auth_revoked:
        'MANUAL ACTION REQUIRED: Re-create credentials in the external provider, then use hf_update_secret.',
      quota_exceeded:
        'MANUAL ACTION REQUIRED: Upgrade the external API plan, or wait for the quota window to reset.',
      platform_outage:
        'WAIT: Check https://status.huggingface.co — this is a platform-side issue, nothing to remediate locally.',
    };
    return (
      actions[failureType] ??
      `Tier ${tier} issue detected. Review logs with hf_get_logs for more detail.`
    );
  }
}
