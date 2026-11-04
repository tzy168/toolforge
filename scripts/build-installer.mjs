// 生成单文件安装包：release/ToolForge-Setup-<版本>.exe
//
// 流程：release 目录 → zip 负载 → csc 编译自解压桩 → 桩 + 标记 + 负载 拼成一个 exe。
// 全程离线：不碰 GitHub，不需要 NSIS，也不需要 7z 的 SFX 模块（本机都没有）。
//
// 跑法：
//   node scripts/build-installer.mjs                # 用现成的 release 目录
//   node scripts/build-installer.mjs --build        # 先重新打包再出安装包
//   node scripts/build-installer.mjs --out=D:\\x.exe
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CACHE = path.join(ROOT, ".pack-cache", "installer");
const RELEASE = path.join(ROOT, "release", "ToolForge-win32-x64");
const STUB_SRC = path.join(ROOT, "scripts", "installer-stub.cs");
const MARKER = "\nTF_SFX_V1\n";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const BUILD_FIRST = process.argv.includes("--build");

const log = (s) => console.log("  · " + s);

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 900000, ...(opts || {}) });
  if (res.status !== 0) {
    throw new Error(cmd + " 失败（code=" + res.status + "）：" + String(res.stderr || res.stdout || "").slice(-1200));
  }
  return res.stdout || "";
}

function countTree(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function findCsc() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("找不到 csc.exe：需要 .NET Framework 4.x（Windows 自带）。没有它就只能先用绿色目录分发");
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = pkg.version || "0.0.0";
  const outFile = path.resolve(ROOT, arg("out", "release/ToolForge-Setup-" + version + ".exe"));

  if (BUILD_FIRST) {
    log("先重新打包桌面产物…");
    run(process.execPath, [path.join(ROOT, "scripts", "build-desktop.mjs")]);
  }
  if (!fs.existsSync(path.join(RELEASE, "ToolForge.exe"))) {
    throw new Error("release 目录里没有 ToolForge.exe：先跑 pnpm pack:desktop，或加 --build");
  }

  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });

  // ---- 1) 编译桩 ----
  const stubExe = path.join(CACHE, "stub.exe");
  const csc = findCsc();
  log("编译自解压桩（" + path.basename(csc) + "）");
  run(csc, [
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    "/r:System.Windows.Forms.dll",
    "/r:System.IO.Compression.dll",
    "/r:System.IO.Compression.FileSystem.dll",
    "/out:" + stubExe,
    STUB_SRC,
  ]);
  const stubBytes = fs.statSync(stubExe).size;
  log("桩大小 " + (stubBytes / 1024).toFixed(1) + "KB");

  // ---- 2) 打 zip 负载 ----
  const payload = path.join(CACHE, "payload.zip");
  log("压缩 release 目录…");
  const ps = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[System.IO.Compression.ZipFile]::CreateFromDirectory('" + RELEASE.replace(/'/g, "''") + "', '" + payload.replace(/'/g, "''") + "', [System.IO.Compression.CompressionLevel]::Optimal, $false)",
  ].join("; ");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  const payloadBytes = fs.statSync(payload).size;
  const release = countTree(RELEASE);
  log("负载 " + (payloadBytes / 1024 / 1024).toFixed(1) + "MB（原目录 " + (release.bytes / 1024 / 1024).toFixed(1) + "MB / " + release.files + " 个文件）");

  // ---- 3) 拼接：桩 + 标记 + 负载 ----
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, fs.readFileSync(stubExe));
  fs.appendFileSync(outFile, Buffer.from(MARKER, "ascii"));
  fs.appendFileSync(outFile, fs.readFileSync(payload));

  const total = fs.statSync(outFile).size;
  console.log("\n完成：" + outFile);
  console.log("  " + (total / 1024 / 1024).toFixed(1) + "MB · v" + version);
  console.log("  静默安装：\"" + path.basename(outFile) + "\" /S /D=<目录>");
  console.log("  提示：这是未签名的自解压包，Windows SmartScreen 会提示未知发布者——签名需要代码签名证书，本项目目前没有。");

  fs.rmSync(CACHE, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("\n出安装包失败：" + err.message);
  process.exitCode = 1;
});
