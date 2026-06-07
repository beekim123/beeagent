import 'dotenv/config';
import { type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model';
import { createInterface } from 'node:readline';
import { ToolRegistry } from './tools/tool-registry';
import { allTools } from './tools/tools';
import { agentLoop } from './agent/loop';

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);

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

// readline 让这个脚本变成一个可交互的命令行聊天程序。
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

let isReadlineClosed = false;
rl.on('close', () => {
  isReadlineClosed = true;
});

// 保存完整对话历史；每次 agentLoop 结束后会追加 assistant/tool 消息。
const messages: ModelMessage[] = [];

const sys_prompt=`你是 Super Agent，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

    const historyLength = messages.length;

    // AI SDK 的 ModelMessage 可以直接用字符串；这里用 text part，方便 mock 模型统一解析。
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
    });

    try {
      await agentLoop(model, toolRegistry, messages, sys_prompt);
    } catch (error) {
      // 本轮失败时回滚用户消息，避免下一轮继续带着一条失败请求重试。
      messages.length = historyLength;
      console.error(`\n[错误] ${formatError(error)}`);
      console.error('[提示] 如果是在测试本地死循环熔断，可以使用 pnpm run start:mock。');
    }
   
    // 当前轮结束后再次等待用户输入，形成持续对话。
    if (!isReadlineClosed) ask();
  });
}

console.log('Super Agent v0.1 (type "exit" to quit)\n');
ask();
