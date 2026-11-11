import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { renderDeep, renderString, extractPath, type Scope } from '../core/template.js';
import { assertNet, execAllowed, pickEnv } from '../core/permissions.js';
import { classifyCommand } from '../core/policy.js';
import type { DeclarativeContext, Json, Tool } from '../types.js';

// 声明式执行器：八成工具不需要写代码，走这里。
// 宿主全程代理 IO，工具本身碰不到网络与文件系统。
// 命令的黑白名单在 core/policy.ts 一份，这里只做二次校验，不另立一套规则。

/** 需要手动逐跳校验域名的重定向状态码 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

export async function runDeclarative(tool: Tool, input: Json, ctx: DeclarativeContext): Promise<unknown> {
  const scope: Scope = { input, now: new Date().toISOString(), env: pickEnv(tool) };
  switch (tool.kind) {
    case 'http':
      return runHttp(tool, scope);
    case 'transform':
      return runTransform(tool, input);
    case 'shell':
      return runShell(tool, scope, ctx);
    case 'compose':
      return runCompose(tool, scope, ctx);
    default:
      throw new Error(`声明式执行器不认识 kind=${tool.kind}`);
  }
}

async function runHttp(tool: Tool, scope: Scope): Promise<unknown> {
  const impl = tool.impl;
  const url = new URL(renderString(impl.url, scope));
  for (const [k, v] of Object.entries(impl.query || {})) {
    url.searchParams.set(k, renderString(v, scope));
  }

  const headers = renderDeep<Record<string, string>>(impl.headers || {}, scope);
  const body = impl.body == null ? undefined : JSON.stringify(renderDeep(impl.body, scope));
  if (body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  const init = {
    method: impl.method,
    headers,
    body: impl.method === 'GET' || impl.method === 'HEAD' ? undefined : body,
    redirect: 'manual' as const,
    signal: AbortSignal.timeout(impl.timeoutMs ?? 20000),
  };

  // fetch 默认跟随 3xx，而域名白名单只检查发起时的那个 URL：被允许的主机回一条指向
  // 别处的重定向，白名单就被绕过去了。改成手动逐跳，每一跳都重新过 assertNet；
  // 跨主机时把凭据头摘掉，并按 Fetch 规范处理 303 / 301 / 302 的方法改写。
  let current = url;
  let res: Response | null = null;
  for (let hop = 0; ; hop++) {
    assertNet(tool, current.toString());
    res = await fetch(current, init);
    if (!REDIRECT_STATUS.has(res.status)) break;
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`重定向超过 ${MAX_REDIRECTS} 次，已中止（最后一跳 ${current.hostname}）`);
    }
    const location = res.headers.get('location');
    if (!location) break;
    const next = new URL(location, current);
    if (next.hostname !== current.hostname) {
      for (const key of Object.keys(init.headers)) {
        if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'cookie') delete init.headers[key];
      }
    }
    if ([301, 302, 303].includes(res.status) && init.method !== 'GET' && init.method !== 'HEAD') {
      init.method = 'GET';
      init.body = undefined;
    }
    current = next;
  }
  if (!res) throw new Error('HTTP 请求没有返回响应');

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}：${text.slice(0, 300)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return extractPath(data, impl.extract);
}

function runTransform(tool: Tool, input: Json): unknown {
  const impl = tool.impl;
  // 只把「序列化后的数据」送进新 realm，绝不传宿主对象。
  // 原来把宿主的 input / JSON / Object 直接塞进 sandbox：宿主 realm 的
  // input.constructor.constructor 能拿回宿主 Function，绕过 codeGeneration 限制
  // 直接读 process / fs（实测能读到仓库文件），而 transform 默认判 L0 自动放行。
  // JSON.parse 在新 realm 里执行，产出的对象及其构造器都属于该 realm，受限的
  // Function 构造器便无法再生成宿主代码。新 realm 自带 JSON / Math / Object 等内建，
  // 无需从宿主注入。
  let serialized: string;
  try {
    serialized = JSON.stringify(input ?? {}) ?? '{}';
  } catch (err) {
    throw new Error(`transform 入参无法序列化：${(err as Error).message}`);
  }
  const context = vm.createContext({ __input: serialized }, { codeGeneration: { strings: false, wasm: false } });
  try {
    vm.runInContext(`globalThis.__result = (function(input){ ${impl.code} })(JSON.parse(__input));`, context, {
      timeout: impl.timeoutMs ?? 3000,
      displayErrors: true,
    });
  } catch (err) {
    throw new Error(`transform 执行失败：${(err as Error).message}`);
  }
  return (context as Record<string, unknown>).__result;
}

function runShell(tool: Tool, scope: Scope, ctx: DeclarativeContext): Promise<{ stdout: string; stderr: string }> {
  execAllowed(tool);
  const impl = tool.impl;
  const cmd = renderString(impl.command ?? '', scope).trim();
  const bin = cmd.split(/\s+/)[0] ?? '';
  const args = (impl.args || []).map((a) => renderString(a, scope));

  // 二次校验：结论必须与闸门一致。绕过 executeTool 直接调执行器时，
  // commandApproved 拿不到，需确认的命令就落不下去。
  const verdict = classifyCommand(bin, args, impl.cwd ?? '', ctx.access ?? 'full');
  if (verdict.decision === 'deny') throw new Error(`命令被禁止：${verdict.reason}`);
  if (verdict.decision === 'confirm' && !ctx.commandApproved) {
    throw new Error('这条命令需要人工确认，请经 executeTool 调用');
  }
  if (/[|&;<>$`]/.test(cmd)) {
    throw new Error('命令含 shell 元字符，已拒绝执行');
  }
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: impl.timeoutMs ?? 30000,
        cwd: impl.cwd || undefined,
        // execFile 传 env 会替换整个环境：只给声明过的键会让 Windows 连 PATH 都没有，
        // 明明放行的命令也找不到可执行文件。与 script.ts 的 childEnv 用同一套最小环境。
        env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '', ...pickEnv(tool) },
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}${stderr ? ' | ' + stderr.slice(0, 300) : ''}`));
        resolve({ stdout: stdout.slice(0, 100000), stderr: stderr.slice(0, 4000) });
      }
    );
  });
}

async function runCompose(tool: Tool, scope: Scope, ctx: DeclarativeContext): Promise<unknown> {
  const steps = tool.impl.steps ?? [];
  const results: Array<{ tool: string; result: unknown }> = [];
  for (const step of steps) {
    const args = renderDeep(step.args ?? {}, { ...scope, steps: results }) as Json;
    const out = await ctx.run(step.tool, args);
    results.push({ tool: step.tool, result: out });
  }
  return results.length === 1 ? results[0]?.result : results;
}
