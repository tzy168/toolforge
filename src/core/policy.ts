// 访问档位与命令分级。判定集中在这里，执行器只做二次校验，不各自解释规则。
import path from 'node:path';
import { getWorkspace, isInside, WORKSPACE_ROOT } from './paths.js';
import type { AccessLevel, Json, Permissions, Tool } from '../types.js';

/* ---------------- 三级访问档位 ---------------- */

export const ACCESS_LEVELS: AccessLevel[] = ['readonly', 'workspace', 'full'];
/** 老配置、老任务没有档位字段时沿用完全访问，免得升级后原有工具突然全跑不动 */
export const DEFAULT_ACCESS: AccessLevel = 'full';

export const ACCESS_LABEL: Record<AccessLevel, string> = {
  full: '允许完全访问',
  workspace: '工作区内修改',
  readonly: '仅可查看',
};

export const ACCESS_DESC: Record<AccessLevel, string> = {
  full: '按工具声明的能力执行，命令仍需按黑白名单确认',
  workspace: '写入只能落在选中的项目目录，命令执行要逐次确认',
  readonly: '只看不改：禁写文件、禁执行命令、禁写类网络请求',
};

export function normalizeAccess(raw: unknown): AccessLevel {
  return raw === 'readonly' || raw === 'workspace' || raw === 'full' ? raw : DEFAULT_ACCESS;
}

// 与 workspace 一样是模块级状态：执行闸门在 core/ 里，沿参数一层层传太深。
// chat() 每轮开头用调用方传入的值覆盖它，切任务太快也不会拿到上一轮的档位。
let current: AccessLevel = DEFAULT_ACCESS;

export function getAccessLevel(): AccessLevel {
  return current;
}

export function setAccessLevel(raw: unknown): AccessLevel {
  current = normalizeAccess(raw);
  return current;
}

/**
 * 档位与工具声明取交集，只会收窄、绝不放宽。
 *
 * 返回的是新对象，不改 tool.permissions —— 落盘的规格永远保留作者原本的声明，
 * 收窄只发生在这一次调用里。
 */
export function effectivePermissions(tool: Tool, level: AccessLevel): Permissions {
  const p: Permissions = { ...tool.permissions };
  if (level === 'readonly') {
    // 「仅可查看」保留只读网络与只读文件；写盘、执行命令、读密钥一律摘掉
    p.fsWrite = [];
    p.exec = false;
    p.env = [];
  } else if (level === 'workspace') {
    // 只认 @workspace：工具自己的 .data 也不算「工作区内」，不许写
    p.fsWrite = p.fsWrite.includes(WORKSPACE_ROOT) ? [WORKSPACE_ROOT] : [];
  }
  return p;
}

/** 只读档下连「造工具 / 改仓库」这两个元工具都不该出现在模型眼前 */
const META_DENY_READONLY = new Set(['create_tool', 'manage_tool']);

/**
 * 这件工具在当前档位下能不能出现在模型眼前。
 *
 * 权限不能只做「执行时拒绝」：工具名一旦进了 function calling 的 schema，模型就会
 * 先试一次、撞墙、再换一件试，八次失败才想起来问人。看不到的工具才不会被调用。
 * 判定与 accessDenies 共用这一份，别让「能不能看见」和「能不能执行」各说一套。
 */
export function toolAvailable(tool: Tool, level: AccessLevel): boolean {
  if (level === 'full') return true;
  const p = tool.permissions;
  if (level === 'readonly') {
    if (tool.kind === 'meta') return !META_DENY_READONLY.has(tool.name);
    if (tool.kind === 'shell' || tool.kind === 'mcp') return false;
    if (p?.exec) return false;
    if ((p?.fsWrite || []).length) return false;
    if ((p?.env || []).length) return false;
    if (tool.kind === 'http') {
      const method = String(tool.impl.method || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
    }
    return true;
  }
  // workspace：声明了写、却不是写工作区的工具，留着只会让模型白试一次
  const writes = p?.fsWrite || [];
  return writes.length === 0 || writes.includes(WORKSPACE_ROOT);
}

export function filterTools<T extends Tool>(tools: T[], level: AccessLevel): T[] {
  return tools.filter((t) => toolAvailable(t, level));
}

/** 被档位藏起来的工具名，写进系统提示词，免得模型以为「仓库里根本没有」又去造一件 */
export function hiddenToolNames(all: Tool[], level: AccessLevel): string[] {
  return all.filter((t) => !toolAvailable(t, level)).map((t) => t.name);
}

/** 档位层面直接拒绝的调用。返回给模型的句子要说清「别再试了」，不能只说「不行」 */
export function accessDenies(tool: Tool, level: AccessLevel, _args: Json = {}): string | null {
  if (level === 'full') return null;
  if (!toolAvailable(tool, level)) {
    const why =
      level === 'readonly'
        ? '不允许写文件、执行命令、改动远端数据、读取密钥，也不能造工具或改仓库'
        : '这件工具会写工具目录，而不是用户选中的工作区';
    return (
      `当前档位是「${ACCESS_LABEL[level]}」，${why}，已拦下。` +
      '**这是档位限制，换任何工具或写法重试都不会成功**；请直接告知用户需要切换权限档位并给出可立即执行的替代方案，不要再调用工具试探。'
    );
  }
  return null;
}

/** 元工具不走 executeTool，档位得在门面那一层单独挡一次 */
export function metaDenied(name: string, args: Json, level: AccessLevel): string | null {
  if (level !== 'readonly') return null;
  if (name === 'create_tool') {
    return (
      '当前档位是「仅可查看」，不能造工具（造工具会写仓库并跑用例）。' +
      '**这是档位限制，另造一件工具或换写法重试都不会成功**；请直接告知用户需要切换权限档位，不要继续调用工具。'
    );
  }
  if (name === 'manage_tool') {
    const action = String(args.action ?? '');
    if (['enable', 'disable', 'remove'].includes(action)) {
      return `当前档位是「仅可查看」，不能${action} 工具。查询请用 action=list / inspect；这是档位限制，不要换动作重试。`;
    }
  }
  return null;
}

/* ---------------- 命令黑白名单 ---------------- */

export type CommandDecision = 'allow' | 'confirm' | 'deny';

export interface CommandVerdict {
  decision: CommandDecision;
  bin: string;
  /** 给用户和模型看的理由，拒绝时要能照着改 */
  reason: string;
}

/**
 * 一律禁止：破坏文件、提权、改写系统、再开一层 shell、包管理器安装。
 * 这是硬红线，人工也不能放行——「确认」按钮不该出现在这些命令上。
 */
const DENY_BINS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'format', 'mkfs', 'dd', 'shutdown', 'reboot', 'poweroff',
  'chmod', 'chown', 'chgrp', 'attrib', 'icacls', 'takeown',
  'sudo', 'su', 'runas', 'reg', 'regedit', 'netsh', 'sc', 'taskkill', 'schtasks',
  'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'cscript', 'wscript', 'mshta',
  'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'apt', 'apt-get', 'yum', 'dnf', 'brew',
]);

