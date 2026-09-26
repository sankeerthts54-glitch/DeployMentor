/**
 * Deploy Doctor — Tier Classifier
 *
 * Pure function: takes a failure type → returns the remediation tier.
 * This is the defensible "where it stops" logic for the demo.
 *
 * Tier 1: auto-fix (reversible, low blast radius)
 * Tier 2: draft + test + approval (changes what's shipped)
 * Tier 3: report only (nothing safe to automate)
 */

import type { FailureType, Tier } from '../types.js';

const TIER_MAP: Record<FailureType, Tier> = {
  // ── Tier 1: Automatic ────────────────────────────────
  crash_loop: 1,
  timeout: 1,
  rate_limited: 1,
  health_check_failure: 1,

  // ── Tier 2: Approval Required ────────────────────────
  build_failure: 2,
  dependency_conflict: 2,
  env_misconfiguration: 2,
  port_binding_error: 2,
  config_error: 2,
  code_bug: 2,
  auth_expired: 2,   // refresh flow exists but changes a credential

  // ── Tier 3: Report Only ──────────────────────────────
  auth_revoked: 3,
  quota_exceeded: 3,
  platform_outage: 3,
  unknown: 3,
};

export function classifyTier(failureType: FailureType): Tier {
  return TIER_MAP[failureType] ?? 3;
}

export function getTierExplanation(tier: Tier): string {
  switch (tier) {
    case 1:
      return 'TIER 1 — Automatic: This action is reversible and low-risk. ' +
        'The agent will execute it immediately (restart, retry, rollback).';
    case 2:
      return 'TIER 2 — Approval Required: This action changes what is deployed. ' +
        'The agent will draft a fix, test it in the sandbox, and wait for your explicit approval before applying.';
    case 3:
      return 'TIER 3 — Report Only: This issue cannot be safely automated. ' +
        'The agent will report its findings and recommended manual steps, then stop.';
  }
}
