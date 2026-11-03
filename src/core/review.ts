import vm from 'node:vm';
import * as audit from '../core/audit.js';
import type { Finding, Grade, TestResult, Tool } from '../types.js';

// 静态扫描：只看代码里那些「不该出现」的痕迹。不是完备防御，是筛子。
interface Rule {
  id: string;
  level: Finding['level'];
  re: RegExp;
  msg: string;
}

const RULES: Rule[] = [
  { id: 'eval', level: 'high', re: /\beval\s*\(/, msg: '使用了 eval' },
  { id: 'fn-ctor', level: 'high', re: /new\s+Function\s*\(/, msg: '动态构造函数' },
  { id: 'child-process', level: 'high', re: /require\s*\(\s*['"](?:node:)?child_process['"]/, msg: '绕过宿主拉起子进程' },
  { id: 'raw-net', level: 'high', re: /require\s*\(\s*['"](?:node:)?(?:http|https|net|tls|dgram|http2)['"]/, msg: '绕过宿主网络代理' },
  { id: 'proc-binding', level: 'high', re: /process\.(?:binding|dlopen)\s*\(/, msg: '触碰底层绑定' },
  { id: 'exec-sync', level: 'high', re: /\b(?:execSync|spawnSync|execFileSync)\s*\(/, msg: '同步执行外部命令' },
  { id: 'fs-write', level: 'medium', re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/, msg: '直接写文件，应走 ctx.fs' },
  { id: 'fs-read', level: 'medium', re: /\b(?:readFileSync|readFile|createReadStream)\s*\(/, msg: '直接读文件，应走 ctx.fs' },
  { id: 'env-dump', level: 'medium', re: /process\.env\s*(?:\)|;|,|\])/, msg: '整表读取环境变量' },
  { id: 'raw-fetch', level: 'medium', re: /\bfetch\s*\(/, msg: '直接调用 fetch，应走 ctx.net' },
  { id: 'base64-blob', level: 'low', re: /[A-Za-z0-9+/]{300,}={0,2}/, msg: '大段编码字符串，可能藏载荷' },
];

export function staticScan(code?: string | null): Finding[] {
  if (!code || typeof code !== 'string') return [];
  const lines = code.split('\n');
  const findings: Finding[] = [];
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//')) return;
      if (rule.re.test(line)) {
        findings.push({ id: rule.id, level: rule.level, msg: rule.msg, line: i + 1 });
      }
    });
  }
  return findings;
}

/**
 * 按「能力」定级，而非按「谁来审」。
 * L0 无权限  L1 只读网络/只读文件/沙箱内跑代码  L2 有写或有密钥  L3 可执行命令或命中高危
 */
export function grade(tool: Tool, findings: Finding[] = []): Grade {
  const reasons: string[] = [];
  const p = tool.permissions || { net: [], fsRead: [], fsWrite: [], exec: false, env: [] };
  const hasHigh = findings.some((f) => f.level === 'high');

  if (hasHigh) {
    const hits = [...new Set(findings.filter((f) => f.level === 'high').map((f) => f.msg))];
    reasons.push(`静态扫描命中高危：${hits.join('；')}`);
    return { level: 'L3', needsHuman: true, approved: false, reasons };
  }

  if (tool.kind === 'shell' || p.exec) {
    reasons.push('可执行外部命令');
    return { level: 'L3', needsHuman: true, approved: false, reasons };
  }

  if (p.fsWrite?.length || p.env?.length) {
    if (p.fsWrite?.length) reasons.push(`可写文件：${p.fsWrite.join(', ')}`);
    if (p.env?.length) reasons.push(`可读密钥：${p.env.join(', ')}`);
    return { level: 'L2', needsHuman: true, approved: false, reasons };
  }

  if (p.net?.length || p.fsRead?.length || tool.kind === 'script') {
    if (p.net?.length) reasons.push(`可访问网络：${p.net.join(', ')}`);
    if (p.fsRead?.length) reasons.push(`可读文件：${p.fsRead.join(', ')}`);
    if (tool.kind === 'script') reasons.push('需在沙箱内执行代码');
    return { level: 'L1', needsHuman: false, approved: true, reasons };
  }

  reasons.push('无任何权限，仅做纯计算');
  return { level: 'L0', needsHuman: false, approved: true, reasons };
}

export interface ExampleReport {
  ok: boolean;
  results: TestResult[];
}

/** 跑一遍自带用例。runner(tool, args) 由外部注入，避免循环依赖。 */
export async function runExamples(tool: Tool, runner: (tool: Tool, args: Record<string, unknown>) => Promise<unknown>): Promise<ExampleReport> {
  const results: TestResult[] = [];
  for (const [i, ex] of (tool.examples || []).entries()) {
    const started = Date.now();
    try {
      const out = await runner(tool, ex.args || {});
      let passed = true;
      let note = '';
      if (ex.expect) {
        const ctx = vm.createContext({ result: out });
        passed = Boolean(vm.runInContext(`Boolean(${ex.expect})`, ctx, { timeout: 1000 }));
        if (!passed) note = `断言不成立：${ex.expect}`;
      }
      results.push({
        name: ex.name || `用例 ${i + 1}`,
        ok: passed,
        ms: Date.now() - started,
        note,
        sample: passed ? audit.summarize(out, 160) : null,
      });
    } catch (err) {
      results.push({
        name: ex.name || `用例 ${i + 1}`,
        ok: false,
        ms: Date.now() - started,
        note: `执行失败：${(err as Error).message}`,
        sample: null,
      });
    }
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}
