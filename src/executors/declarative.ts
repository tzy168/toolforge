import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { renderDeep, renderString, extractPath, type Scope } from '../core/template.js';
import { assertNet, execAllowed, pickEnv } from '../core/permissions.js';
import type { DeclarativeContext, Json, Tool } from '../types.js';

// 声明式执行器：八成工具不需要写代码，走这里。
// 宿主全程代理 IO，工具本身碰不到网络与文件系统。

const SAFE_BINS = new Set(['node', 'git', 'echo', 'ls', 'dir', 'cat', 'curl', 'rg', 'grep', 'python', 'python3']);

export async function runDeclarative(tool: Tool, input: Json, ctx: DeclarativeContext): Promise<unknown> {
  const scope: Scope = { input, now: new Date().toISOString(), env: pickEnv(tool) };
  switch (tool.kind) {
    case 'http':
      return runHttp(tool, scope);
    case 'transform':
      return runTransform(tool, input);
    case 'shell':
      return runShell(tool, scope);
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
  assertNet(tool, url.toString());

  const headers = renderDeep<Record<string, string>>(impl.headers || {}, scope);
  const body = impl.body == null ? undefined : JSON.stringify(renderDeep(impl.body, scope));
  if (body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method: impl.method,
    headers,
    body: impl.method === 'GET' || impl.method === 'HEAD' ? undefined : body,
    signal: AbortSignal.timeout(impl.timeoutMs ?? 20000),
  });
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
  const sandbox = { input, JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, isNaN, parseInt, parseFloat };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  try {
    vm.runInContext(`globalThis.__result = (function(){ ${impl.code} })();`, context, {
      timeout: impl.timeoutMs ?? 3000,
      displayErrors: true,
    });
  } catch (err) {
    throw new Error(`transform 执行失败：${(err as Error).message}`);
  }
  return (context as Record<string, unknown>).__result;
}

function runShell(tool: Tool, scope: Scope): Promise<{ stdout: string; stderr: string }> {
  execAllowed(tool);
  const impl = tool.impl;
  const cmd = renderString(impl.command ?? '', scope).trim();
  const bin = cmd.split(/\s+/)[0] ?? '';
  if (!SAFE_BINS.has(bin)) {
    throw new Error(`命令 ${bin} 不在白名单内（${[...SAFE_BINS].join(', ')}）`);
  }
  if (/[|&;<>$`]/.test(cmd)) {
    throw new Error('命令含 shell 元字符，已拒绝执行');
  }
  const args = (impl.args || []).map((a) => renderString(a, scope));
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: impl.timeoutMs ?? 30000, cwd: impl.cwd || undefined, env: pickEnv(tool) },
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
