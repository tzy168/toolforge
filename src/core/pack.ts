import fs from 'node:fs';
import path from 'node:path';
import { store } from './store.js';
import { normalizeTool, type RawTool } from './spec.js';
import { dirs, ensureDirs, readJsonFile } from './paths.js';
import { staticScan } from './review.js';
import type { Finding } from '../types.js';

const PACK_SCHEMA = 'toolforge.pack/1';

export interface Pack {
  schema: string;
  name: string;
  version: string;
  description: string;
  createdAt: string;
  tools: RawTool[];
}

export interface ImportResult {
  name: string;
  ok: boolean;
  status?: string;
  error?: string;
  skipped?: string;
  permissions?: unknown;
  findings?: Finding[];
}

export function exportPack({ name, ids = [], description = '' }: { name?: string; ids?: string[]; description?: string }): Pack {
  const tools: RawTool[] = ids
    .map((id) => store.get(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
      kind: t.kind,
      input: t.input,
      impl: t.impl,
      permissions: t.permissions,
      examples: t.examples,
      meta: t.meta,
      trust: t.trust,
    }));

  if (tools.length === 0) throw new Error('没有可导出的工具');

  return {
    schema: PACK_SCHEMA,
    name: name || `pack-${Date.now()}`,
    version: '1.0.0',
    description,
    createdAt: new Date().toISOString(),
    tools,
  };
}

export function savePack(pack: Pack): string {
  ensureDirs();
  const file = path.join(dirs.packs, `${pack.name}.json`);
  fs.writeFileSync(file, JSON.stringify(pack, null, 2), 'utf8');
  return file;
}

/**
 * 导入工具包。默认全部落为 pending —— 导入不等于放行，
 * 用户得先看清每个工具索要什么权限。
 */
export function importPack(pack: unknown, { approve = false }: { approve?: boolean } = {}): ImportResult[] {
  const p = pack as Partial<Pack> | null;
  if (!p || !Array.isArray(p.tools)) {
    throw new Error('不是合法的工具包：缺少 tools 数组');
  }
  const results: ImportResult[] = [];
  for (const raw of p.tools) {
    try {
      const tool = normalizeTool({
        ...raw,
        status: approve ? 'active' : 'pending',
        sessionId: null,
        meta: { ...(raw.meta || {}), source: 'pack' },
      });

      // 同版本已存在就别覆盖，否则一次「导出再导入」会把已放行的工具打回待审
      const existing = store.get(tool.id);
      if (existing && existing.version === tool.version) {
        results.push({ name: tool.name, ok: true, skipped: '已存在同版本，未覆盖' });
        continue;
      }

      const findings = staticScan(tool.impl?.code ?? '');
      const high = findings.filter((f) => f.level === 'high');
      if (high.length) {
        results.push({ name: tool.name, ok: false, error: `静态扫描命中高危：${high.map((f) => f.msg).join('；')}` });
        continue;
      }
      store.save(tool);
      results.push({
        name: tool.name,
        ok: true,
        status: tool.status,
        permissions: tool.permissions,
        findings,
      });
    } catch (err) {
      results.push({ name: raw?.name ?? '(未命名)', ok: false, error: (err as Error).message });
    }
  }
  return results;
}

export function readPackFile(file: string): Pack {
  return readJsonFile(file) as Pack;
}
