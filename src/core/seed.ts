import { store } from './store.js';
import { normalizeTool, type RawTool } from './spec.js';

// 开箱的两件家什：一件纯算，一件取数。让 Agent 一开机就有活可干。

const SEEDS: RawTool[] = [
  {
    name: 'text_stats',
    description: '统计一段文本的字数、词数、行数与非空白字符数。纯本地计算，不需要任何权限。',
    kind: 'transform',
    input: {
      type: 'object',
      properties: { text: { type: 'string', description: '待统计的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    impl: {
      code: String.raw`if (typeof input.text !== 'string') throw new Error('text 必须是字符串');
var t = input.text;
return {
  chars: t.length,
  nonSpace: t.replace(/\s/g, '').length,
  words: (t.match(/[A-Za-z0-9_]+|[\u4e00-\u9fa5]/g) || []).length,
  lines: t ? t.split(/\n/).length : 0,
};`,
    },
    permissions: {},
    examples: [{ name: '英文短句', args: { text: 'hello world' }, expect: 'result.words === 2 && result.chars === 11' }],
    meta: { tags: ['text', '本地'], author: 'seed', source: 'seed' },
    status: 'active',
    trust: 'L0',
  },
  {
    name: 'github_repo_info',
    description: '查询 GitHub 仓库的基本信息：星数、语言、描述、最近更新时间。入参为 owner/name。',
    kind: 'http',
    input: {
      type: 'object',
      properties: { repo: { type: 'string', description: '形如 nodejs/node' } },
      required: ['repo'],
      additionalProperties: false,
    },
    impl: {
      method: 'GET',
      url: 'https://api.github.com/repos/{{input.repo}}',
      headers: { 'User-Agent': 'toolforge', Accept: 'application/vnd.github+json' },
      extract: '',
    },
    permissions: { net: ['api.github.com'] },
    examples: [{ name: '查 nodejs/node', args: { repo: 'nodejs/node' }, expect: "result && result.full_name === 'nodejs/node'" }],
    meta: { tags: ['github', '网络'], author: 'seed', source: 'seed' },
    status: 'active',
    trust: 'L1',
  },
];

export function installSeeds(): string[] {
  if (store.list().length > 0) return [];
  const installed: string[] = [];
  for (const seed of SEEDS) {
    try {
      const tool = normalizeTool(seed);
      store.save(tool);
      installed.push(tool.name);
    } catch {
      /* 种子坏了不该拦着开机 */
    }
  }
  return installed;
}
