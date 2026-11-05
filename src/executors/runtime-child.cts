'use strict';
// 沙箱子进程的引导层。工具代码在这里被加载，但拿不到原生网络模块。
// 说清楚：这不是形式化沙箱，是三层防线叠加——
//   1) Node --permission 限制文件读写范围与子进程
//   2) 本文件锁定 Module._load，掐断 http/https/net/child_process
//   3) 只向工具注入受控的 ctx.net / ctx.fs

/* eslint-disable @typescript-eslint/no-explicit-any */

const Module = require('node:module') as any;
const path = require('node:path') as typeof import('node:path');
const fsNative = require('node:fs') as typeof import('node:fs');
const httpsNative = require('node:https') as typeof import('node:https');
const httpNative = require('node:http') as typeof import('node:http');

/**
 * 内建模块白名单：只放行「纯计算、不碰文件 / 网络 / 进程」的那一小撮根基。
 *
 * 原来是列黑名单——http、fs、child_process 逐个枚举，漏一个就是一道口子：实测
 * require('node:fs') 能绕过 guardFs，require('module') 还能把 Module._load 改回来。
 * 改成白名单后，没列进来的内建模块一律拒绝；非内建（相对路径、三方依赖）仍交给
 * 原始加载器，工具声明的依赖照常 require。
 *
 * 代价：三方依赖若在初始化时 require('fs') 之类，会被拒。这是刻意的安全取舍——
 * 运行时降级到无 OS 权限开关时，这层是唯一的文件防线；宁可让这类依赖跑不起来。
 */
const ALLOW_BUILTIN_ROOTS = new Set([
  'assert', 'buffer', 'constants', 'crypto', 'events', 'path', 'punycode',
  'querystring', 'stream', 'string_decoder', 'timers', 'url', 'util', 'zlib',
  'async_hooks', 'diagnostics_channel', 'perf_hooks',
]);

/** Node 20.10+ 有 isBuiltin；老版本用 builtinModules 兜底 */
const isBuiltinRequest = (id: string): boolean => {
  if (id.startsWith('node:')) return true;
  if (typeof Module.isBuiltin === 'function') return Boolean(Module.isBuiltin(id));
  const roots: string[] = (Module.builtinModules || []).map((n: string) =>
    String(n).replace(/^node:/, '').split('/')[0]
  );
  return roots.includes(id.split('/')[0]);
};

const HINT: Record<string, string> = {
  fs: '文件请走 ctx.fs',
  http: '网络请走 ctx.net',
  https: '网络请走 ctx.net',
  net: '网络请走 ctx.net',
  tls: '网络请走 ctx.net',
  dgram: '网络请走 ctx.net',
  http2: '网络请走 ctx.net',
  module: '不允许改写模块加载器',
  vm: '不允许在沙箱内再开执行上下文',
  child_process: '不允许拉起子进程',
  process: '不允许直接加载 process 模块',
};

interface Payload {
  input?: Record<string, unknown>;
  perm?: { net?: string[]; fsRead?: string[]; fsWrite?: string[] };
  toolDir?: string;
  dataDir?: string;
  workspace?: string | null;
  allowedEnv?: string[];
  entry?: string;
}

interface HttpResult {
  status: number | undefined;
  headers: Record<string, unknown>;
  text: string;
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => {
  stdinBuf += d;
});
process.stdin.on('end', () => {
  run().then(
    (result) => finish({ ok: true, result }),
    (err: Error) => finish({ ok: false, error: err && err.message ? err.message : String(err) })
  );
});

function finish(payload: { ok: boolean; result?: unknown; error?: string }): void {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = JSON.stringify({ ok: false, error: '工具返回值无法序列化为 JSON' });
  }
  if (text.length > 2_000_000) {
    text = JSON.stringify({ ok: false, error: '工具返回值超过 2MB 上限' });
  }
  process.stdout.write(text, () => process.exit(0));
}

