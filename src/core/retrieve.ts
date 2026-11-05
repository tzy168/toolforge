// 两级召回。工具一多，全量 schema 就撑爆上下文，必须只注入相关的那些。
import type { Tool } from '../types.js';

export interface SelectOptions {
  limit?: number;
  always?: string[];
}

function tokens(text: unknown): Set<string> {
  const out = new Set<string>();
  const s = String(text ?? '').toLowerCase();
  for (const word of s.split(/[^a-z0-9_\u4e00-\u9fa5]+/)) {
    if (!word) continue;
    if (/[\u4e00-\u9fa5]/.test(word)) {
      if (word.length <= 3) out.add(word);
      for (let i = 0; i < word.length - 1; i++) out.add(word.slice(i, i + 2));
    } else if (word.length > 1) {
      out.add(word);
    }
  }
  return out;
}

function score(tool: Tool, qTokens: Set<string>): number {
  if (qTokens.size === 0) return 0;
  const nameT = tokens(tool.name.replace(/_/g, ' '));
  const tagT = tokens((tool.meta?.tags || []).join(' '));
  const descT = tokens(tool.description);
  let s = 0;
  for (const t of qTokens) {
    if (nameT.has(t)) s += 3;
    if (tagT.has(t)) s += 2;
    if (descT.has(t)) s += 1;
  }
  return s;
}

export function selectTools(all: Tool[], query: string, options: SelectOptions = {}): Tool[] {
  const { limit = 12, always = [] } = options;
  const qTokens = tokens(query);
  const pinned = new Set(always);

  const rest = all
    .filter((t) => !pinned.has(t.name))
    .map((t) => {
      let s = score(t, qTokens);
      if (t.meta?.lastRun?.ok) s += 0.5; // 跑通过的略提权，比从没验过的可靠
      return { t, s };
    })
    .sort((a, b) => b.s - a.s);

  const picked: Tool[] = [];
  const seen = new Set<string>();
  for (const t of all) {
    if (pinned.has(t.name) && !seen.has(t.name)) {
      picked.push(t);
      seen.add(t.name);
    }
  }
  for (const { t } of rest) {
    if (picked.length >= limit + pinned.size) break;
    if (seen.has(t.name)) continue;
    picked.push(t);
    seen.add(t.name);
  }
  // 输出按名字定序：tools 数组的序列化属于缓存前缀的一部分，顺序一变整段前缀就废了。
  // 评分里带 lastRun 提权（工具跑一次分数就变），照评分顺序输出会让同一轮里
  // 每一步的工具数组都不一样——那等于每步都全量 miss。选哪几件由分数决定，怎么排不该由它决定。
  picked.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return picked;
}

/** 检索用的轻量索引，只含名字与一句话描述，省 token */
export function indexOf(tools: Tool[]): Array<{ name: string; description: string; trust: string; tags: string[] }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    trust: t.trust,
    tags: t.meta?.tags || [],
  }));
}
