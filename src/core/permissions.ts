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
