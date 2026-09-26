/**
 * Deploy Doctor — GitHub Pages Adapter
 *
 * Full implementation. Talks to the GitHub REST API to diagnose and
 * heal broken GitHub Pages deployments.
 *
 * API: https://docs.github.com/en/rest
 * Env required: GITHUB_TOKEN
 *
 * Key GitHub API endpoints used:
 *   GET  /repos/{owner}/{repo}/pages                       → pages config & status
 *   GET  /repos/{owner}/{repo}/pages/builds                → build history
 *   POST /repos/{owner}/{repo}/pages/builds                → request new build
 *   GET  /repos/{owner}/{repo}/actions/runs                → workflow runs
 *   GET  /repos/{owner}/{repo}/actions/runs/{id}/logs      → workflow logs (zip)
 *   POST /repos/{owner}/{repo}/actions/runs/{id}/rerun     → re-run failed jobs
 *   GET  /repos/{owner}/{repo}/contents/{path}             → read file
 *   PUT  /repos/{owner}/{repo}/contents/{path}             → update file (via commit)
 *
 * serviceId format: "owner/repo"  e.g. "acme/my-site"
 *
 * ╔══════════════════════════════════════════════════════════╗
 * ║  IMPORTANT: GitHub Pages has NO running process.        ║
 * ║  There is no "restart" in the traditional sense.        ║
 * ║  Tier 1 = retry the build. Almost everything else is    ║
 * ║  Tier 2 (fix config/code then rebuild) or Tier 3.       ║
 * ╚══════════════════════════════════════════════════════════╝
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

const GITHUB_API = 'https://api.github.com';

// ── Auth helpers ───────────────────────────────────────────

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN environment variable is not set');
  return token;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: 'application/vnd.github.v3+json',
  };
}

// ── GitHub API response shape types ───────────────────────

interface GHPagesInfo {
  status: string; // 'built' | 'building' | 'errored' | 'null'
  url: string;
  source?: {
    branch: string;
    path: string;
  };
  build_type?: string; // 'legacy' | 'workflow'
  custom_404?: boolean;
  html_url?: string;
}

interface GHPagesBuild {
  status: string; // 'built' | 'building' | 'errored'
  error: { message: string | null };
  commit: string;
  duration: number;
  created_at: string;
  updated_at: string;
  pusher?: { login: string };
}

interface GHWorkflowRun {
  id: number;
  name: string;
  status: string;   // 'queued' | 'in_progress' | 'completed'
  conclusion: string | null; // 'success' | 'failure' | 'cancelled' | 'skipped' | null
  html_url: string;
  created_at: string;
  updated_at: string;
  head_sha: string;
  head_branch: string;
  workflow_id: number;
  run_attempt: number;
}

interface GHFileContent {
  content: string;   // base64-encoded
  encoding: string;
  sha: string;
  name: string;
  path: string;
  size: number;
}

// ── Adapter implementation ─────────────────────────────────

export class GitHubPagesAdapter extends BaseAdapter {
  readonly platform: Platform = 'github-pages';
  readonly displayName = 'GitHub Pages';

  // ── Diagnostic ────────────────────────────────────────

  async detectFailure(serviceId: string): Promise<Diagnosis> {
    // serviceId = "owner/repo"

    // 1. Get Pages config
    const pagesRes = await apiRequest<GHPagesInfo>(
      `${GITHUB_API}/repos/${serviceId}/pages`,
      { headers: authHeaders() },
    );

    if (!pagesRes.ok) {
      // Could be a 404 (Pages not enabled) or auth failure
      const isNotFound = pagesRes.status === 404;
      return {
        platform: 'github-pages',
        service_id: serviceId,
        service_name: serviceId,
        status: 'unknown',
        failure_type: 'unknown',
        root_cause: isNotFound
          ? `GitHub Pages is not enabled for ${serviceId}, or the repo does not exist.`
          : `Failed to fetch Pages config: ${pagesRes.error}`,
        evidence: [pagesRes.error ?? ''],
        suggested_tier: 3,
        suggested_action: isNotFound
          ? 'Enable GitHub Pages in the repository settings.'
          : 'Check GITHUB_TOKEN permissions (needs pages:read, actions:read).',
        confidence: 'low',
      };
    }

    const pages = pagesRes.data;
    const repoName = serviceId.split('/').pop() ?? serviceId;

    // 2. Get most recent Pages build
    const buildsRes = await apiRequest<GHPagesBuild[]>(
      `${GITHUB_API}/repos/${serviceId}/pages/builds?per_page=5`,
      { headers: authHeaders() },
    );

    const latestBuild = buildsRes.ok && Array.isArray(buildsRes.data) ? buildsRes.data[0] : null;

    // 3. Get most recent Actions workflow run (for Actions-based Pages)
    const runsRes = await apiRequest<{ workflow_runs: GHWorkflowRun[] }>(
      `${GITHUB_API}/repos/${serviceId}/actions/runs?per_page=5&branch=${pages.source?.branch ?? 'main'}`,
      { headers: authHeaders() },
    );

    const latestRun = runsRes.ok && runsRes.data?.workflow_runs?.length
      ? runsRes.data.workflow_runs[0]
      : null;

    // 4. Fetch logs and parse them
    const logs = await this.getLogs(serviceId, 200);
    const { failureType, evidence } = getPrimaryFailure(logs);

    // 5. Map status
    let status: Diagnosis['status'] = 'unknown';

    if (pages.status === 'built') {
      // Pages says built — do a live health check
      const siteUrl = pages.html_url ?? pages.url;
      if (siteUrl) {
        const health = await httpHealthCheck(siteUrl);
        status = health.healthy ? 'healthy' : 'degraded';
      } else {
        status = 'healthy';
      }
    } else if (pages.status === 'building') {
      status = 'degraded';
    } else if (pages.status === 'errored') {
      status = 'failing';
    } else if (latestBuild?.status === 'errored') {
      status = 'failing';
    } else if (latestRun?.conclusion === 'failure') {
      status = 'failing';
    } else {
      status = 'unknown';
    }

    // 6. Build evidence list
    const rawEvidence: string[] = [...evidence];

    if (latestBuild?.error?.message) {
      rawEvidence.unshift(`Pages build error: ${latestBuild.error.message}`);
    }
    if (latestBuild) {
      rawEvidence.push(`Latest build status: ${latestBuild.status} (commit ${latestBuild.commit.slice(0, 8)})`);
    }
    if (latestRun) {
      rawEvidence.push(
        `Latest Actions run: "${latestRun.name}" — status=${latestRun.status}, conclusion=${latestRun.conclusion ?? 'pending'}`,
      );
    }

    // Override failureType when we have a clear build failure signal
    const resolvedFailureType =
      (pages.status === 'errored' || latestBuild?.status === 'errored') && failureType === 'unknown'
        ? 'build_failure'
        : failureType;

    const tier = classifyTier(resolvedFailureType);

    return {
      platform: 'github-pages',
      service_id: serviceId,
      service_name: repoName,
      status,
      failure_type: resolvedFailureType,
      root_cause: resolvedFailureType === 'unknown'
        ? `Pages status: ${pages.status}. Latest build: ${latestBuild?.status ?? 'none'}. Latest run conclusion: ${latestRun?.conclusion ?? 'n/a'}.`
        : `Detected ${resolvedFailureType}: ${rawEvidence.slice(0, 3).join('; ')}`,
      evidence: rawEvidence.slice(0, 10),
      suggested_tier: tier,
      suggested_action: this.suggestAction(resolvedFailureType, tier),
      confidence: resolvedFailureType === 'unknown' ? 'low' : 'high',
    };
  }

  async getLogs(serviceId: string, lines: number = 100): Promise<string> {
    const logParts: string[] = [];

    // 1. Try to get logs from the latest Actions workflow run
    const runsRes = await apiRequest<{ workflow_runs: GHWorkflowRun[] }>(
      `${GITHUB_API}/repos/${serviceId}/actions/runs?per_page=3`,
      { headers: authHeaders() },
    );

    if (runsRes.ok && runsRes.data?.workflow_runs?.length) {
      const run = runsRes.data.workflow_runs[0];
      logParts.push(`=== GitHub Actions Run: "${run.name}" (id=${run.id}) ===`);
      logParts.push(`Status: ${run.status} | Conclusion: ${run.conclusion ?? 'pending'}`);
      logParts.push(`Branch: ${run.head_branch} | Commit: ${run.head_sha.slice(0, 8)}`);
      logParts.push(`URL: ${run.html_url}`);
      logParts.push('');

      // Try to fetch the log archive (zip) — only available if run is completed
      if (run.status === 'completed') {
        const logsRes = await apiRequest<string>(
          `${GITHUB_API}/repos/${serviceId}/actions/runs/${run.id}/logs`,
          {
            headers: {
              ...authHeaders(),
              Accept: 'application/vnd.github.v3+json',
            },
            // GitHub returns a 302 redirect to a zip download URL;
            // the api-client follows fetch redirects by default.
            // The body will be binary (zip) — we capture whatever text we get.
          },
        );

        if (logsRes.ok && typeof logsRes.data === 'string' && logsRes.data.length > 0) {
          // We likely got a redirect or partial text. Surface what we can.
          const truncated = logsRes.data.slice(0, 4000);
          logParts.push('--- Actions Log Output (may be partial from zip redirect) ---');
          logParts.push(truncated);
        } else {
          logParts.push(`(Could not fetch log archive: ${logsRes.error ?? 'binary zip not parseable as text'})`);
        }
      }
    }

    // 2. Always append Pages build history
    const buildsRes = await apiRequest<GHPagesBuild[]>(
      `${GITHUB_API}/repos/${serviceId}/pages/builds?per_page=3`,
      { headers: authHeaders() },
    );

    if (buildsRes.ok && Array.isArray(buildsRes.data) && buildsRes.data.length > 0) {
      logParts.push('=== GitHub Pages Build History ===');
      for (const build of buildsRes.data) {
        logParts.push(
          `[${build.created_at}] status=${build.status} commit=${build.commit.slice(0, 8)}` +
          (build.error?.message ? ` error="${build.error.message}"` : ''),
        );
      }
    } else if (!buildsRes.ok) {
      logParts.push(`(Could not fetch Pages builds: ${buildsRes.error})`);
    }

    const full = logParts.join('\n');

    // Trim to requested line count
    const allLines = full.split('\n');
    return allLines.slice(0, lines).join('\n');
  }

  // ── Tier 1 Actions ────────────────────────────────────

  /**
   * For GitHub Pages, "restart" = request a new Pages build.
   * If the repo uses GitHub Actions, we re-run the latest failed workflow instead.
   * Tier 1 — low blast radius, reversible.
   */
  async restart(serviceId: string): Promise<FixResult> {
    // First try to re-trigger via Pages API (classic Jekyll / legacy builds)
    const buildRes = await apiRequest<{ status: string }>(
      `${GITHUB_API}/repos/${serviceId}/pages/builds`,
      {
        method: 'POST',
        headers: authHeaders(),
      },
    );

    if (buildRes.ok) {
      return {
        success: true,
        action_taken: 'trigger_pages_build',
        details: `New GitHub Pages build requested (status: ${buildRes.data?.status ?? 'queued'}).`,
        rollback_available: false,
      };
    }

    // If the Pages build endpoint returned 409 (conflict — already building)
    // or is Actions-based (422), fall back to re-running the latest workflow run.
    const runsRes = await apiRequest<{ workflow_runs: GHWorkflowRun[] }>(
      `${GITHUB_API}/repos/${serviceId}/actions/runs?per_page=5`,
      { headers: authHeaders() },
    );

    if (!runsRes.ok || !runsRes.data?.workflow_runs?.length) {
      return {
        success: false,
        action_taken: 'trigger_pages_build',
        details: `Pages build trigger failed (${buildRes.error}). Also could not list workflow runs: ${runsRes.error ?? 'no runs found'}.`,
        rollback_available: false,
      };
    }

    // Find the latest failed or completed run and re-run it
    const runToRetry = runsRes.data.workflow_runs.find(
      (r) => r.status === 'completed' && (r.conclusion === 'failure' || r.conclusion === 'cancelled'),
    ) ?? runsRes.data.workflow_runs[0];

    const rerunRes = await apiRequest(
      `${GITHUB_API}/repos/${serviceId}/actions/runs/${runToRetry.id}/rerun`,
      {
        method: 'POST',
        headers: authHeaders(),
      },
    );

    return {
      success: rerunRes.ok,
      action_taken: `rerun_actions_run:${runToRetry.id}`,
      details: rerunRes.ok
        ? `Re-triggered Actions workflow run ${runToRetry.id} ("${runToRetry.name}").`
        : `Both Pages build trigger and Actions re-run failed. Pages error: ${buildRes.error}. Rerun error: ${rerunRes.error}.`,
      rollback_available: false,
    };
  }

  /**
   * Rollback: re-run a specific prior workflow run or point to a commit.
   * For GitHub Pages there's no first-class rollback API — we re-run a given run ID.
   */
  async rollback(serviceId: string, deploymentId: string): Promise<FixResult> {
    // deploymentId is treated as the Actions workflow run ID to re-run
    const rerunRes = await apiRequest(
      `${GITHUB_API}/repos/${serviceId}/actions/runs/${deploymentId}/rerun`,
      {
        method: 'POST',
        headers: authHeaders(),
      },
    );

    return {
      success: rerunRes.ok,
      action_taken: `rerun_workflow_run:${deploymentId}`,
      details: rerunRes.ok
        ? `Re-triggered workflow run ${deploymentId} to restore a previous build state.`
        : `Failed to re-run workflow run ${deploymentId}: ${rerunRes.error}`,
      rollback_available: false,
      rollback_id: deploymentId,
    };
  }

  // ── Tier 2 Actions ────────────────────────────────────

  /**
   * Apply a fix to the repository content via the GitHub Contents API.
   *
   * Supported fix types:
   *   - update_config : patch _config.yml (or any YAML config) with new key=value
   *   - update_file   : replace the full content of any file in the repo
   *   - push_fix      : alias for update_file (same code path)
   *
   * After modifying the file, the push itself triggers a new Pages build.
   */
  async applyFix(serviceId: string, fix: Record<string, unknown>): Promise<FixResult> {
    const fixType = fix.type as string;

    if (fixType === 'update_config' || fixType === 'update_file' || fixType === 'push_fix') {
      const filePath = (fix.path as string | undefined) ?? '_config.yml';
      const commitMessage = (fix.commit_message as string | undefined)
        ?? `fix: automated patch by Deploy Doctor [${fixType}]`;

      // 1. Fetch the current file to get its SHA (required for the PUT)
      const getRes = await apiRequest<GHFileContent>(
        `${GITHUB_API}/repos/${serviceId}/contents/${filePath}`,
        { headers: authHeaders() },
      );

      let fileSha: string | undefined;
      let currentContent = '';

      if (getRes.ok) {
        fileSha = getRes.data.sha;
        // GitHub returns base64-encoded content (may have newlines in the string)
        currentContent = Buffer.from(
          getRes.data.content.replace(/\n/g, ''),
          'base64',
        ).toString('utf-8');
      } else if (getRes.status !== 404) {
        // 404 is fine (new file). Anything else is a real problem.
        return {
          success: false,
          action_taken: `read_file:${filePath}`,
          details: `Could not read ${filePath}: ${getRes.error}`,
          rollback_available: false,
        };
      }

      // 2. Build new content
      let newContent: string;

      if (fixType === 'update_config' && fix.key && fix.value !== undefined) {
        // Patch a specific key in the YAML-ish config file
        const key = fix.key as string;
        const value = fix.value as string;
        const keyRegex = new RegExp(`^(${escapeRegex(key)}\\s*:).*$`, 'm');

        if (keyRegex.test(currentContent)) {
          newContent = currentContent.replace(keyRegex, `$1 ${value}`);
        } else {
          // Key not found — append it
          newContent = currentContent.trimEnd() + `\n${key}: ${value}\n`;
        }
      } else if (fix.content !== undefined) {
        // Full file replacement
        newContent = fix.content as string;
      } else {
        return {
          success: false,
          action_taken: `apply_fix:${fixType}`,
          details: 'Fix payload must include either (key + value) for update_config, or (content) for update_file.',
          rollback_available: false,
        };
      }

      // 3. Base64-encode new content
      const encodedContent = Buffer.from(newContent, 'utf-8').toString('base64');

      // 4. PUT the updated file
      const putBody: Record<string, unknown> = {
        message: commitMessage,
        content: encodedContent,
      };
      if (fileSha) {
        putBody.sha = fileSha; // required for updates; omit for new files
      }

      const branch = fix.branch as string | undefined;
      if (branch) putBody.branch = branch;

      const putRes = await apiRequest<{ commit: { sha: string } }>(
        `${GITHUB_API}/repos/${serviceId}/contents/${filePath}`,
        {
          method: 'PUT',
          headers: authHeaders(),
          body: putBody,
        },
      );

      if (!putRes.ok) {
        return {
          success: false,
          action_taken: `write_file:${filePath}`,
          details: `Failed to update ${filePath}: ${putRes.error}`,
          rollback_available: false,
        };
      }

      const commitSha = putRes.data?.commit?.sha ?? 'unknown';

      return {
        success: true,
        action_taken: `${fixType}:${filePath}`,
        details:
          `Updated ${filePath} via commit ${commitSha.slice(0, 8)}. ` +
          `GitHub Pages will automatically rebuild from the new commit.`,
        rollback_available: true,
        rollback_id: commitSha,
      };
    }

    // Unknown fix type
    return {
      success: false,
      action_taken: 'unknown_fix_type',
      details: `Unknown fix type: "${fixType}". Supported: update_config, update_file, push_fix.`,
      rollback_available: false,
    };
  }

  // ── Verification ──────────────────────────────────────

  async checkHealth(url: string): Promise<HealthCheck> {
    return httpHealthCheck(url);
  }

  // ── Tool Registration ─────────────────────────────────

  getTools(): ToolDefinition[] {
    return [
      // ────────────────────────────────────────────────
      //  Diagnostic tools (read-only)
      // ────────────────────────────────────────────────
      {
        name: 'ghpages_detect_failure',
        description:
          'Diagnose a GitHub Pages deployment. Checks Pages build status, latest Actions ' +
          'workflow run, fetches recent logs, and returns a structured Diagnosis with tier ' +
          'classification and suggested remediation. serviceId = "owner/repo".',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'GitHub repository in "owner/repo" format, e.g. "acme/my-site"',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) =>
          JSON.stringify(await this.detectFailure(args.service_id as string)),
      },

      {
        name: 'ghpages_get_build_status',
        description:
          'Get the current GitHub Pages build status and recent build history for a repository. ' +
          'Returns pages config, source branch/path, and the last 5 build records with error messages.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'GitHub repository in "owner/repo" format',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const sid = args.service_id as string;
          const [pagesRes, buildsRes] = await Promise.all([
            apiRequest<GHPagesInfo>(`${GITHUB_API}/repos/${sid}/pages`, { headers: authHeaders() }),
            apiRequest<GHPagesBuild[]>(`${GITHUB_API}/repos/${sid}/pages/builds?per_page=5`, { headers: authHeaders() }),
          ]);
          return JSON.stringify({
            pages_config: pagesRes.ok ? pagesRes.data : { error: pagesRes.error },
            recent_builds: buildsRes.ok ? buildsRes.data : { error: buildsRes.error },
          });
        },
      },

      {
        name: 'ghpages_get_workflow_logs',
        description:
          'Fetch recent GitHub Actions workflow logs for a repository. Useful for diagnosing ' +
          'build failures in Actions-based Pages deployments.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'GitHub repository in "owner/repo" format',
            },
            lines: {
              type: 'number',
              description: 'Max log lines to return (default 100)',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) =>
          await this.getLogs(args.service_id as string, (args.lines as number) || 100),
      },

      {
        name: 'ghpages_get_repo_config',
        description:
          'Read the contents of a repository file (e.g. _config.yml, .github/workflows/pages.yml) ' +
          'to inspect current configuration before proposing a fix.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'GitHub repository in "owner/repo" format',
            },
            path: {
              type: 'string',
              description: 'File path within the repo, e.g. "_config.yml" or ".github/workflows/deploy.yml"',
            },
          },
          required: ['service_id', 'path'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const sid = args.service_id as string;
          const path = args.path as string;
          const res = await apiRequest<GHFileContent>(
            `${GITHUB_API}/repos/${sid}/contents/${path}`,
            { headers: authHeaders() },
          );
          if (!res.ok) {
            return JSON.stringify({ error: res.error, status: res.status });
          }
          // Decode the base64 content for readability
          const decoded = Buffer.from(
            res.data.content.replace(/\n/g, ''),
            'base64',
          ).toString('utf-8');
          return JSON.stringify({
            path: res.data.path,
            sha: res.data.sha,
            size: res.data.size,
            content: decoded,
          });
        },
      },

      // ────────────────────────────────────────────────
      //  Tier 1: Re-trigger build (NOT destructive)
      // ────────────────────────────────────────────────
      {
        name: 'ghpages_retrigger_build',
        description:
          'Tier 1 — Re-trigger a GitHub Pages build without changing any code. ' +
          'For classic/Jekyll Pages this calls POST /pages/builds. For Actions-based Pages ' +
          'it re-runs the latest failed workflow. Low blast radius — only queues a rebuild.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'GitHub repository in "owner/repo" format',
            },
          },
          required: ['service_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        handler: async (args) =>
          JSON.stringify(await this.restart(args.service_id as string)),
      },

      // ────────────────────────────────────────────────
      //  Tier 2: Destructive — modify files + rebuild
      // ────────────────────────────────────────────────
      {
        name: 'ghpages_update_config',
        description:
          'Tier 2 — Patch a key-value pair in _config.yml (or another config file) via the ' +
          'GitHub Contents API and commit the change. The commit automatically triggers a new ' +
          'Pages build. REQUIRES HUMAN APPROVAL — this modifies repository content.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'GitHub repository in "owner/repo" format',
            },
            path: {
              type: 'string',
              description: 'Config file path (default: "_config.yml")',
            },
            key: {
              type: 'string',
              description: 'YAML key to update, e.g. "baseurl" or "theme"',
            },
            value: {
              type: 'string',
              description: 'New value for the key',
            },
            commit_message: {
              type: 'string',
              description: 'Git commit message (optional)',
            },
            branch: {
              type: 'string',
              description: 'Branch to commit to (optional, defaults to repo default branch)',
            },
          },
          required: ['service_id', 'key', 'value'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: async (args) =>
          JSON.stringify(
            await this.applyFix(args.service_id as string, {
              type: 'update_config',
              path: args.path ?? '_config.yml',
              key: args.key,
              value: args.value,
              commit_message: args.commit_message,
              branch: args.branch,
            }),
          ),
      },

      {
        name: 'ghpages_push_fix',
        description:
          'Tier 2 — Replace the full content of any file in the repository via the GitHub ' +
          'Contents API and commit. Use this to fix broken workflows, HTML, or other source ' +
          'files. The commit triggers a new Pages build. REQUIRES HUMAN APPROVAL.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'GitHub repository in "owner/repo" format',
            },
            path: {
              type: 'string',
              description: 'File path within the repo to update, e.g. ".github/workflows/pages.yml"',
            },
            content: {
              type: 'string',
              description: 'Full new file content (UTF-8 string)',
            },
            commit_message: {
              type: 'string',
              description: 'Git commit message describing the fix',
            },
            branch: {
              type: 'string',
              description: 'Branch to commit to (optional)',
            },
          },
          required: ['service_id', 'path', 'content'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: async (args) =>
          JSON.stringify(
            await this.applyFix(args.service_id as string, {
              type: 'push_fix',
              path: args.path,
              content: args.content,
              commit_message: args.commit_message,
              branch: args.branch,
            }),
          ),
      },
    ];
  }

  // ── Private helpers ───────────────────────────────────

  private suggestAction(failureType: string, tier: number): string {
    const actions: Record<string, string> = {
      build_failure:
        'Check Pages build logs for the specific error. ' +
        'Common causes: invalid _config.yml, unsupported Jekyll plugin, bad Liquid syntax. ' +
        'Use ghpages_retrigger_build for a clean retry, or ghpages_update_config to patch the config.',
      dependency_conflict:
        'A gem or npm package version conflict is causing the build to fail. ' +
        'Update the Gemfile/package.json and push via ghpages_push_fix.',
      env_misconfiguration:
        'A required environment variable or secret is missing in the Actions workflow. ' +
        'Update the workflow file with ghpages_push_fix.',
      config_error:
        'The Jekyll or static-site configuration is invalid. ' +
        'Read the config with ghpages_get_repo_config then patch it with ghpages_update_config.',
      auth_expired:
        'The GITHUB_TOKEN or a deploy key has expired. Rotate the token in repo settings.',
      auth_revoked:
        'MANUAL ACTION REQUIRED: A deploy key or PAT was revoked. Re-create it in GitHub settings.',
      quota_exceeded:
        'MANUAL ACTION REQUIRED: GitHub Actions minutes or bandwidth quota exceeded. ' +
        'Check your billing plan.',
      platform_outage:
        'WAIT: GitHub is experiencing an outage. Check https://www.githubstatus.com/',
      rate_limited:
        'GitHub API rate limit hit. Wait a few minutes and retry.',
      timeout:
        'Build timed out. Use ghpages_retrigger_build to retry.',
      crash_loop:
        'The build process is repeatedly crashing. Inspect logs and retrigger.',
      unknown:
        'No specific failure pattern detected. Run ghpages_get_workflow_logs for detailed output.',
    };
    return actions[failureType] ?? 'Investigate further using ghpages_detect_failure and ghpages_get_workflow_logs.';
  }
}

// ── Module-level utility ──────────────────────────────────

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
