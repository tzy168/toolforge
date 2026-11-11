// human-in-loop：挂起一次工具调用，等人工决定，再把决定交回执行闸门。
//
// 这里不直接跟界面打交道：只发一个 AgentEvent、等一个 resolve。
// 桌面端由渲染层弹条、CLI 与测试注入 responder，三条路共用同一套超时与审计。
import { randomUUID } from 'node:crypto';
import type { AccessLevel, AgentEvent, ApprovalDecision, ApprovalRequest } from '../types.js';

type Emitter = (event: AgentEvent) => void;
type Responder = (req: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;

/** 没等到人回复就按拒绝处理，别让一轮对话永久挂着 */
export const APPROVAL_TIMEOUT_MS = 120000;

export interface ApprovalResult {
  decision: ApprovalDecision;
  /** 超时 / 中止导致的拒绝，文案要和「用户主动点了拒绝」区分开 */
  timedOut: boolean;
}

interface Pending {
  req: ApprovalRequest;
  settle: (result: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

let emitter: Emitter = () => {};
let responder: Responder | null = null;
const pending = new Map<string, Pending>();
/** 「本会话允许」只记在内存里：换一次会话就要重新点头，不落盘 */
const grants = new Set<string>();

export function setApprovalEmitter(fn: Emitter): void {
  emitter = fn;
}

/** 非交互环境（CLI / 单测）注入一个自动应答，避免事件没人接而干等超时 */
export function setApprovalResponder(fn: Responder | null): void {
  responder = fn;
}

export function isGranted(key: string): boolean {
  return grants.has(key);
}

export function clearGrants(): void {
  grants.clear();
}

export function pendingApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.req);
}

/** 人点了按钮。返回 false 表示这条请求已经不在队列里（超时或重复点击） */
export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const item = pending.get(id);
  if (!item) return false;
  finish(item, { decision, timedOut: false });
  if (decision === 'allow_always') grants.add(item.req.grantKey);
  return true;
}

/** 暂停一轮对话或关窗时，把所有挂起的请求按拒绝收尾，别留下永不 resolve 的 Promise */
export function cancelAll(): void {
  for (const item of [...pending.values()]) finish(item, { decision: 'deny', timedOut: false });
}

function finish(item: Pending, result: ApprovalResult): void {
  clearTimeout(item.timer);
  if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
  pending.delete(item.req.id);
  emitter({
    type: 'approval_resolved',
    approval: item.req,
    decision: result.decision,
    timedOut: result.timedOut,
  });
  item.settle(result);
}

export interface ApprovalInput {
  tool: string;
  /** 给用户看的一句话：这次到底要做什么 */
  action: string;
  /** 为什么要请示（命令分级给的理由） */
  reason: string;
  level: AccessLevel;
  /** 「本会话允许」的记忆键，通常是 工具名 + 命令 */
  grantKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestApproval(input: ApprovalInput): Promise<ApprovalResult> {
  if (isGranted(input.grantKey)) return { decision: 'allow_once', timedOut: false };

  const req: ApprovalRequest = {
    id: `ap_${randomUUID().slice(0, 8)}`,
    tool: input.tool,
    action: input.action,
    reason: input.reason,
    level: input.level,
    grantKey: input.grantKey,
    at: new Date().toISOString(),
  };

  if (responder) {
    const decision = await responder(req);
    if (decision === 'allow_always') grants.add(input.grantKey);
    emitter({ type: 'approval_resolved', approval: req, decision, timedOut: false });
    return { decision, timedOut: false };
  }

  return new Promise<ApprovalResult>((resolve) => {
    const settle = (result: ApprovalResult): void => resolve(result);
    const timer = setTimeout(() => {
      const item = pending.get(req.id);
      if (item) finish(item, { decision: 'deny', timedOut: true });
    }, input.timeoutMs ?? APPROVAL_TIMEOUT_MS);

    const item: Pending = { req, settle, timer, signal: input.signal };
    pending.set(req.id, item);

    if (input.signal) {
      if (input.signal.aborted) {
        finish(item, { decision: 'deny', timedOut: false });
        return;
      }
      item.onAbort = () => {
        if (pending.has(req.id)) finish(item, { decision: 'deny', timedOut: false });
      };
      input.signal.addEventListener('abort', item.onAbort, { once: true });
    }

    emitter({ type: 'approval_request', approval: req });
  });
}