/** 明确可执行：只读、无副作用、参数里也不带执行开关 */
const ALLOW_BINS = new Set([
  'echo', 'ls', 'dir', 'cat', 'type', 'rg', 'grep', 'findstr',
  'head', 'tail', 'wc', 'pwd', 'date', 'whoami', 'uname',
]);

/** 需要人点头：能执行任意代码、能外发数据、或会改动仓库 */
const CONFIRM_BINS = new Set(['node', 'python', 'python3', 'curl', 'git', 'find']);

/** git 的只读子命令才免确认，其余一律请示 */
const GIT_READONLY = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files',
  'blame', 'describe', 'tag', 'remote', 'cat-file', 'ls-tree',
]);

/** git 里无论谁点头都不做的高危子命令 */
const GIT_DENY = new Set(['push', 'clean', 'filter-branch', 'prune', 'update-ref', 'gc']);

/** 会把「一条命令」变成「任意代码/任意写」的开关 */
const RISKY_ARG = /(?:^|\s)(?:-e\b|--eval\b|-c\b|--command\b|--exec\b|-i\b|--interactive\b|--upload-file\b|-o\b|--output\b|--data\b|-d\b|-X\b)/;

function cleanBin(raw: string): string {
  // 允许 `git` 也允许 `git.exe`；路径写法（/usr/bin/node）取最后一段，但不允许藏路径分隔符
  const base = String(raw || '').trim().toLowerCase().replace(/\.exe$/, '');
  return base.split(/[\\/]/).pop() ?? '';
}

/**
 * 给一条命令定级。纯函数，不碰 IO —— 宿主闸门与执行器用同一份结论，
 * 免得「门口放行了、执行器又拒」或反过来。
 */
export function classifyCommand(
  rawBin: string,
  args: string[] = [],
  cwd = '',
  level: AccessLevel = 'full'
): CommandVerdict {
  const bin = cleanBin(rawBin);
  const list = args.map((a) => String(a));
  const joined = list.join(' ');
  const deny = (reason: string): CommandVerdict => ({ decision: 'deny', bin, reason });
  const confirm = (reason: string): CommandVerdict => ({ decision: 'confirm', bin, reason });
  const allow = (reason: string): CommandVerdict => ({ decision: 'allow', bin, reason });

  if (!bin) return deny('命令为空');
  if (level === 'readonly') return deny('当前档位是「仅可查看」，不允许执行外部命令');
  if (DENY_BINS.has(bin)) return deny(`命令 ${bin} 在禁止清单内（破坏性 / 提权 / 可再开 shell 或装包），不接受人工放行`);

  // 工作目录越界：full 档不管，workspace 档必须落在用户选中的项目目录里
  if (cwd && level === 'workspace') {
    const ws = getWorkspace();
    if (!ws || !isInside(path.resolve(cwd), ws)) {
      return deny(`「工作区内修改」档下，命令的工作目录必须落在当前工作区${ws ? `（${ws}）` : '，但当前还没选工作区'}`);
    }
  }

  if (bin === 'git') {
    const sub = list.find((a) => !a.startsWith('-')) ?? '';
    if (GIT_DENY.has(sub)) return deny(`git ${sub} 在禁止清单内，不接受人工放行`);
    if (sub === 'reset' && list.includes('--hard')) return deny('git reset --hard 会丢掉未提交的改动，不接受人工放行');
    if (GIT_READONLY.has(sub) && !RISKY_ARG.test(joined)) return allow(`git ${sub} 是只读子命令`);
    return confirm(`git ${sub || '(未指定子命令)'} 会改动仓库或无法判定副作用`);
  }

  if (CONFIRM_BINS.has(bin)) {
    return confirm(`${bin} 能执行任意代码或访问外部资源，需人工确认`);
  }
  if (ALLOW_BINS.has(bin)) {
    if (RISKY_ARG.test(joined)) return confirm(`${bin} 的参数里带了可执行/可写开关`);
    return allow(`${bin} 在只读命令白名单内`);
  }
  return deny(`命令 ${bin} 不在可执行清单内，默认拒绝`);
}

/** 给确认框与审计看的摘要。只留必要信息，别把整段参数塞给界面 */
export function commandSummary(command: string, args: string[] = []): string {
  const line = [String(command || '').trim(), ...args.map(String)].filter(Boolean).join(' ');
  return line.slice(0, 300);
}