async function run(): Promise<unknown> {
  const req = JSON.parse(stdinBuf || '{}') as Payload;
  const input = req.input ?? {};
  const perm = req.perm ?? {};
  const toolDir = req.toolDir ?? '';
  const dataDir = req.dataDir ?? '';
  const workspace = req.workspace ?? null;
  const allowedEnv = req.allowedEnv ?? [];

  // 工具自己的 console.log 不能污染 stdout 的结果通道
  const toErr = (...a: unknown[]): void => {
    process.stderr.write(a.map(String).join(' ') + '\n');
  };
  console.log = toErr;
  console.info = toErr;
  console.warn = toErr;
  console.debug = toErr;

  // 与 core/permissions.ts 的 hostAllowed 规则保持一致，但这里必须自带一份：
  // 子进程的 --allow-fs-read 只放行工具目录与本引导层，require 不到 src/ 下的其它模块。
  const hostOk = (host: string): boolean => {
    const h = String(host || '').toLowerCase();
    return (perm.net || []).some((rule) => {
      const r = String(rule).toLowerCase();
      if (r === '*') return false; // 通配全部域名一律拒绝，与宿主侧同款
      if (r.startsWith('*.')) {
        const base = r.slice(2);
        return h === base || h.endsWith('.' + base);
      }
      return h === r;
    });
  };

  function rawRequest(urlStr: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<HttpResult> {
    const u = new URL(urlStr);
    if (!hostOk(u.hostname)) {
      return Promise.reject(new Error(`权限拒绝：未声明访问域名 ${u.hostname}`));
    }
    return new Promise((resolve, reject) => {
      const lib = u.protocol === 'https:' ? httpsNative : httpNative;
      const req2 = lib.request(u, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 5_000_000) {
            req2.destroy();
            reject(new Error('响应体超过 5MB 上限'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers as Record<string, unknown>, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req2.on('error', reject);
      req2.setTimeout(opts.timeoutMs || 20000, () => req2.destroy(new Error('请求超时')));
      if (opts.body != null) req2.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      req2.end();
    });
  }

  // 读：相对工具包目录（可读自己带的数据文件）；写：相对数据目录（.data）
  // 例外是 @workspace：指向用户选中的项目文件夹，路径由宿主传进来。
  // 沙箱不自己猜工作目录，宿主没传就等于没这个根——宁可拒绝，不可越权。
  function guardFs(target: string, roots: string[] | undefined, action: '读' | '写'): string {
    const raw = String(target);
    const list = roots || [];
    const defaultBase = action === '写' ? dataDir : toolDir;
    const hasWs = list.includes('@workspace') && Boolean(workspace);

    const candidates = path.isAbsolute(raw)
      ? [path.resolve(raw)]
      : [
          // 先按默认根解释；同时声明了 @workspace 时再试一次工作目录。
          // 这样既照顾「工具自带的相对路径」，也照顾「项目里的相对路径」，
          // 而不是逼工具作者为两种根分别拼绝对路径。
          path.resolve(defaultBase, raw),
          ...(hasWs ? [path.resolve(workspace as string, raw)] : []),
        ];

    for (const abs of candidates) {
      const allowed = list.some((root) => {
        const r =
          root === '@workspace' ? (workspace ? path.resolve(workspace) : null) : path.resolve(defaultBase, root);
        if (!r) return false;
        return abs === r || abs.startsWith(r + path.sep);
      });
      if (allowed) return abs;
    }
    throw new Error(
      `权限拒绝：未获准${action} ${candidates[0]}（已声明：${list.join(', ') || '无'}）`
    );
  }

  const ctx = {
    input,
    workdir: dataDir,
    // 用户选中的项目目录。未选择时为 null，工具应据此提示用户先选目录。
    workspace,
    log: toErr,
    sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 30000))),
    env: (key: string): string | undefined => (allowedEnv.includes(key) ? process.env[key] : undefined),
    net: {
      async get(url: string, opts?: Record<string, unknown>): Promise<string> {
        const res = await rawRequest(url, opts ?? {});
        if ((res.status ?? 0) >= 400) throw new Error(`HTTP ${res.status}`);
        return res.text;
      },
      async json(url: string, opts?: Record<string, unknown>): Promise<unknown> {
        const text = await rawRequest(url, opts ?? {});
        try {
          return JSON.parse(text.text);
        } catch {
          throw new Error(`响应非 JSON：${text.text.slice(0, 200)}`);
        }
      },
      async request(url: string, opts?: Record<string, unknown>): Promise<HttpResult> {
        return rawRequest(url, opts ?? {});
      },
    },
    fs: {
      read(p: string): string {
        return fsNative.readFileSync(guardFs(p, perm.fsRead, '读'), 'utf8');
      },
      readJson(p: string): unknown {
        return JSON.parse(fsNative.readFileSync(guardFs(p, perm.fsRead, '读'), 'utf8'));
      },
      write(p: string, data: unknown): string {
        const f = guardFs(p, perm.fsWrite, '写');
        fsNative.mkdirSync(path.dirname(f), { recursive: true });
        fsNative.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
        return f;
      },
      exists(p: string): boolean {
        try {
          return fsNative.existsSync(guardFs(p, perm.fsRead, '读'));
        } catch {
          return false;
        }
      },
      list(p: string): string[] {
        return fsNative.readdirSync(guardFs(p, perm.fsRead, '读'));
      },
    },
  };

  // 收网：此后工具代码再也 require 不到原生网络与子进程
  //
  // 但 require 不是唯一入口。全局 fetch / WebSocket / XMLHttpRequest 不经过 Module._load，
  // process.getBuiltinModule('http') 也能直接取到原生网络模块——一个零 net 声明、判 L1
  // 自动放行的 script 工具用它们就能把数据发出去，而 Node 的 --permission 不约束网络。
  // 所以加载工具入口之前先把这几个入口收掉；ctx.net 用的是上面已缓存的 httpNative /
  // httpsNative，不受影响。
  //
  // 内建模块的封堵见下面的白名单。这仍不是形式化边界：工具把全局写回来、或借已
  // 放行模块做侧信道，都不在这里保证。三方库若在初始化时依赖全局 fetch 或被禁的
  // 内建模块（如 fs），会在这一步之后报错，属于已知的兼容性代价。
  const stripGlobal = (key: string): void => {
    try {
      Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
    } catch {
      // 极少数运行时不允许重定义全局，退化成直接赋值
      try {
        (globalThis as unknown as Record<string, unknown>)[key] = undefined;
      } catch {
        /* 忽略 */
      }
    }
  };
  for (const key of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) stripGlobal(key);
  try {
    Object.defineProperty(process, 'getBuiltinModule', { value: undefined, configurable: true, writable: true });
  } catch {
    /* 老运行时没有这个 API，本来就不存在这条路径 */
  }

  const origLoad = Module._load;
  const patchedLoad = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    const id = String(request);
    if (isBuiltinRequest(id)) {
      const root = id.replace(/^node:/, '').split('/')[0];
      if (!ALLOW_BUILTIN_ROOTS.has(root)) {
        const hint = HINT[root] ? `（${HINT[root]}）` : '';
        throw new Error(`安全策略：禁止加载内建模块 ${id}${hint}；工具只能 require 已放行的纯计算内建模块与三方依赖`);
      }
    }
    return origLoad.call(this, request, parent, isMain);
  };
  // 工具模块作用域里的 module.constructor 就是 Module 类；不冻结的话，改一行
  // module.constructor._load = ... 就能把上面的检查整个摘掉。
  try {
    Object.defineProperty(Module, '_load', { value: patchedLoad, writable: false, configurable: false });
  } catch {
    Module._load = patchedLoad; // 极少数运行时不允许重定义，退化为可写赋值
  }

  // process 上还留着几条不走 Module._load 的捷径，一并收掉。
  const stripProcess = (key: string): void => {
    try {
      Object.defineProperty(process, key, { value: undefined, configurable: true, writable: true });
    } catch {
      /* 运行时没有或不许改这个属性，忽略 */
    }
  };
  for (const key of ['binding', 'dlopen', '_linkedBinding']) stripProcess(key);
  try {
    Object.defineProperty(process, 'mainModule', { value: null, configurable: true, writable: true });
  } catch {
    /* 忽略 */
  }

  if (!req.entry) throw new Error('缺少入口文件');
  const mod = origLoad.call(Module, path.resolve(req.entry), null, false);
  const fn = typeof mod === 'function' ? mod : mod && mod.default;
  if (typeof fn !== 'function') {
    throw new Error('工具入口必须导出一个 async 函数：(input, ctx) => result');
  }
  return await fn(input, ctx);
}
