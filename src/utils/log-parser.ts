/**
 * Deploy Doctor — Log Parser
 *
 * Extracts error patterns from platform logs to help diagnosis.
 * Used by adapters to parse raw log output into structured findings.
 */

import type { FailureType } from '../types.js';

interface LogPattern {
  regex: RegExp;
  failureType: FailureType;
  description: string;
}

const PATTERNS: LogPattern[] = [
  // ── Build / Dependency errors ───────────────────────
  { regex: /ModuleNotFoundError|ImportError|Cannot find module/i, failureType: 'dependency_conflict', description: 'Missing module or dependency' },
  { regex: /pip install.*failed|npm ERR!|yarn error|pnpm ERR/i, failureType: 'dependency_conflict', description: 'Package installation failed' },
  { regex: /version.*conflict|incompatible|requires.*version/i, failureType: 'dependency_conflict', description: 'Version conflict' },
  { regex: /Build failed|build error|compilation error|SyntaxError/i, failureType: 'build_failure', description: 'Build or compilation failure' },

  // ── Runtime / Crash errors ──────────────────────────
  { regex: /SIGKILL|SIGTERM|OOMKilled|out of memory/i, failureType: 'crash_loop', description: 'Process killed (OOM or signal)' },
  { regex: /EADDRINUSE|address already in use|port.*bind/i, failureType: 'port_binding_error', description: 'Port binding conflict' },
  { regex: /ECONNREFUSED|connection refused/i, failureType: 'health_check_failure', description: 'Connection refused' },
  { regex: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i, failureType: 'timeout', description: 'Request or connection timeout' },

  // ── Auth / Quota errors ─────────────────────────────
  { regex: /401|Unauthorized|invalid.*token|token.*expired/i, failureType: 'auth_expired', description: 'Authentication token expired or invalid' },
  { regex: /403|Forbidden|access.*denied|permission.*denied/i, failureType: 'auth_revoked', description: 'Access forbidden — credentials revoked' },
  { regex: /429|rate.limit|too many requests/i, failureType: 'rate_limited', description: 'Rate limit exceeded' },
  { regex: /quota.*exceeded|billing|plan.*limit|usage.*limit/i, failureType: 'quota_exceeded', description: 'Quota or billing limit reached' },

  // ── Config / Env errors ─────────────────────────────
  { regex: /env.*not.*set|missing.*env|undefined.*variable|process\.env/i, failureType: 'env_misconfiguration', description: 'Missing or misconfigured environment variable' },
  { regex: /config.*error|invalid.*config|configuration/i, failureType: 'config_error', description: 'Configuration error' },
];

export interface LogAnalysis {
  failureType: FailureType;
  description: string;
  matchedLines: string[];
}

/**
 * Analyze raw log text and return the most likely failure type.
 * Returns all matches sorted by number of matched lines (most matches first).
 */
export function analyzeLogs(rawLogs: string): LogAnalysis[] {
  const lines = rawLogs.split('\n');
  const results = new Map<FailureType, LogAnalysis>();

  for (const line of lines) {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        const existing = results.get(pattern.failureType);
        if (existing) {
          existing.matchedLines.push(line.trim());
        } else {
          results.set(pattern.failureType, {
            failureType: pattern.failureType,
            description: pattern.description,
            matchedLines: [line.trim()],
          });
        }
      }
    }
  }

  return Array.from(results.values())
    .sort((a, b) => b.matchedLines.length - a.matchedLines.length);
}

/**
 * Get the primary failure type from logs, or 'unknown' if nothing matched.
 */
export function getPrimaryFailure(rawLogs: string): { failureType: FailureType; evidence: string[] } {
  const analyses = analyzeLogs(rawLogs);
  if (analyses.length === 0) {
    return { failureType: 'unknown', evidence: [] };
  }
  return {
    failureType: analyses[0].failureType,
    evidence: analyses[0].matchedLines.slice(0, 10), // cap evidence at 10 lines
  };
}
