import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toolDir, getWorkspace, WORKSPACE_ROOT } from '../core/paths.js';
import { pickEnv, resolveRuleRoot } from '../core/permissions.js';
import type { Json, Tool } from '../types.js';

// 代码兜底的执行路径：另起子进程，Node 权限模型 + 引导层双管齐下。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, 'runtime-child.cjs');

// Node 20 叫 --experimental-permission，Node 22+ 改叫 --permission。
// Electron 内置的 Node 未必支持任何一个，所以要逐个试，试不通就降级并如实记录。
const PERM_FLAGS = ['--permission', '--experimental-permission'];
let flagIndex = 0;
let permDisabled = false;
// 是否真的试过一次。没跑过脚本工具时不能声称「隔离已启用」。
let probed = false;

interface SpawnOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  stderr: string;
  badFlag: boolean;
}

function childEnv(tool: Tool): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    SYSTEMROOT: process.env.SYSTEMROOT || '',
    ...pickEnv(tool),
  };
  // Electron 下 process.execPath 是 electron.exe，靠这个变量让它按 Node 行事
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

export function buildScriptArgs(flag: string | null, tool: Tool): string[] {
  const dir = toolDir(tool.id);
  const dataDir = path.join(dir, '.data');
  const args: string[] = [];
  if (flag) {
    args.push(flag, `--allow-fs-read=${dir}`, `--allow-fs-read=${RUNTIME}`, `--allow-fs-write=${dataDir}`);
    // 只有 @workspace 需要额外的 OS 级白名单：工具目录本来就已经放行了。
    // 别把每条 fsRead / fsWrite 规则都塞进来——像 "**" 或尚未创建的目录会解析成
    // 不存在的路径，Node 会起不来（或直接 ABORT），把原本正常的工具一起弄崩。
    for (const rule of tool.permissions?.fsRead || []) {
      if (rule !== WORKSPACE_ROOT) continue;
      const root = resolveRuleRoot(tool.id, rule);
      if (root) args.push(`--allow-fs-read=${root}`);
    }
    for (const rule of tool.permissions?.fsWrite || []) {
      if (rule !== WORKSPACE_ROOT) continue;
      const root = resolveRuleRoot(tool.id, rule);
      if (root) args.push(`--allow-fs-write=${root}`);
    }
  }
  args.push('--max-old-space-size=256', RUNTIME);
  return args;
}

function spawnOnce(flag: string | null, tool: Tool, payload: unknown, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, buildScriptArgs(flag, tool), {
      env: childEnv(tool),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 4_000_000) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 20_000) err += d.toString();
    });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, stderr: err, badFlag: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 只有「运行时不认这个开关」才算 badFlag，别把工具自身的报错误判成降级
      const badFlag = Boolean(flag) && /bad option|unknown option|not allowed|invalid|requires/i.test(err) && err.includes(flag as string);
      if (killed) {
        resolve({ ok: false, error: `执行超时（${timeoutMs}ms），已强制终止`, stderr: err, badFlag: false });
        return;
      }
      let parsed: { ok?: boolean; result?: unknown; error?: string } | null = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* 落到下面统一处理 */
      }
      if (parsed && parsed.ok) {
        resolve({ ok: true, result: parsed.result, stderr: err, badFlag });
        return;
      }
      if (parsed && parsed.ok === false) {
        resolve({ ok: false, error: parsed.error, stderr: err, badFlag });
        return;
      }
      resolve({
        ok: false,
        error: `子进程异常退出（code=${code}）${err ? '：' + err.trim().split('\n').slice(-4).join(' ') : ''}`,
        stderr: err,
        badFlag,
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runScript(tool: Tool, input: Json): Promise<unknown> {
  const dir = toolDir(tool.id);
  const dataDir = path.join(dir, '.data');
  fs.mkdirSync(dataDir, { recursive: true });

  const entryName = tool.impl.entry ?? '';
  const entry = path.join(dir, entryName);
  if (!fs.existsSync(entry)) throw new Error(`找不到工具入口文件 ${entryName}`);

  const payload = {
    input,
    entry,
    toolDir: dir,
    dataDir,
    workspace: getWorkspace(),
    perm: tool.permissions,
    allowedEnv: tool.permissions?.env || [],
  };

  const timeout = tool.impl.timeoutMs ?? 30000;
  let res = await spawnOnce(permDisabled ? null : (PERM_FLAGS[flagIndex] ?? null), tool, payload, timeout);
  probed = true;

  // 逐个试探权限开关，直到找到一个能用的
  while (!res.ok && res.badFlag) {
    if (flagIndex + 1 < PERM_FLAGS.length) {
      flagIndex += 1;
      res = await spawnOnce(PERM_FLAGS[flagIndex] ?? null, tool, payload, timeout);
    } else {
      permDisabled = true;
      res = await spawnOnce(null, tool, payload, timeout);
      break;
    }
  }

  if (!res.ok) throw new Error(res.error);
  return res.result;
}

/** 当前生效的权限开关名，null 表示降级为无 OS 级隔离；probed=false 表示还没跑过脚本工具 */
export function permissionSupport(): { probed: boolean; flag: string | null } {
  return { probed, flag: permDisabled ? null : (PERM_FLAGS[flagIndex] ?? null) };
}
