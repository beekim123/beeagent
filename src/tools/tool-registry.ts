import { jsonSchema } from 'ai';
// 手写 JSON-RPC 版保留在这里，必要时可以切回：
// import type { MCPClient, MockMCPClient } from '../mcp/mcp-clinet';
import type { MCPClient, MockMCPClient } from '../mcp/mcp-client';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // 延迟工具默认不会进入模型 prompt；先通过 tool_search 命中后才激活。
  // 典型场景是 MCP server 暴露几十个工具，但用户本轮只可能用到其中一两个。
  shouldDefer?: boolean;
  // 给 tool_search 的轻量搜索文本，避免把完整 schema 全塞进 prompt。
  // 它应该包含服务名、动作、对象类型等关键词，比如 "github list issues repository"。
  searchHint?: string;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private mcpClients: Array<MCPClient | MockMCPClient> = [];
  // 被 tool_search 找到过的延迟工具会记录在这里。
  // 只要进入这个集合，它就会从 deferred 状态变成 active 状态，并在下一次 toAISDKFormat() 中暴露给模型。
  private discoveredTools = new Set<string>();

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false;          // 当前是否有独占锁持有者
  private concurrentCount = 0;            // 当前共享锁持有数
  private waitQueue: Array<() => void> = [];  // 阻塞等待中的 resolve 函数

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      // 同名工具后注册会覆盖先注册的版本。
      // 这让测试时替换 mock 工具比较方便，但后续如果要严格防重复，可以在这里抛错。
      this.tools.set(tool.name, tool);
    }
  }

  async registerMCPServer(
    serverName: string,
    client: MCPClient | MockMCPClient,
  ): Promise<string[]> {
    // MCP client 先建立连接，再询问 server 支持哪些工具。
    // 这里不关心 client 内部是官方 SDK 还是手写 JSON-RPC，只依赖统一接口。
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      // 用 mcp__server__tool 的格式加命名空间，避免不同 MCP server 的工具重名。
      // 例如 GitHub 和 GitLab 都可能有 list_issues。
      const prefixedName = `mcp__${serverName}__${tool.name}`;

      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        // MCP 工具默认延迟加载。否则像 GitHub 这种 server 一次暴露几十个工具，
        // 每轮都把所有 schema 发给模型，会明显增加 token 消耗。
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        execute: async (input: any) => {
          // AI SDK 看到的是 prefixedName；真实 MCP server 只认识 originalName。
          // 所以执行时要把 mcp__github__list_issues 映射回 list_issues。
          return toolClient.callTool(originalName, input);
        },
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    // CLI 退出时必须关闭 MCP 子进程，否则 readline 结束后 Node 进程仍可能挂住。
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    // 返回数组副本，避免调用方直接修改内部 Map。
    return Array.from(this.tools.values());
  }

  // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  // 获取独占锁：必须等所有共享锁释放、且没人持独占
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};

    // 只把活跃工具发给模型；延迟工具先隐藏，减少 prompt 中的 schema/token。
    // 这一步是延迟加载真正生效的位置：
    // - getAll() 是 registry 知道的全部工具。
    // - getActiveTools() 是本轮真正交给模型的工具。
    // - shouldDefer 且未 discovered 的工具不会出现在这里。
    for (const tool of this.getActiveTools()) {
      const { name } = tool;
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 在真正执行前先按 isConcurrencySafe 获取锁
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            // 不管成功还是抛异常，锁都要释放
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }

  searchTools(query: string): ToolDefinition[] {
    // 支持两种查询方式：
    // 1. 精确工具名：mcp__github__list_issues
    // 2. 关键词短语：github list issues
    // 多个查询可以用逗号隔开，比如：
    // mcp__github__list_issues, notion search pages
    const queries = query
      .split(',')
      .map(term => term.trim().toLowerCase())
      .filter(Boolean);

    if (queries.length === 0) return [];

    const matches: ToolDefinition[] = [];
    const seen = new Set<string>();

    const addMatch = (tool: ToolDefinition) => {
      if (seen.has(tool.name)) return;
      seen.add(tool.name);
      matches.push(tool);
      // 激活是 searchTools 的关键副作用。下一轮 toAISDKFormat() 会把这些工具注入 AI SDK tools。
      this.discoveredTools.add(tool.name);
    };

    for (const tool of this.tools.values()) {
      if (tool.name === 'tool_search') continue;

      const toolName = tool.name.toLowerCase();
      const haystack = [
        tool.name,
        tool.description,
        tool.searchHint ?? '',
      ].join(' ').toLowerCase();

      for (const item of queries) {
        if (toolName === item) {
          // 精确工具名优先，适合模型从延迟工具摘要里直接复制工具名。
          addMatch(tool);
          break;
        }

        // 非精确工具名查询时，要求查询词全部命中，避免一个宽泛词激活太多工具。
        // 例如 "github" 太宽泛，不应该激活所有 GitHub 工具；
        // "github list issues" 更具体，才会命中 list_issues。
        const words = item.split(/\s+/).filter(Boolean);
        if (words.length > 0 && words.every(word => haystack.includes(word))) {
          addMatch(tool);
          break;
        }
      }
    }

    return matches;
  }

  getActiveTools(): ToolDefinition[] {
    // 活跃工具 = 普通工具 + 已被 tool_search 发现的延迟工具。
    // tool_search 本身不要标 shouldDefer，否则模型永远没有入口激活其他工具。
    return this.getAll().filter(tool => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      return true;
    });
  }

  getDeferredToolSummary(): string {
    // 这段摘要会拼进 system prompt。
    // 它只包含工具名和 searchHint，不包含完整参数 schema，因此比直接暴露 tools 便宜很多。
    const deferred = this.getAll().filter(tool => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return '';

    const lines = deferred.map(t => {
      const hint = t.searchHint ? ` - ${t.searchHint}` : '';
      return `- ${t.name}${hint}`;
    });

    return [
      '',
      '以下工具可用，但当前为延迟加载。需要使用时，先调用 tool_search 获取完整定义：',
      ...lines,
    ].join('\n');
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    // 粗略按 4 字符约等于 1 token 估算 schema 成本。
    // 这里的目的不是精确计费，而是看延迟加载前后 token 规模是否明显下降。
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }

  getToolStats(): { total: number; active: number; deferred: number; estimatedTokens: { active: number; deferred: number; total: number } } {
    // 启动时打印这个统计，可以直接看到：
    // 1. registry 知道多少工具。
    // 2. 本轮真正暴露给模型多少工具。
    // 3. 有多少工具被 defer，暂时不占 AI SDK tools schema。
    const total = this.getAll().length;
    const active = this.getActiveTools().length;
    return {
      total,
      active,
      deferred: total - active,
      estimatedTokens: this.countTokenEstimate(),
    };
  }
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
