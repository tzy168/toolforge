import fs from 'node:fs';
import { dirs, ensureDirs } from '../core/paths.js';
import type { Json, Tool } from '../types.js';

// MCP 适配器：把现成的 MCP 服务器当成工具源吃进来，解决冷启动。
// SDK 是可选依赖，没装也要能开机。

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Sdk {
  Client: any;
  StdioClientTransport: any;
}
let sdkCache: Sdk | false | null = null;

async function loadSdk(): Promise<Sdk | false> {
  if (sdkCache !== null) return sdkCache;
  try {
    const [clientMod, stdioMod] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    sdkCache = {
      Client: (clientMod as any).Client,
      StdioClientTransport: (stdioMod as any).StdioClientTransport,
    };
  } catch {
    sdkCache = false;
  }
  return sdkCache;
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
  error?: string;
}

export function readConfig(): McpConfig {
  ensureDirs();
  if (!fs.existsSync(dirs.mcpFile)) {
    const skeleton = {
      _说明: '把 MCP 服务器写进 servers，重启后其工具会出现在工具列表里',
      servers: {},
    };
    fs.writeFileSync(dirs.mcpFile, JSON.stringify(skeleton, null, 2), 'utf8');
    return { servers: {} };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(dirs.mcpFile, 'utf8')) as Partial<McpConfig>;
    return { servers: {}, ...cfg };
  } catch {
    return { servers: {}, error: 'mcp.json 解析失败' };
  }
}

function slug(input: string, max = 40): string {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
}

class McpManager {
  clients = new Map<string, any>();
  tools: Tool[] = [];
  status: Record<string, string> = {};
  available = false;

  async init(): Promise<Record<string, string>> {
    const sdk = await loadSdk();
    if (!sdk) {
      this.available = false;
      this.status = { _sdk: '未安装 @modelcontextprotocol/sdk，MCP 功能停用' };
      return this.status;
    }
    this.available = true;
    const cfg = readConfig();
    await Promise.all(Object.entries(cfg.servers || {}).map(([name, c]) => this.connect(name, c)));
    return this.status;
  }

  async connect(name: string, cfg: McpServerConfig): Promise<void> {
    const sdk = await loadSdk();
    if (!sdk) return;
    try {
      let command = cfg.command;
      let args = cfg.args || [];
      // Windows 上 npx / npm 是 .cmd 包装，必须经 cmd 转一手
      if (process.platform === 'win32' && /^(npx|npm|yarn|pnpm)$/.test(command)) {
        args = ['/c', command, ...args];
        command = 'cmd';
      }
      const transport = new sdk.StdioClientTransport({
        command,
        args,
        env: { ...process.env, ...(cfg.env || {}) },
        stderr: 'pipe',
      });
      const client = new sdk.Client({ name: 'toolforge', version: '0.1.0' }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = (await client.listTools()) as { tools: any[] };
      this.clients.set(name, client);

      for (const t of tools) {
        this.tools.push({
          id: `mcp:${name}:${t.name}`,
          name: slug(`${name}_${t.name}`),
          version: '0.0.0',
          description: `[MCP:${name}] ${t.description || t.name}`,
          kind: 'mcp',
          input: t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} },
          impl: { server: name, remoteName: t.name },
          permissions: { net: [], fsRead: [], fsWrite: [], exec: false, env: [] },
          examples: [{ name: '外部工具无需本地用例', args: {}, expect: null }],
          meta: { tags: ['mcp', name], author: 'mcp', source: 'mcp', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          status: 'active',
          trust: 'L1',
          sessionId: null,
        });
      }
      this.status[name] = `已连接，${tools.length} 个工具`;
    } catch (err) {
      this.status[name] = `连接失败：${(err as Error).message}`;
    }
  }

  async call(server: string, remoteName: string, args: Json): Promise<unknown> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP 服务器 ${server} 未连接`);
    const res: any = await client.callTool({ name: remoteName, arguments: args || {} });
    const parts: any[] = Array.isArray(res?.content) ? res.content : [];
    const text = parts
      .map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[图片]' : JSON.stringify(p)))
      .join('\n');
    if (res?.isError) throw new Error(text || 'MCP 工具返回错误');
    return text || res;
  }

  listTools(): Tool[] {
    return this.tools;
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        /* 关闭失败无碍 */
      }
    }
    this.clients.clear();
  }
}

export const mcp = new McpManager();

export async function callMcpTool(tool: Tool, args: Json): Promise<unknown> {
  return mcp.call(tool.impl.server ?? '', tool.impl.remoteName ?? tool.name, args);
}
