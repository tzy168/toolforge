import fs from 'node:fs';
import path from 'node:path';
import { dirs, ensureDirs, readJsonFile, safeId, toolDir } from './paths.js';
import { normalizeTool, type RawTool } from './spec.js';
import type { Tool } from '../types.js';

// 升一个 patch 版本号。规格里 version 是自由字符串，解析不了的按 0.1.0 起步。
export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return '0.1.1';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

// 仓库布局：
// ~/.toolforge/tools/<id>/tool.json      规格（不含代码）
// ~/.toolforge/tools/<id>/<name>.cjs     脚本类工具的代码
// ~/.toolforge/tools/<id>/.data/         脚本工具唯一可写的目录
// ~/.toolforge/tools/<id>/.history/      历次规格快照

export interface ListOptions {
  includeBroken?: boolean;
}
export interface BrokenTool {
  id: string;
  error: string;
}

/**
 * 「这件工具此刻能不能用」的唯一判定：已放行，或属于创建它的那次会话。
 * 仓库过滤（usable）与执行闸门（executeTool）都走这里——两处各写一遍迟早在改规则时漏掉一边。
 */
export function isUsable(tool: Tool, sessionId: string | null): boolean {
  return tool.status === 'active' || (tool.sessionId !== null && tool.sessionId === sessionId);
}

export class ToolStore {
  broken: BrokenTool[] = [];
  private cache: Tool[] | null = null;

  constructor() {
    ensureDirs();
  }

  invalidate(): void {
    this.cache = null;
  }

  list(): Tool[];
  list(opts: { includeBroken: true }): { tools: Tool[]; broken: BrokenTool[] };
  list(opts: ListOptions = {}): Tool[] | { tools: Tool[]; broken: BrokenTool[] } {
    if (!this.cache) {
      const out: Tool[] = [];
      this.broken = [];
      for (const entry of fs.readdirSync(dirs.tools, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(dirs.tools, entry.name);
        try {
          const tool = this.read(dir);
          if (tool) out.push(tool);
        } catch (err) {
          this.broken.push({ id: entry.name, error: (err as Error).message });
        }
      }
      this.cache = out;
    }
    const list = this.cache.map((t) => ({ ...t }));
    return opts.includeBroken ? { tools: list, broken: this.broken } : list;
  }

  read(dir: string): Tool | null {
    const file = path.join(dir, 'tool.json');
    if (!fs.existsSync(file)) return null;
    const raw = readJsonFile(file) as RawTool;
    const tool = normalizeTool(raw);
    // 脚本代码不塞进 tool.json，按需从文件读回
    if (tool.kind === 'script' && tool.impl.entry) {
      const codeFile = path.join(dir, tool.impl.entry);
      tool.impl.code = fs.existsSync(codeFile) ? fs.readFileSync(codeFile, 'utf8') : '';
    }
    return tool;
  }

  get(id: string): Tool | null {
    const dir = toolDir(id);
    if (!fs.existsSync(path.join(dir, 'tool.json'))) return null;
    return this.read(dir);
  }

  findByCallName(name: string): Tool | null {
    return this.list().find((t) => t.name === name) ?? null;
  }

  save(rawTool: RawTool, { bump = true }: { bump?: boolean } = {}): Tool {
    const tool = normalizeTool(rawTool);
    const dir = toolDir(tool.id);
    const file = path.join(dir, 'tool.json');
    ensureDirs();
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(file)) {
      const prev = readJsonFile(file) as RawTool;
      // 同名同版本重建（Agent 改完实现再调一次 create_tool）也得升版本，
      // 否则覆盖后没有快照可回滚，导出包也会被「同版本已存在」误判成重复。
      // 状态切换（patch）不算版本更迭，由调用方传 bump:false 跳过。
      if (bump && prev.version === tool.version) tool.version = bumpPatch(tool.version);
      if (prev.version !== tool.version) {
        const hist = path.join(dir, '.history');
        fs.mkdirSync(hist, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(hist, `${prev.version}-${stamp}.json`), JSON.stringify(prev, null, 2), 'utf8');
      }
    }

    const persisted: RawTool = { ...tool };
    if (persisted.kind === 'script') {
      const entry = persisted.impl?.entry || `${persisted.name}.cjs`;
      if (persisted.impl?.code) {
        fs.writeFileSync(path.join(dir, entry), persisted.impl.code, 'utf8');
      }
      // 依赖声明必须跟着 tool.json 走：worker 重启后要靠它判断「装没装、装的是哪版」。
      // 早先这里只留 entry/timeoutMs，任何新增的 impl 字段都会被静默丢掉。
      const deps = persisted.impl?.deps;
      persisted.impl = {
        entry,
        timeoutMs: persisted.impl?.timeoutMs,
        ...(deps && Object.keys(deps).length ? { deps } : {}),
      };
    }
    fs.writeFileSync(file, JSON.stringify(persisted, null, 2), 'utf8');
    this.invalidate();
    return tool;
  }

  patch(id: string, fields: Omit<Partial<Tool>, 'meta'> & { meta?: Partial<Tool['meta']> }): Tool {
    const tool = this.get(id);
    if (!tool) throw new Error(`工具不存在：${id}`);
    const next: RawTool = {
      ...tool,
      ...fields,
      meta: { ...tool.meta, ...(fields.meta || {}), updatedAt: new Date().toISOString() },
    } as RawTool;
    return this.save(next, { bump: false });
  }

  recordRun(id: string, run: { ok: boolean; ms: number; error?: string }): void {
    try {
      const tool = this.get(id);
      if (!tool) return;
      this.patch(id, {
        meta: {
          ...tool.meta,
          lastRun: { ok: run.ok, ms: run.ms, error: run.error ? String(run.error).slice(0, 300) : null, at: new Date().toISOString() },
        },
      });
    } catch {
      // 健康记录失败不影响主流程
    }
  }

  remove(id: string): void {
    const dir = toolDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.invalidate();
  }

  /** 当前可注入的工具：已放行，或属于本次会话 */
  usable(sessionId: string | null): Tool[] {
    return this.list().filter((t) => isUsable(t, sessionId));
  }
}

export const store = new ToolStore();
export { safeId };
