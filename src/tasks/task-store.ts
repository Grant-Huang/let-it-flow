import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  writeJsonAtomicSync,
  readJsonSync,
  appendJsonlLine,
  readJsonlSync,
  readJsonlSinceSync,
  taskMetaPath,
  taskEventsPath,
  ensureStorageDirs,
} from "../storage/file-store.js";
import type { StreamEvent, StreamEventType } from "../core/stream-events.js";

/**
 * 任务状态机（见 12 §12.3）：
 *   pending → running → done
 *                    ↘ error
 *                    ↘ pending_confirmation → running（confirm 后）→ done
 *                                           ↘ aborted（拒绝确认）
 *
 * pending_confirmation 是 HITL 暂停态：executor 遇到 requireConfirmation 节点
 * 时进入，POST /confirm 决策后回到 running 或 aborted。
 */
export const TASK_STATUSES = [
  "pending",
  "running",
  "pending_confirmation",
  "done",
  "error",
  "aborted",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskMeta = z.object({
  id: z.string(),
  intent: z.string(),
  status: z.enum(TASK_STATUSES),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 当前已持久化的最大 seq（用于断线重连 / since 校验）。 */
  lastSeq: z.number().int().nonnegative().default(0),
  /** 触发本次创建的请求体（配置、模板等）。 */
  config: z.record(z.string(), z.unknown()).default({}),
  /** 错误信息（仅 status=error）。 */
  error: z.string().optional(),
});
export type TaskMeta = z.infer<typeof TaskMeta>;

/**
 * 文件系统任务存储：每个任务一个目录，meta.json + events.jsonl。
 * 事件追加写（append-only），meta 覆盖写（原子 rename）。
 *
 * seq 由 store 单调递增分配（进程内自增 + 文件 lastSeq 兜底）。
 */
export class FileTaskStore {
  constructor() {
    ensureStorageDirs();
  }

  /** 创建新任务，返回 meta。 */
  create(intent: string, config: Record<string, unknown> = {}): TaskMeta {
    const now = Date.now();
    const meta: TaskMeta = {
      id: cryptoRandomId(),
      intent,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      config,
    };
    writeJsonAtomicSync(taskMetaPath(meta.id), meta);
    return meta;
  }

  /** 读取任务 meta；不存在返回 null。 */
  get(taskId: string): TaskMeta | null {
    return readJsonSync<TaskMeta>(taskMetaPath(taskId));
  }

  /** 更新 meta（合并写）。 */
  update(taskId: string, patch: Partial<TaskMeta>): TaskMeta | null {
    const cur = this.get(taskId);
    if (!cur) return null;
    const next: TaskMeta = { ...cur, ...patch, id: cur.id, updatedAt: Date.now() };
    writeJsonAtomicSync(taskMetaPath(taskId), next);
    return next;
  }

  /** 设置状态。 */
  setStatus(taskId: string, status: TaskStatus, error?: string): TaskMeta | null {
    return this.update(taskId, { status, error });
  }

  /**
   * 追加一个事件并分配 seq，原子落库到 events.jsonl。
   * 返回带 seq 的完整事件。
   */
  append(taskId: string, event: Omit<StreamEvent, "seq">): StreamEvent {
    const meta = this.get(taskId);
    if (!meta) throw new Error(`task not found: ${taskId}`);
    const seq = meta.lastSeq + 1;
    const full: StreamEvent = { ...event, seq } as StreamEvent;
    appendJsonlLine(taskEventsPath(taskId), full);
    this.update(taskId, { lastSeq: seq });
    return full;
  }

  /** 读全部事件。 */
  readAll(taskId: string): StreamEvent[] {
    return readJsonlSync<StreamEvent>(taskEventsPath(taskId));
  }

  /** 从 since 之后读事件（断线重连）。 */
  readSince(taskId: string, since: number): StreamEvent[] {
    return readJsonlSinceSync<StreamEvent>(taskEventsPath(taskId), since);
  }

  /** 按 type 过滤事件（调试/产物聚合用）。 */
  readByType(taskId: string, type: StreamEventType): StreamEvent[] {
    return this.readAll(taskId).filter((e) => e.type === type);
  }
}

/** 生成短随机 id（前缀 t = task）。 */
function cryptoRandomId(): string {
  return `t_${randomUUID().slice(0, 12)}`;
}
