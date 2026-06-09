import 'dotenv/config';
import { type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';
import { ToolRegistry } from './tools/tool-registry';
import { allTools } from './tools/tools';
import { agentLoop } from './agent/loop';
import { SessionStore } from './session/store';
import {
  PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext,
  type PromptContext,
} from './context/prompt-builder';
import { estimateMessageTokens, applyDefense } from './context/defense';

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);

function printToolStats(): void {
  const stats = toolRegistry.getToolStats();

  console.log('\n=== 工具统计 ===');
  console.log(`  全部工具: ${stats.total} 个`);
  console.log(`  活跃工具: ${stats.active} 个`);
  console.log(`  Token 估算: ~${stats.estimatedTokens.active}`);
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

function injectDefenseDemoHistory(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): void {
  const now = Date.now();
  const rounds = [
    { ageMs: 12 * 60 * 1000, path: 'src/index.ts' },
    { ageMs: 7 * 60 * 1000, path: 'src/context/defense.ts' },
    { ageMs: 60 * 1000, path: 'sample-data.txt' },
  ];

  for (const [index, round] of rounds.entries()) {
    const base = messages.length;
    messages.push({ role: 'user', content: `第 ${index + 1} 轮：读一下 ${round.path}` });
    timestamps.set(base, now - round.ageMs);
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool-call' as const,
        toolCallId: `defense-demo-${index}`,
        toolName: 'read_file',
        input: { path: round.path },
      }],
    });
    timestamps.set(base + 1, now - round.ageMs);
    messages.push({
      role: 'tool',
      content: [{
        type: 'tool-result' as const,
        toolCallId: `defense-demo-${index}`,
        toolName: 'read_file',
        output: {
          type: 'text' as const,
          value: `// ${round.path}\n${'export const demo = "context-defense";\n'.repeat(220)}`,
        },
      }],
    });
    timestamps.set(base + 2, now - round.ageMs);
    messages.push({
      role: 'assistant',
      content: [{ type: 'text' as const, text: `${round.path} 已读取。` }],
    });
    timestamps.set(base + 3, now - round.ageMs);
  }
}

async function main() {
  printToolStats();

  const isContinue = process.argv.includes('--continue');
  const sessionId = 'default';
  const store = new SessionStore(sessionId);
  const timestamps = new Map<number, number>();

  // Session 持久化
  let messages: ModelMessage[] = [];
  if (isContinue && store.exists()) {
    messages = store.load();
    const now = Date.now();
    for (let i = 0; i < messages.length; i++) timestamps.set(i, now);
    console.log(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`);
  } else {
    console.log(`\n[Session] 新会话 "${sessionId}"`);
  }

  const promptBuilder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext());

  const buildSystemPrompt = (): string => {
    const promptCtx: PromptContext = {
      toolCount: toolRegistry.getActiveTools().length,
      deferredToolSummary: '',
      sessionMessageCount: messages.length,
      sessionId,
    };

    return promptBuilder.build(promptCtx);
  };

  const runDefense = (): void => {
    const before = estimateMessageTokens(messages);
    const result = applyDefense(messages, timestamps);
    messages = result.messages;

    console.log(`  [Defense] 截断: ${result.truncated}, 预算清理: ${result.compacted}`);
    console.log(`  [Defense] 软修剪: ${result.softPruned}, 硬清除: ${result.hardPruned}`);
    console.log(`  [Token] ~${before} -> ~${result.tokenEstimate}`);

    if (result.truncated > 0 || result.compacted > 0 || result.softPruned > 0 || result.hardPruned > 0) {
      store.replaceAll(messages);
    }
  };

  // readline 让这个脚本变成一个可交互的命令行聊天程序。
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let isReadlineClosed = false;
  rl.on('close', () => {
    isReadlineClosed = true;
  });

  function handleQuickTrigger(input: string): boolean {
    if (input === '模拟长对话' || input === 'sim') {
      injectDefenseDemoHistory(messages, timestamps);
      console.log(`\n[模拟] 已注入 ${messages.length} 条消息，当前约 ~${estimateMessageTokens(messages)} tokens\n`);
      return true;
    }

    if (input === '执行防线' || input === 'defend') {
      console.log('\n--- 执行防线 ---');
      runDefense();
      console.log();
      return true;
    }

    if (input === '查看状态' || input === 'status') {
      const toolMsgCount = messages.filter(msg => msg.role === 'tool').length;
      console.log(`\n[状态] ${messages.length} 条消息，${toolMsgCount} 条工具结果，约 ~${estimateMessageTokens(messages)} tokens\n`);
      return true;
    }

    return false;
  }

  function ask() {
    if (isReadlineClosed) return;

    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        rl.close();
        return;
      }

      if (handleQuickTrigger(trimmed)) {
        ask();
        return;
      }

      const userMsg: ModelMessage = {
        role: 'user',
        content: trimmed,
      };
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      const beforeLen = messages.length;

      try {
        await agentLoop(model, toolRegistry, messages, buildSystemPrompt());
        const newMessages = messages.slice(beforeLen);
        const now = Date.now();
        for (let i = beforeLen; i < messages.length; i++) {
          timestamps.set(i, now);
        }
        store.appendAll(newMessages);
        runDefense();
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

  console.log('Super Agent v0.9 — Context Defense (type "exit" to quit)');
  console.log('快捷命令：');
  console.log('  模拟长对话 / sim    — 注入带时间跨度的大工具结果');
  console.log('  执行防线 / defend   — 执行截断和 TTL 修剪');
  console.log('  查看状态 / status   — 查看当前消息数和 token 估算\n');
  promptBuilder.debug({
    toolCount: toolRegistry.getActiveTools().length,
    deferredToolSummary: '',
    sessionMessageCount: messages.length,
    sessionId,
  });
  ask();
}

main().catch(console.error);
