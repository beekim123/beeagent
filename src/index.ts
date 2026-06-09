import 'dotenv/config';
import { type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';
import { ToolRegistry, type ToolDefinition } from './tools/tool-registry';
import { allTools } from './tools/tools';
import { agentLoop } from './agent/loop';
import { SessionStore } from './session/store';
import {
  PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext,
  type PromptContext,
} from './context/prompt-builder';
import { microcompact, summarize, estimateTokens } from './context/compressor';
// 手写 JSON-RPC 版保留在这里，必要时可以切回：
// import { MCPClient, MockMCPClient } from './mcp/mcp-clinet';
import { MCPClient, MockMCPClient } from './mcp/mcp-client';

// 全局只有一个 registry：
// 1. 启动时注册本地工具、MCP 工具、模拟 MCP 工具。
// 2. 每轮 agentLoop 都从这里拿“当前活跃工具”转成 AI SDK tools。
// 3. tool_search 会修改 registry 内部的 discoveredTools，从而让延迟工具在下一轮变成活跃工具。
const toolRegistry = new ToolRegistry();

// tool_search 是唯一始终暴露给模型的“工具目录”。
// 这里要解决的问题是：MCP 工具可能非常多，如果全部把 description + schema 塞给模型，
// 每一轮 prompt 都会浪费很多 token。延迟加载的策略是：
// 1. 默认只暴露 tool_search 和本地基础工具。
// 2. system prompt 只给模型一份很轻量的“延迟工具名称 + searchHint”列表。
// 3. 模型需要某个工具时，先调用 tool_search。
// 4. tool_search 返回完整 schema，并把这些工具标记为 discovered。
// 5. 下一轮 agentLoop 调用 toAISDKFormat() 时，这些工具才真正进入 AI SDK tools。
const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    // searchTools 不只是查询：它还会把命中的工具写入 discoveredTools。
    // 这就是“搜索后激活”的关键副作用。
    const results = toolRegistry.searchTools(query);
    if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;

    // 返回完整参数 schema 给模型。模型本轮拿到结果后，下一轮才能实际调用这些工具，
    // 因为 AI SDK 的 tools 列表是在每次 streamText() 开始前固定下来的。
    return results.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};

