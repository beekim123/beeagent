export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || '';
  const statusMatch = message.match(/(\d{3})/);

  // HTTP 429/5xx 和常见网络错误通常是临时问题，可以交给 agentLoop 重试。
  if (statusMatch) {
    const status = parseInt(statusMatch[1]);
    if ([429, 529, 408].includes(status)) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
  if (message.includes('fetch failed') || message.includes('network')) return true;
  if (message.includes('No output generated')) return true;
  return false;
}

// --- 指数退避 + 随机抖动 ---
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);

  // 加一点 jitter，避免多个请求在同一时间点一起重试。
  const jitter = capped * 0.25;
  return Math.max(0, Math.round(capped + (Math.random() * 2 - 1) * jitter));
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
