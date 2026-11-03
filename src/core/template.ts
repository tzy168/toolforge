// 声明式工具的模板与取值工具。用 {{input.xxx}} / {{now}} 这类占位符。

export type Scope = Record<string, unknown>;

export function lookup(scope: unknown, dotPath: string): unknown {
  return String(dotPath)
    .split('.')
    .reduce<unknown>((acc, key) => {
      if (acc == null) return undefined;
      const m = key.match(/^([^[]*)((\[\d+\])*)$/);
      const obj = acc as Record<string, unknown>;
      if (!m) return obj[key];
      const field = m[1] ?? '';
      let cur: unknown = field ? obj[field] : acc;
      const idx = (m[2] ?? '').match(/\d+/g) || [];
      for (const i of idx) cur = (cur as unknown[] | undefined)?.[Number(i)];
      return cur;
    }, scope);
}

export function renderString(str: unknown, scope: Scope): string {
  if (typeof str !== 'string') return String(str);
  return str.replace(/\{\{\s*([\w.$[\]]+)\s*\}\}/g, (_, key: string) => {
    const v = lookup(scope, key);
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function renderDeep<T>(value: T, scope: Scope): T {
  if (typeof value === 'string') return renderString(value, scope) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[renderString(k, scope)] = renderDeep(v, scope);
    }
    return out as unknown as T;
  }
  return value;
}

/** 从响应里取值：支持 a.b[0].c 与 $.a.b 两种写法；空则返回原值 */
export function extractPath(data: unknown, pathExpr?: string): unknown {
  if (!pathExpr) return data;
  const clean = String(pathExpr).trim().replace(/^\$\.?/, '');
  if (!clean) return data;
  const v = lookup(data, clean);
  return v === undefined ? null : v;
}
