// vendor 里的两份 ESM 产物由 scripts/copy-ui-vendor.mjs 从 node_modules 拷来，
// 只有运行时文件、没有类型，这里手工声明用到的接口。
declare module '*/vendor/marked.esm.js' {
  export const marked: {
    parse(src: string, opts?: Record<string, unknown>): string;
  };
}

declare module '*/vendor/purify.es.mjs' {
  const DOMPurify: {
    sanitize(dirty: string, opts?: Record<string, unknown>): string;
  };
  export default DOMPurify;
}
