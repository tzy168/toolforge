// 把 marked / dompurify 的 ESM 产物拷进界面目录。
// 界面是纯 HTML，没有打包器，只能相对路径 import；CSP 又不允许从 CDN 取，所以必须落盘。
import fs from 'node:fs';
import path from 'node:path';

const from = (p) => path.join(process.cwd(), 'node_modules', p);
const to = (p) => path.join(process.cwd(), 'src', 'ui', 'build', 'vendor', p);

const files = [
  ['marked/lib/marked.esm.js', 'marked.esm.js'],
  ['dompurify/dist/purify.es.mjs', 'purify.es.mjs'],
];

fs.mkdirSync(path.dirname(to('x')), { recursive: true });
for (const [src, dest] of files) {
  fs.copyFileSync(from(src), to(dest));
}
console.log(`[vendor] ${files.length} 个前端依赖已就位`);
