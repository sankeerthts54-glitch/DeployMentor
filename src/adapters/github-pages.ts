/**
 * Deploy Doctor — GitHub Pages Adapter (LAPTOP 4)
 *
 * ╔══════════════════════════════════════════════════════════╗
 * ║  SKELETON — Laptop 4 fills in the implementation.       ║
 * ║  See LAPTOP4_INSTRUCTIONS.md for full build guide.      ║
 * ║  DO NOT modify files outside this adapter.              ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * API: https://docs.github.com/en/rest
 * Env required: GITHUB_TOKEN
 *
 * Key GitHub API endpoints:
 *   GET  https://api.github.com/repos/{owner}/{repo}/pages                → pages config
 *   GET  https://api.github.com/repos/{owner}/{repo}/pages/builds         → build history
 *   POST https://api.github.com/repos/{owner}/{repo}/pages/builds         → request build
 *   GET  https://api.github.com/repos/{owner}/{repo}/actions/runs         → workflow runs
 *   GET  https://api.github.com/repos/{owner}/{repo}/actions/runs/{id}/logs → workflow logs
 *   POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/{id}/dispatches → re-trigger
 *   GET  https://api.github.com/repos/{owner}/{repo}/contents/{path}      → file content
 *   PUT  https://api.github.com/repos/{owner}/{repo}/contents/{path}      → update file
 *
 * ╔══════════════════════════════════════════════════════════╗
 * ║  IMPORTANT: GitHub Pages has NO running process.        ║
 * ║  There is no "restart" in the traditional sense.        ║
 * ║  Tier 1 = retry the build. Almost everything else is    ║
 * ║  Tier 2 (fix config/code then rebuild) or Tier 3.       ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Common GitHub Pages failure shapes:
 *   - Broken Jekyll build (_config.yml error, Liquid syntax error)
 *   - GitHub Actions workflow failure (wrong Node version, bad build command)
 *   - Wrong base path causing 404s
 *   - Custom domain DNS misconfiguration
 *   - Missing index.html or wrong publish directory
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

export class GitHubPagesAdapter extends BaseAdapter {
  readonly platform: Platform = 'github-pages';
  readonly displayName = 'GitHub Pages';

  async detectFailure(serviceId: string): Promise<Diagnosis> {
    // TODO: Laptop 4 implements this
    // serviceId format: "owner/repo"
    // 1. GET /repos/{serviceId}/pages → check status
    // 2. GET /repos/{serviceId}/pages/builds → latest build status
    // 3. If Actions-based, GET /repos/{serviceId}/actions/runs?per_page=5
    // 4. Fetch logs and run getPrimaryFailure()
    // 5. Return Diagnosis
    throw new Error('GitHub Pages adapter not yet implemented — assign to Laptop 4');
  }

  async getLogs(serviceId: string, lines?: number): Promise<string> {
    // TODO: Laptop 4 implements this
    // Get logs from latest GitHub Actions workflow run OR pages build
    throw new Error('GitHub Pages adapter not yet implemented — assign to Laptop 4');
  }

  async restart(serviceId: string): Promise<FixResult> {
    // TODO: Laptop 4 implements this
    // For GitHub Pages, "restart" = request a new pages build
    // POST /repos/{serviceId}/pages/builds
    // OR re-run the latest Actions workflow
    throw new Error('GitHub Pages adapter not yet implemented — assign to Laptop 4');
  }

  async rollback(serviceId: string, deploymentId: string): Promise<FixResult> {
    // TODO: Laptop 4 implements this
    // Git revert to a prior commit + push → triggers rebuild
    // This is inherently Tier 2, not Tier 1, for GitHub Pages
    throw new Error('GitHub Pages adapter not yet implemented — assign to Laptop 4');
  }

  async applyFix(serviceId: string, fix: Record<string, unknown>): Promise<FixResult> {
    // TODO: Laptop 4 implements this
    // Handle fix types: update_config (_config.yml), update_file, push_fix
    // Use PUT /repos/{owner}/{repo}/contents/{path} to update files via API
    throw new Error('GitHub Pages adapter not yet implemented — assign to Laptop 4');
  }

  async checkHealth(url: string): Promise<HealthCheck> {
    return httpHealthCheck(url);
  }

  getTools(): ToolDefinition[] {
    // TODO: Laptop 4 — register tools following the same pattern as render.ts
    // MUST include:
    //   Diagnostic (readOnlyHint: true): ghpages_detect_failure, ghpages_get_build_status,
    //                                     ghpages_get_workflow_logs, ghpages_get_repo_config
    //   Tier 1 (destructiveHint: false):  ghpages_retrigger_build
    //   Tier 2 (destructiveHint: true):   ghpages_update_config, ghpages_push_fix
    return [];
  }
}