toolRegistry.register(toolSearchTool, ...allTools);

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  // 在浏览器/WebContainer 等环境里可能不能 spawn 子进程。
  // 这里先探测一次，避免直接启动 npx MCP server 时抛出更难懂的错误。
  let canSpawn = true;
  try {
    const { execSync } = await import('node:child_process');
    execSync('echo test', { stdio: 'ignore' });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log('\n连接 GitHub MCP Server...');
    try {
      // 真实 GitHub MCP server 通过 stdio 和当前进程通信。
      // MCPClient 内部使用官方 SDK 的 StdioClientTransport。
      const client = new MCPClient(
        'npx', ['-y', '@modelcontextprotocol/server-github'],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      );

      // registerMCPServer 会把 GitHub server 暴露的工具统一注册成：
      // mcp__github__工具名
      // 当前为了测试延迟加载，显式标记 shouldDefer，避免 GitHub 的几十个工具一次性进入 prompt。
      const tools = await toolRegistry.registerMCPServer('github', client, { shouldDefer: true });
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      await toolRegistry.closeAllMCP();
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
      console.log('  降级为 Mock MCP...');
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
  }

  // 没有 token 或真实 MCP 连接失败时，用 MockMCPClient 保证演示流程还能跑。
  // Mock 工具同样走 registerMCPServer，所以可以复用同一套延迟加载测试逻辑。
  const mockClient = new MockMCPClient();
  const tools = await toolRegistry.registerMCPServer('github', mockClient, { shouldDefer: true });
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// 模拟额外的 MCP 工具，用来观察“工具很多时 prompt token 膨胀”的问题。
// 这些工具都标记 shouldDefer，默认不会进入 AI SDK tools；命中 tool_search 后才会激活。
function registerSimulatedTools() {
  const simulatedTools: ToolDefinition[] = [
    {
      name: 'mcp__notion__search_pages',
      description: '[MCP:notion] 搜索 Notion 页面',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      shouldDefer: true,
      searchHint: 'notion search pages documents',
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ query }: any) => JSON.stringify([{ title: `Mock: ${query}`, id: 'page-001' }]),
    },
    {
      name: 'mcp__notion__create_page',
      description: '[MCP:notion] 创建 Notion 页面',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title'],
      },
      shouldDefer: true,
      searchHint: 'notion create page document note',
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ title, content = '' }: any) => JSON.stringify({
        id: 'page-created-001',
        title,
        contentLength: String(content).length,
      }),
    },
    {
      name: 'mcp__notion__list_databases',
      description: '[MCP:notion] 列出 Notion 数据库',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: [] },
      shouldDefer: true,
      searchHint: 'notion list databases tables workspace',
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ query = '' }: any) => JSON.stringify([
        { id: 'db-001', title: query ? `Mock DB: ${query}` : 'Engineering Notes' },
        { id: 'db-002', title: 'Roadmap' },
      ]),
    },
    {
      name: 'mcp__browser__navigate',
      description: '[MCP:browser] 打开指定网页',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      shouldDefer: true,
      searchHint: 'browser navigate open url page',
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ url }: any) => JSON.stringify({ url, status: 'navigated' }),
    },
    {
      name: 'mcp__browser__screenshot',
      description: '[MCP:browser] 获取当前页面截图',
      parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: [] },
      shouldDefer: true,
      searchHint: 'browser screenshot capture page element',
      isConcurrencySafe: false,
      isReadOnly: true,
      execute: async ({ selector = 'page' }: any) => JSON.stringify({
        selector,
        image: 'mock-screenshot://browser/page.png',
      }),
    },
    {
      name: 'mcp__browser__click',
      description: '[MCP:browser] 点击页面元素',
      parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
      shouldDefer: true,
      searchHint: 'browser click element button link',
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ selector }: any) => JSON.stringify({ selector, clicked: true }),
    },
    {
      name: 'mcp__browser__fill',
      description: '[MCP:browser] 填写页面输入框',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['selector', 'text'],
      },
      shouldDefer: true,
      searchHint: 'browser fill input textarea form',
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ selector, text }: any) => JSON.stringify({
        selector,
        filledLength: String(text).length,
      }),
    },
    {
      name: 'mcp__browser__get_text',
      description: '[MCP:browser] 读取页面文本',
      parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: [] },
      shouldDefer: true,
      searchHint: 'browser get text read page content element',
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ selector = 'body' }: any) => JSON.stringify({
        selector,
        text: 'Mock browser page text content.',
      }),
    },
    {
      name: 'mcp__supabase__query',
      description: '[MCP:supabase] 执行 Supabase SQL 查询',
      parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
      shouldDefer: true,
      searchHint: 'supabase query sql database rows',
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ sql }: any) => JSON.stringify({
        sql,
        rows: [{ id: 1, name: 'mock-row' }],
      }),
    },
    {
      name: 'mcp__supabase__list_tables',
      description: '[MCP:supabase] 列出 Supabase 数据表',
      parameters: { type: 'object', properties: { schema: { type: 'string' } }, required: [] },
      shouldDefer: true,
      searchHint: 'supabase list tables schema database',
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ schema = 'public' }: any) => JSON.stringify([
        { schema, table: 'users' },
        { schema, table: 'projects' },
      ]),
    },
    {
      name: 'mcp__supabase__describe_table',
      description: '[MCP:supabase] 查看 Supabase 数据表结构',
      parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
      shouldDefer: true,
      searchHint: 'supabase describe table columns schema',
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ table }: any) => JSON.stringify({
        table,
        columns: [
          { name: 'id', type: 'uuid' },
          { name: 'created_at', type: 'timestamp' },
        ],
      }),
    },
  ];

  toolRegistry.register(...simulatedTools);
  return simulatedTools.length;
}

function printToolStats(simulatedToolCount: number): void {
  const stats = toolRegistry.getToolStats();

  // 这里的 token 只是粗略估算，用来观察“schema 体积”变化。
  // 真正的 provider 计费 token 会受模型 tokenizer、系统提示、消息历史等因素影响。
  console.log(`  已注册 ${simulatedToolCount} 个模拟延迟 MCP 工具`);
  console.log('\n=== 工具统计 ===');
  console.log(`  全部工具: ${stats.total} 个`);
  console.log(`  活跃工具: ${stats.active} 个`);
  console.log(`  延迟工具: ${stats.deferred} 个`);
  console.log(
    `  Token 估算: ~${stats.estimatedTokens.active} 活跃 + ~${stats.estimatedTokens.deferred} 延迟未注入`,
  );
}


const dashscopeApiKey = process.env.DASHSCOPE_API_KEY?.trim();
const hasDashScopeKey = Boolean(dashscopeApiKey && !/\s/.test(dashscopeApiKey));

if (dashscopeApiKey && !hasDashScopeKey) {
  console.warn('[配置提示] DASHSCOPE_API_KEY 看起来不像有效 key，已切换到本地 mock 模型。');
}

