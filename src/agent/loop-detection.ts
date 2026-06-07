import { createHash } from 'node:crypto';

// 每次工具调用都会被压成一条 record；参数和结果都用 hash 存，避免日志里保存大对象。
export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

export type DetectionResult =
  | { stuck: false }
  | { stuck: true; level: 'warning' | 'critical'; detector: DetectorKind; count: number; message: string };

const HISTORY_SIZE = 30;
const WARNING_THRESHOLD = 5;
const CRITICAL_THRESHOLD = 8;
const BREAKER_THRESHOLD = 10;

// JSON.stringify 对对象 key 顺序敏感；这里先排序 key，保证语义相同的参数得到同一个 hash。
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

// 截断 hash 只用于循环检测，不用于安全校验；16 位足够降低日志和比较成本。
function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

const history: ToolCallRecord[] = [];

export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });

  // 只保留最近一小段历史，避免长时间运行时内存持续增长。
  if (history.length > HISTORY_SIZE) history.shift();
}

export function recordResult(toolName: string, params: unknown, result: unknown): void {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);

  // 从后往前找最近一次还没有结果的同参数调用，把结果补上。
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash && !history[i].resultHash) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

export function resetHistory(): void {
  history.length = 0;
}

function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0;
  let lastResultHash: string | undefined;

  // “无进展”指同一个工具、同一组参数，连续拿到完全相同的结果。
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
    if (!r.resultHash) continue;
    if (!lastResultHash) { lastResultHash = r.resultHash; streak = 1; continue; }
    if (r.resultHash !== lastResultHash) break;
    streak++;
  }
  return streak;
}

function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0;
  const last = history[history.length - 1];
  let otherHash: string | undefined;

  // 找到最近的另一个参数 hash，用来判断 A/B/A/B 这种交替调用。
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) { otherHash = history[i].argsHash; break; }
  }
  if (!otherHash) return 0;

  // 从尾部往前数，只要顺序不再符合 A/B 交替就停止。
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }
  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(toolName, argsHash);

  // 最强规则：同参同结果重复太多次，说明工具调用没有产生新信息，直接熔断。
  if (noProgress >= BREAKER_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'global_circuit_breaker', count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止` };
  }

  // A/B 参数来回切换也是常见死循环，比如不断查北京、上海、北京、上海。
  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'ping_pong', count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止` };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return { stuck: true, level: 'warning', detector: 'ping_pong', count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路` };
  }

  // 通用兜底：只看同一个工具+同一组参数在最近历史里出现了多少次。
  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;
  if (recentCount >= CRITICAL_THRESHOLD) {
    return { stuck: true, level: 'critical', detector: 'generic_repeat', count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止` };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return { stuck: true, level: 'warning', detector: 'generic_repeat', count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复` };
  }

  return { stuck: false };
}
