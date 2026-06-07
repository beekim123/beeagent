import { streamText, type ModelMessage } from 'ai';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { isRetryable, calculateDelay, sleep } from './retry.js';

const MAX_STEPS = 15;
const MAX_RETRIES = 3;

// budget 由外层 CLI 持有，这样多轮对话共享同一个 token 预算。
export interface BudgetState {
  used: number;
  limit: number;
}

export async function agentLoop(
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState,
) {
  let step = 0;

  // 每次处理一条用户输入时重置工具调用历史；避免上一轮对话影响本轮循环判断。
  resetHistory();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: any;
    let stepUsage: any;

    // 一次 step 内可能因为网络/API 抖动重试，但不会让 AI SDK 自己重试，
    // 这样所有重试日志和重试次数都由这里统一控制。
    for (let attempt = 1; ; attempt++) {
      let streamError: unknown;

      try {
        const result = streamText({
          model,
          system,
          tools,
          messages,
          maxRetries: 0,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: ({ error }) => {
            streamError = error;
          },
        });

        // fullStream 会按顺序给出文本、工具调用、工具结果等事件。
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === 'critical') {
                  shouldBreak = true;
                } else {
                  // warning 先尝试把模型拉回正轨；如果模型继续重复，会升级为 critical。
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }

              // detect 要先看“这次调用前”的历史，随后再把本次调用写入历史。
              recordCall(part.toolName, part.input);
              break;
            }

            case 'tool-result':
              console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                // 记录工具结果，用来判断“同样参数是否一直得到同样结果”。
                recordResult(lastToolCall.name, lastToolCall.input, part.output);
              }
              break;
          }
        }

        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        const effectiveError = streamError ?? error;
        if (attempt > MAX_RETRIES || !isRetryable(effectiveError)) throw effectiveError;
        const delay = calculateDelay(attempt);
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`);
        await sleep(delay);

        // 清掉本次失败 step 的临时状态，下一次 attempt 重新消费完整流。
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    // AI SDK 会把 assistant/tool 消息整理好，追加后模型下一步才能看到工具结果。
    messages.push(...stepResponse.messages);

    // Token 预算追踪：兼容不同 provider 的 usage 字段形状。
    const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : (stepUsage?.inputTokens?.total ?? 0);
    const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : (stepUsage?.outputTokens?.total ?? 0);
    budget.used += inp + out;
    const pct = Math.round(budget.used / budget.limit * 100);
    console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`);
    if (budget.used > budget.limit) {
      console.log('\n[Token 预算耗尽，强制停止]');
      break;
    }

    // 没有工具调用说明模型已经给出最终文本回复，本轮结束。
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log('  \u2192 继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}