// 用 OpenAI 兼容接口接入阿里云 DashScope，模型名仍然由下面的 qwen.chat 指定。
const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: dashscopeApiKey,
});

// 没有配置 DASHSCOPE_API_KEY 时走本地 mock，保证项目不依赖真实 API 也能演示流程。
const model = hasDashScopeKey
  ? qwen.chat('qwen-plus-latest')
  : createMockModel();

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const SUMMARY_PREFIX = '[以下是之前对话的压缩摘要]';
const SUMMARY_SUFFIX = '[摘要结束，以下是最近的对话]';
const COMPACTION_TRIGGER_TOKENS = 1000;

function extractSummary(messages: ModelMessage[]): string {
  const first = messages[0];
  if (!first || first.role !== 'user' || typeof first.content !== 'string') return '';
  if (!first.content.startsWith(SUMMARY_PREFIX)) return '';

  const content = first.content.slice(SUMMARY_PREFIX.length).trimStart();
  const endIndex = content.indexOf(SUMMARY_SUFFIX);
  if (endIndex === -1) return '';

  return content.slice(0, endIndex).trim();
}

async function main() {
  await connectMCP();

  // 模拟工具要在 MCP 连接后注册，这样统计里能同时看到真实 GitHub MCP 工具和模拟工具。
  const simulatedToolCount = registerSimulatedTools();
  printToolStats(simulatedToolCount);

  const isContinue = process.argv.includes('--continue');
  const sessionId = 'default';
  const store = new SessionStore(sessionId);

  // Session 持久化
  let messages: ModelMessage[] = [];
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`);
  } else {
    console.log(`\n[Session] 新会话 "${sessionId}"`);
  }
  let summary = extractSummary(messages);

  const promptBuilder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext());

  const buildSystemPrompt = (): string => {
    const promptCtx: PromptContext = {
      toolCount: toolRegistry.getActiveTools().length,
      deferredToolSummary: toolRegistry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId,
    };

    return promptBuilder.build(promptCtx);
  };

  const compactIfNeeded = async (): Promise<void> => {
    const currentTokens = estimateTokens(messages);
    if (currentTokens <= COMPACTION_TRIGGER_TOKENS) return;

    console.log(`\n  [压缩检查] ~${currentTokens} tokens, 触发压缩...`);

    const microcompactResult = microcompact(messages);
    messages = microcompactResult.messages;
    if (microcompactResult.cleared > 0) {
      console.log(`  [Microcompact] 清理了 ${microcompactResult.cleared} 个工具结果`);
    }

    const summarizeResult = await summarize(model, messages, summary);
    if (summarizeResult.compressedCount > 0) {
      messages = summarizeResult.messages;
      summary = summarizeResult.summary;
      console.log(
        `  [Summarization] 压缩了 ${summarizeResult.compressedCount} 条消息, ~${estimateTokens(messages)} tokens`,
      );
    }

    if (microcompactResult.cleared > 0 || summarizeResult.compressedCount > 0) {
      store.replaceAll(messages);
    }
  };

  await compactIfNeeded();

  // readline 让这个脚本变成一个可交互的命令行聊天程序。
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let isReadlineClosed = false;
  rl.on('close', () => {
    isReadlineClosed = true;
  });

  function ask() {
    if (isReadlineClosed) return;

    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        await toolRegistry.closeAllMCP();
        rl.close();
        return;
      }

      const userMsg: ModelMessage = {
        role: 'user',
        content: trimmed,
      };
      messages.push(userMsg);
      store.append(userMsg);

      const beforeLen = messages.length;

      try {
        await agentLoop(model, toolRegistry, messages, buildSystemPrompt());
        const newMessages = messages.slice(beforeLen);
        store.appendAll(newMessages);
        await compactIfNeeded();
      } catch (error) {
        // 用户消息已经写入 session；这里只回滚本轮可能产生的不完整 assistant/tool 消息。
        messages.length = beforeLen;
        console.error(`\n[错误] ${formatError(error)}`);
        console.error('[提示] 如果是在测试本地死循环熔断，可以使用 pnpm run start:mock。');
      }

      // 当前轮结束后再次等待用户输入，形成持续对话。
      if (!isReadlineClosed) ask();
    });
  }

  console.log('Super Agent v0.1 (type "exit" to quit)\n');
  promptBuilder.debug({
    toolCount: toolRegistry.getActiveTools().length,
    deferredToolSummary: toolRegistry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  });
  ask();
}

main().catch(console.error);
