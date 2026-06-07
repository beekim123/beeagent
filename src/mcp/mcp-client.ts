import { Client as SDKClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type MCPContent = {
  type: string;
  text?: string;
  resource?: { text?: string; uri?: string; mimeType?: string };
};

export class MCPClient {
  private client: SDKClient | null = null;
  private transport: StdioClientTransport | null = null;
  private stderrTail = '';

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });

    const client = new SDKClient({ name: 'super-agent', version: '1.0.0' });
    this.transport = transport;
    this.client = client;

    try {
      await client.connect(transport);
    } catch (error) {
      await this.close();
      const stderr = this.stderrTail.trim();
      const detail = stderr ? `\nMCP stderr:\n${stderr}` : '';
      if (error instanceof Error) {
        throw new Error(`${error.message}${detail}`);
      }
      throw error;
    }
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.getClient().listTools();
    return (result.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.getClient().callTool({ name, arguments: args }) as any;

    if ('toolResult' in result) {
      return formatUnknown(result.toolResult);
    }

    const texts = (result.content || [])
      .map(formatContent)
      .filter(Boolean);

    const body = texts.join('\n') ||
      (result.structuredContent ? JSON.stringify(result.structuredContent, null, 2) : '') ||
      '(无返回内容)';

    return result.isError ? `MCP 工具返回错误:\n${body}` : body;
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;

    try {
      await client?.close();
    } finally {
      await transport?.close().catch(() => {});
    }
  }

  private getClient(): SDKClient {
    if (!this.client) throw new Error('MCP client is not connected');
    return this.client;
  }
}

export class MockMCPClient {
  async connect(): Promise<void> {}

  async listTools(): Promise<MCPTool[]> {
    return [
      {
        name: 'list_issues',
        description: '列出 GitHub 仓库的 Issues',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '仓库所有者' },
            repo: { type: 'string', description: '仓库名称' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'search_repositories',
        description: '搜索 GitHub 仓库',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_file_contents',
        description: '获取仓库中文件的内容',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '仓库所有者' },
            repo: { type: 'string', description: '仓库名称' },
            path: { type: 'string', description: '文件路径' },
          },
          required: ['owner', 'repo', 'path'],
        },
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'list_issues':
        return JSON.stringify([
          { number: 42, title: '支持 MCP 协议接入', state: 'open', labels: ['enhancement'] },
          { number: 41, title: '循环检测阈值可配置化', state: 'open', labels: ['feature'] },
          { number: 39, title: 'Token 预算用完后的优雅降级', state: 'closed', labels: ['bug'] },
        ], null, 2);
      case 'search_repositories':
        return JSON.stringify([
          { full_name: 'anthropics/anthropic-sdk-python', stars: 2800, description: 'Anthropic Python SDK' },
          { full_name: 'vercel/ai', stars: 12000, description: 'AI SDK for TypeScript' },
          { full_name: 'modelcontextprotocol/servers', stars: 5600, description: 'MCP Servers' },
        ], null, 2);
      case 'get_file_contents':
        return `# README\n\nThis is a mock file content for ${args.owner}/${args.repo}/${args.path}`;
      default:
        return `未知工具: ${name}`;
    }
  }

  async close(): Promise<void> {}
}

function formatContent(content: MCPContent): string {
  if (content.type === 'text' && content.text) return content.text;
  if (content.type === 'resource' && content.resource?.text) return content.resource.text;
  return '';
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
