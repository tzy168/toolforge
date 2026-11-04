// 打包自检：在「真实的打包形态」下把三方依赖链路完整走一遍。
//
// 为什么非要跑在打包后的应用里：开发态 process.execPath 是 node.exe，同级就带 npm；
// 打包态是 ToolForge.exe，npm 只能靠随包分发。这两条路径的差别恰好就是
// 「双击图标启动还能不能用」的全部内容——在开发态跑一百遍也验不出这个差别。
//
// 由 electron/main.cts 在 TF_PACK_SELFTEST=1 时调用，结果作为一行 JSON 打到 stdout。
import fs from 'node:fs';
import path from 'node:path';
import { appRootDir, bundledNpmCli, isPackaged, resourcesDir, sharedDepsRoot } from './appPaths.js';
import { depsReady, installToolDeps, planSharedDeps } from './deps.js';
import { toolDir } from './paths.js';
import { permissionSupport, runScript } from '../executors/script.js';
import type { Tool } from '../types.js';

export interface PackSelfTestReport {
  /** 这次自检确实跑在打包形态里吗 */
  packaged: boolean;
  appRoot: string;
  resources: string | null;
  sharedDepsRoot: string | null;
  bundledNpmCli: string | null;
  node: string;
  electron: string | null;
  /** 白名单计划的命中情况；null 表示本机没有白名单目录 */
  sharedPlan: { missing: string[]; closure: string[] } | null;
  install: {
    ok: boolean;
    skipped: boolean;
    manager: string;
    ms: number;
    packages: Array<{ name: string; version: string; integrity: string | null }>;
    totalBytes: number;
    transitiveCount: number;
  } | null;
  depsReady: boolean | null;
  run: { ok: boolean; version: string | null; sandboxNet: boolean } | null;
  perm: { probed: boolean; flag: string | null } | null;
  error?: string;
}

/**
 * 自检用的工具代码。不写死某个库的用法，只回答三个问题：
 * require 能不能拿到、拿到的是哪个版本、沙箱的 ctx.net 有没有被依赖削弱。
 */
function selftestCode(depName: string): string {
  return [
    `const NAME = ${JSON.stringify(depName)};`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'module.exports = async (input, ctx) => {',
    '  const mod = require(NAME);',
    '  const entry = require.resolve(NAME);',
    '  let dir = path.dirname(entry);',
    '  let version = null;',
    '  for (let i = 0; i < 6; i++) {',
    "    const f = path.join(dir, 'package.json');",
    '    if (fs.existsSync(f)) {',
    "      version = JSON.parse(fs.readFileSync(f, 'utf8')).version;",
    '      break;',
    '    }',
    '    const up = path.dirname(dir);',
    '    if (up === dir) break;',
    '    dir = up;',
    '  }',
    '  return {',
    '    loaded: mod !== null && mod !== undefined,',
    '    version,',
    "    resolveTail: path.basename(path.dirname(entry)) + '/' + path.basename(entry),",
    "    sandboxNet: typeof ctx.net?.get === 'function',",
    '    input,',
    '  };',
    '};',
  ].join('\n');
}

export async function runPackSelfTest(opts: { depName?: string; depVersion?: string; keepDir?: boolean } = {}): Promise<PackSelfTestReport> {
  const depName = opts.depName || 'dayjs';
  const depVersion = opts.depVersion || '1.11.13';
  const id = 'pack_selftest';
  const dir = toolDir(id);

  const report: PackSelfTestReport = {
    packaged: isPackaged(),
    appRoot: appRootDir(),
    resources: resourcesDir(),
    sharedDepsRoot: sharedDepsRoot(),
    bundledNpmCli: bundledNpmCli(),
    node: process.version,
    electron: process.versions.electron ?? null,
    sharedPlan: null,
    install: null,
    depsReady: null,
    run: null,
    perm: null,
  };

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.cjs'), selftestCode(depName), 'utf8');

    const tool: Tool = {
      id,
      name: 'pack_selftest',
      version: '0.0.0',
      description: '打包自检：验证随包 npm 与随包依赖在真实打包形态下可用',
      kind: 'script',
      input: { type: 'object', properties: {} },
      impl: { entry: 'index.cjs', code: null, deps: { [depName]: depVersion }, timeoutMs: 30000 },
      permissions: { net: [], fsRead: [], fsWrite: [], exec: false, env: [] },
      examples: [],
      meta: { tags: [], author: 'pack-selftest', source: 'pack-selftest', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      status: 'untested',
      trust: 'L0',
      sessionId: null,
    };

    const plan = planSharedDeps(tool);
    report.sharedPlan = plan ? { missing: plan.missing, closure: plan.closure } : null;

    const res = await installToolDeps(tool);
    report.install = {
      ok: res.ok,
      skipped: res.skipped,
      manager: res.manager,
      ms: res.ms,
      packages: res.installed,
      totalBytes: res.totalBytes,
      transitiveCount: res.transitiveCount,
    };
    report.depsReady = depsReady(tool);

    const out = (await runScript(tool, {})) as { version?: string; sandboxNet?: boolean };
    report.run = { ok: true, version: typeof out?.version === 'string' ? out.version : null, sandboxNet: out?.sandboxNet === true };
    report.perm = permissionSupport();
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    report.perm = permissionSupport();
  } finally {
    if (!opts.keepDir) fs.rmSync(dir, { recursive: true, force: true });
  }

  return report;
}
