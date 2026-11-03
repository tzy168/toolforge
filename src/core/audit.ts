import fs from 'node:fs';
import path from 'node:path';
import { dirs, ensureDirs } from './paths.js';

// 审计日志：每次工具调用落一行 JSON，既是排障凭据，也是信任定级的依据

export interface AuditEvent {
  type: string;
  [key: string]: unknown;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function append(event: AuditEvent): void {
  try {
    ensureDirs();
    const file = path.join(dirs.audit, `${today()}.jsonl`);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    // 审计失败不该拖垮主流程
  }
}

export function tail(limit = 100): AuditEvent[] {
  try {
    const file = path.join(dirs.audit, `${today()}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try {
        return JSON.parse(l) as AuditEvent;
      } catch {
        return { type: 'raw', raw: l };
      }
    });
  } catch {
    return [];
  }
}

// 摘要，避免把密钥、大文本写进日志
export function summarize(value: unknown, max = 240): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (typeof s !== 'string') s = String(s);
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : s;
}
