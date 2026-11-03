// 启动器。有些环境（比如宿主本身就是 Electron 应用）会把 ELECTRON_RUN_AS_NODE=1
// 漏进子进程环境，导致 electron 退化成纯 Node、ipcMain 变 undefined。
// 这里先把它剔掉，再干干净净地拉起来。

delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('node:child_process') as typeof import('node:child_process');
const path = require('node:path') as typeof import('node:path');

// 未跑在 Electron 里时，require('electron') 返回的是可执行文件路径
const electronBinary = require('electron') as unknown as string;
const root = path.resolve(__dirname, '..', '..');

const child = spawn(electronBinary, [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
  env: process.env,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
