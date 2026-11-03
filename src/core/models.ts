// 多模型配置：内置的 DeepSeek / Kimi 只需填 API Key，Base URL 固定；
// 模型名不给默认值——由用户自己填，或从服务商的 /models 接口拉一份列表来选。
// 自定义服务商走同一套 OpenAI 兼容协议，Base URL 与模型名都自己填。

export interface ModelProvider {
  id: string;
  label: string;
  baseURL: string;
  apiKey: string;
  /** 空字符串表示还没选模型，此服务商不可用 */
  model: string;
  custom: boolean;
}

export const PRESETS: ModelProvider[] = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: '', model: '', custom: false },
  { id: 'kimi', label: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', apiKey: '', model: '', custom: false },
];

/** 给渲染层的视图：永远不带 apiKey，只告诉配没配 */
export interface ProviderView {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
  custom: boolean;
}

/** 把 settings.json 里存的条目合到预设上，返回完整列表（预设在前，自定义在后） */
export function mergeProviders(saved: Array<Partial<ModelProvider>> = []): ModelProvider[] {
  const map = new Map(PRESETS.map((p) => [p.id, { ...p }]));
  for (const raw of saved) {
    const id = String(raw?.id || '').trim();
    if (!id) continue;
    const preset = map.get(id);
    if (preset && !raw.custom) {
      // 预设只收 API Key 与模型名，Base URL 仍锁死
      preset.apiKey = String(raw.apiKey || '').trim();
      preset.model = String(raw.model || '').trim();
      continue;
    }
    map.set(id, {
      id,
      label: String(raw.label || id),
      baseURL: String(raw.baseURL || '').trim(),
      apiKey: String(raw.apiKey || '').trim(),
      model: String(raw.model || '').trim(),
      custom: true,
    });
  }
  return [...map.values()];
}

export function toView(p: ModelProvider): ProviderView {
  return { id: p.id, label: p.label, baseURL: p.baseURL, model: p.model, hasKey: Boolean(p.apiKey), custom: p.custom };
}

/** 当前生效的服务商：没填 Key 或没选模型都算未配置，不能选 */
export function pickActive(list: ModelProvider[], activeId?: string | null): ModelProvider | null {
  const hit = list.find((p) => p.id === activeId);
  return hit && hit.apiKey && hit.model ? hit : null;
}

/** 从 OpenAI 兼容的 /models 接口拉可用模型名 */
export async function fetchModelIds(baseURL: string, apiKey: string): Promise<string[]> {
  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`模型列表不是 JSON：${text.slice(0, 200)}`);
  }
  // 兼容 { data: [{id}] } 与裸数组两种形状
  const rows = Array.isArray(data) ? data : (data as { data?: unknown }).data;
  const ids = (Array.isArray(rows) ? rows : [])
    .map((r) => (typeof r === 'string' ? r : String((r as { id?: unknown }).id ?? '')))
    .filter(Boolean);
  if (!ids.length) throw new Error('该服务商没有返回任何模型');
  return [...new Set(ids)].sort();
}
