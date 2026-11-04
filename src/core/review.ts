import vm from 'node:vm';
import * as audit from '../core/audit.js';
import { WORKSPACE_ROOT } from '../core/paths.js';
import { planSharedDeps, readDepPolicy } from './deps.js';
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

  // 三方依赖：它改变的是「代码从哪来」，不是「工具能做什么」。
  //
  // 命中离线白名单 → 只记一笔、不动级别（白名单进过一次人工审核）。
  // 没命中 → 级别钉死在 L3，理由分两种：
  //   a) 用户开了 allowUnvettedDeps：会联网装并执行，来源未经本项目审核；
  //   b) 没开：压根不装也不跑用例，等人工决定。
  //
  // 两种情况都不在这里 return。早返回会让 reasons 里只剩依赖一条，
  // 用户看到的就是「它要装个包」而不知道「它还能删文件」——那放行等于闭眼签字。
  const depNames = Object.keys(tool.impl?.deps ?? {});
  let depNote: string | null = null;
  let depBlocks = false;
  if (depNames.length) {
    const plan = planSharedDeps(tool);
    if (plan && plan.missing.length === 0) {
      depNote = '依赖 ' + depNames.length + ' 个三方包，全部命中离线白名单：' + depNames.join(', ');
    } else {
      depBlocks = true;
      const missing = plan ? plan.missing : depNames;
      const policy = readDepPolicy();
      if (policy.allowUnvettedDeps) {
        reasons.push(
          '依赖 ' + missing.length + ' 个白名单外的三方包（' + missing.join(', ') + '）：会联网安装并执行，' +
            '代码来自 registry、未经本项目审核（联网开关当前由 ' + policy.origin + ' 打开）'
        );
      } else {
        const why = plan ? '不在离线白名单内' : '本机没有离线白名单目录';
        reasons.push(
          '依赖 ' + missing.length + ' 个白名单外的三方包（' + missing.join(', ') + '，' + why + '）：' +
            '装它等于把未经审核的外部代码拉进本机'
        );
      }
    }
  }
  const withDeps = (list: string[]): string[] => (depNote ? [...list, depNote] : list);
  // depBlocks 时一律 L3 + 人工；其它维度照常算，好让 reasons 完整
  const finish = (level: Grade['level'], needsHuman: boolean, approved: boolean): Grade =>
    depBlocks
      ? { level: 'L3', needsHuman: true, approved: false, reasons: withDeps(reasons) }
      : { level, needsHuman, approved, reasons: withDeps(reasons) };

  if (hasHigh) {
    const hits = [...new Set(findings.filter((f) => f.level === 'high').map((f) => f.msg))];
    reasons.push('静态扫描命中高危：' + hits.join('；'));
    return finish('L3', true, false);
  }

  if (tool.kind === 'shell' || p.exec) {
    reasons.push('可执行外部命令');
    return finish('L3', true, false);
  }

  if (p.fsWrite?.length || p.env?.length) {
    if (p.fsWrite?.length) reasons.push('可写文件：' + p.fsWrite.join(', '));
    if (p.env?.length) reasons.push('可读密钥：' + p.env.join(', '));
    // 写工作目录等于能改用户的项目源码，比写工具自己的 .data 危险得多，必须说清楚
    if (p.fsWrite?.includes(WORKSPACE_ROOT)) reasons.push('可写工作目录（会改动用户项目里的文件）');
    return finish('L2', true, false);
  }

  if (p.net?.length || p.fsRead?.length || tool.kind === 'script') {
    if (p.net?.length) reasons.push('可访问网络：' + p.net.join(', '));
    if (p.fsRead?.length) reasons.push('可读文件：' + p.fsRead.join(', '));
    if (p.fsRead?.includes(WORKSPACE_ROOT)) reasons.push('可读工作目录（会看到用户项目的源码）');
    if (tool.kind === 'script') reasons.push('需在沙箱内执行代码');
    return finish('L1', false, true);
  }

  reasons.push('无任何权限，仅做纯计算');
  return finish('L0', false, true);
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
