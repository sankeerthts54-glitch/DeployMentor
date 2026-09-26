/**
 * Deploy Doctor — Shared Type Definitions
 *
 * Every adapter, tool, and the server itself imports from here.
 * DO NOT add platform-specific types to this file — put those
 * in the adapter that owns them.
 */

// ── Platforms ──────────────────────────────────────────────

export type Platform = 'hf-spaces' | 'vercel' | 'render' | 'github-pages';

// ── Remediation Tiers ─────────────────────────────────────

/**
 * Tier 1: Fully automatic (reversible, low blast radius)
 * Tier 2: Draft + sandbox-test + human approval (changes what's shipped)
 * Tier 3: Diagnose only — report to human and STOP
 */
export type Tier = 1 | 2 | 3;

// ── Diagnosis ─────────────────────────────────────────────

export type ServiceStatus = 'healthy' | 'degraded' | 'failing' | 'down' | 'unknown';

export type FailureType =
  | 'crash_loop'
  | 'build_failure'
  | 'health_check_failure'
  | 'quota_exceeded'
  | 'dependency_conflict'
  | 'env_misconfiguration'
  | 'port_binding_error'
  | 'timeout'
  | 'rate_limited'
  | 'auth_expired'
  | 'auth_revoked'
  | 'platform_outage'
  | 'config_error'
  | 'code_bug'
  | 'unknown';

export interface Diagnosis {
  platform: Platform;
  service_id: string;
  service_name: string;
  status: ServiceStatus;
  failure_type: FailureType;
  root_cause: string;
  evidence: string[];
  suggested_tier: Tier;
  suggested_action: string;
  confidence: 'high' | 'medium' | 'low';
}

// ── Fix & Rollback ────────────────────────────────────────

export interface FixResult {
  success: boolean;
  action_taken: string;
  details: string;
  rollback_available: boolean;
  rollback_id?: string;
}

// ── Health Check ──────────────────────────────────────────

export interface HealthCheck {
  url: string;
  status_code: number | null;
  response_time_ms: number | null;
  healthy: boolean;
  error?: string;
}

// ── MCP Tool Annotations ─────────────────────────────────

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<string>;
}
