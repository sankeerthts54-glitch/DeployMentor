/**
 * Deploy Doctor — Health Checker
 *
 * Simple HTTP probe: GET a URL, check status code and response time.
 * Used by all adapters for post-fix verification.
 */

import type { HealthCheck } from '../types.js';

export async function checkHealth(
  url: string,
  timeoutMs: number = 10000,
): Promise<HealthCheck> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'DeployDoctor/1.0' },
    });

    clearTimeout(timer);
    const elapsed = Date.now() - start;

    return {
      url,
      status_code: response.status,
      response_time_ms: elapsed,
      healthy: response.status >= 200 && response.status < 400,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);

    return {
      url,
      status_code: null,
      response_time_ms: elapsed,
      healthy: false,
      error: message.includes('abort') ? `Timeout after ${timeoutMs}ms` : message,
    };
  }
}
