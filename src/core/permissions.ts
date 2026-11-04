import path from 'node:path';
import { getWorkspace, isInside, toolDir, WORKSPACE_ROOT } from './paths.js';
import type { Tool } from '../types.js';

/** 域名白名单匹配，支持 *.example.com */
export function hostAllowed(host: string, allow: string[] = []): boolean {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return allow.some((rule) => {
    const r = String(rule).toLowerCase();
    if (r === '*') return false; // 通配全部域名一律拒绝，必须显式列出
    if (r.startsWith('*.')) {
      const base = r.slice(2);
      return h === base || h.endsWith('.' + base);
    }
    return h === r;
  });
}

export function hostOf(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function assertNet(tool: Tool, urlStr: string): void {
  const host = hostOf(urlStr);
  if (!host) throw new Error(`非法 URL：${urlStr}`);
  if (!hostAllowed(host, tool.permissions?.net)) {
    throw new Error(
      `权限拒绝：工具 ${tool.name} 未获准访问 ${host}（已声明：${(tool.permissions?.net || []).join(', ') || '无'}）`
    );
  }
}

export function execAllowed(tool: Tool): void {
  if (!tool.permissions?.exec) {
    throw new Error(`权限拒绝：工具 ${tool.name} 未获准执行外部命令`);
  }
}

/** 只放行声明过的环境变量 */
export function pickEnv(tool: Tool): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of tool.permissions?.env || []) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * 把一条权限规则解析成绝对根目录。
 * 工具目录内的相对路径仍相对工具目录；`@workspace` 指向用户选定的项目文件夹。
 */
export function resolveRuleRoot(toolId: string, rule: string): string | null {
  if (rule === WORKSPACE_ROOT) return getWorkspace();
  return path.resolve(toolDir(toolId), rule);
}

/**
 * 校验 `@workspace` 能不能用：没选工作目录就直接报错，别让工具以为是「没权限」。
 * 返回的提示会原样喂回模型，所以要说清楚怎么解决。
 */
export function assertWorkspaceSelected(rules: string[] | undefined, toolName: string): void {
  if (!(rules || []).includes(WORKSPACE_ROOT)) return;
  if (!getWorkspace()) {
    throw new Error(`工具 ${toolName} 需要工作目录，但当前没有选择。请让用户在左上角选一个项目文件夹，或在设置里挑目录。`);
  }
}

/** 路径是否落在声明的范围内——沙箱与宿主共用的唯一判定 */
export function pathAllowed(
  target: string,
  rules: string[] = [],
  toolId: string
): boolean {
  const abs = path.resolve(target);
  return rules.some((rule) => {
    const root = resolveRuleRoot(toolId, rule);
    return root !== null && isInside(abs, root);
  });
}
