import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 一切持久化都落在这个目录，CLI 与桌面端共用同一份仓库
export const HOME: string = process.env.TOOLFORGE_HOME || path.join(os.homedir(), '.toolforge');

export const dirs = {
  home: HOME,
  tools: path.join(HOME, 'tools'),
  packs: path.join(HOME, 'packs'),
  audit: path.join(HOME, 'audit'),
  staging: path.join(HOME, 'staging'),
  mcpFile: path.join(HOME, 'mcp.json'),
  settings: path.join(HOME, 'settings.json'),
};

export function ensureDirs(): void {
  for (const d of [dirs.tools, dirs.packs, dirs.audit, dirs.staging]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// 工具 id 会成为目录名，必须干净
export function safeId(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
  return s || 'unnamed';
}

export function toolDir(id: string): string {
  return path.join(dirs.tools, safeId(id));
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 当前工作目录（用户在 Work 模式下选中的项目文件夹）。
 *
 * 放成模块级状态而不是实例字段：沙箱子进程在 `executors/` 里跑，
 * 沿参数传要穿过四五层签名；`store` / `mcp` 也是同样的单例做法。
 */
let workspace: string | null = null;

export function getWorkspace(): string | null {
  return workspace;
}

/** 设为 null 表示未选择。路径合法性由 ToolForge.setWorkspace 先校验 */
export function setWorkspaceDir(dir: string | null): void {
  workspace = dir ? path.resolve(dir) : null;
}

/** 判断一个路径是否落在当前工作目录内 */
export function isInWorkspace(target: string): boolean {
  return workspace !== null && isInside(target, workspace);
}

/** 权限声明的特殊根：工具目录之外，唯一允许的根就是用户选定的工作目录 */
export const WORKSPACE_ROOT = '@workspace';

/**
 * 读一个 JSON 配置文件。
 *
 * 必须剥掉 BOM：Windows 记事本 / PowerShell 存 UTF-8 默认带 BOM，
 * 而 JSON.parse 见到 BOM 直接抛错——那会被上层当成"文件损坏"进而覆盖用户配置。
 */
export function readJsonFile(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}
