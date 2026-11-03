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
