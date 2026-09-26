/**
 * Deploy Doctor — API Client
 *
 * Simple HTTP client with retries and error handling.
 * Used by all adapters to call platform APIs.
 */

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

export async function apiRequest<T = unknown>(
  url: string,
  options: ApiRequestOptions = {},
): Promise<ApiResponse<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 15000,
    retries = 2,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'DeployDoctor/1.0',
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      let data: T;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = (await response.json()) as T;
      } else {
        data = (await response.text()) as unknown as T;
      }

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          data,
          error: `HTTP ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
        };
      }

      return { ok: true, status: response.status, data };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on abort (timeout) or non-retryable errors
      if (lastError.message.includes('abort')) {
        return {
          ok: false,
          status: 0,
          data: null as unknown as T,
          error: `Request timeout after ${timeoutMs}ms`,
        };
      }

      // Wait before retry (simple backoff)
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  return {
    ok: false,
    status: 0,
    data: null as unknown as T,
    error: lastError?.message ?? 'Unknown error',
  };
}
