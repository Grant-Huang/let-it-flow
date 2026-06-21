import type { FileTaskStore, TaskMeta, TaskSummary } from "./task-store.js";

/**
 * 会话链聚合：按 conversationId 把多个 task（多轮追问）串成一条会话。
 *
 * 设计原则：
 *   - 不新建存储目录/表，完全复用 FileTaskStore.listAll() 扫描 meta.json
 *   - 进程内分组聚合，无独立持久化（会话是 task 的逻辑视图）
 *   - 会话量大时（P11 多租户）再考虑索引；MVP 内存扫描够用
 *
 * 会话首条 task 的意图作为会话标题；轮次按 createdAt 升序。
 */
export class ConversationStore {
  constructor(private readonly taskStore: FileTaskStore) {}

  /**
   * 取某会话内的全部 task，按 createdAt 升序（首轮在前，追问在后）。
   * 同毫秒创建的 task（如测试场景）用 parentTaskId 链深度做稳定 tiebreaker。
   */
  getTasks(conversationId: string): TaskSummary[] {
    const tasks = this.taskStore
      .listAll()
      .filter((t) => t.conversationId === conversationId);
    return sortByConversationOrder(tasks);
  }

  /**
   * 取会话内最近一个已成功（done）的 task。
   * 用于 customRunner 读取上一轮产物构造压缩上下文。
   * 无 done task 时返回 null（首轮或全部失败）。
   */
  getLatestCompleted(conversationId: string): TaskMeta | null {
    const tasks = this.getTasks(conversationId).filter((t) => t.status === "done");
    if (tasks.length === 0) return null;
    // 升序后取最后一个（最新的 done task）
    const latest = tasks[tasks.length - 1]!;
    return this.taskStore.get(latest.id);
  }

  /**
   * 列出所有会话摘要，按最近活跃时间降序。
   * 会话标题取首条 task（createdAt 最小者）的 intent。
   */
  listConversations(): ConversationSummary[] {
    const all = this.taskStore.listAll();
    const groups = new Map<string, TaskSummary[]>();
    for (const t of all) {
      const cid = t.conversationId;
      if (!cid) continue;
      const arr = groups.get(cid) ?? [];
      arr.push(t);
      groups.set(cid, arr);
    }

    const summaries: ConversationSummary[] = [];
    for (const [cid, tasks] of groups) {
      const sorted = sortByConversationOrder(tasks);
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      summaries.push({
        conversationId: cid,
        title: first.intent,
        taskCount: sorted.length,
        createdAt: first.createdAt,
        lastActiveAt: last.updatedAt ?? last.createdAt,
        lastStatus: last.status,
      });
    }
    return summaries.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * 取会话详情（含完整 task 链）。
   */
  getConversation(conversationId: string): ConversationDetail | null {
    const tasks = this.getTasks(conversationId);
    if (tasks.length === 0) return null;
    const first = tasks[0]!;
    const last = tasks[tasks.length - 1]!;
    return {
      conversationId,
      title: first.intent,
      taskCount: tasks.length,
      createdAt: first.createdAt,
      lastActiveAt: last.updatedAt ?? last.createdAt,
      lastStatus: last.status,
      tasks,
    };
  }
}

/** 会话摘要（listConversations 返回的轻量形态）。 */
export interface ConversationSummary {
  conversationId: string;
  /** 会话标题（首条 task 的 intent）。 */
  title: string;
  /** 会话内 task 总数（含首轮 + 追问轮）。 */
  taskCount: number;
  /** 首条 task 创建时间。 */
  createdAt: number;
  /** 最近一次 task 更新时间。 */
  lastActiveAt: number;
  /** 最近一次 task 状态。 */
  lastStatus: string;
}

/** 会话详情（含完整 task 链）。 */
export interface ConversationDetail extends ConversationSummary {
  /** 会话内全部 task（升序）。 */
  tasks: TaskSummary[];
}

/**
 * 会话内 task 的稳定排序：按 createdAt 升序，同毫秒时用 parentTaskId 链决定先后。
 *
 * tiebreaker 逻辑：
 *   - 主序：createdAt 升序（现实中追问一定晚于首轮）
 *   - 次序：parentTaskId 链深度（depth）小的排前面——首轮 depth=0，
 *     其直接追问 depth=1，以此类推。保证父-子先后顺序。
 *   - 末序：id 字典序（纯稳定兜底，避免 Array.sort 的不确定性）
 *
 * 这样即使两个 task 同毫秒创建（测试常见），也能按会话链拓扑正确排序。
 */
function sortByConversationOrder<T extends TaskSummary>(tasks: T[]): T[] {
  // depth：沿 parentTaskId 链回溯到会话根的跳数（首轮 depth=0）
  const idToTask = new Map(tasks.map((t) => [t.id, t] as const));
  const depthCache = new Map<string, number>();
  const depthOf = (t: TaskSummary): number => {
    if (depthCache.has(t.id)) return depthCache.get(t.id)!;
    let d = 0;
    let cur: TaskSummary | undefined = t;
    const seen = new Set<string>([t.id]);
    while (cur?.parentTaskId) {
      const parent = idToTask.get(cur.parentTaskId);
      if (!parent || seen.has(parent.id)) break; // 父不在本批或成环，停止
      seen.add(parent.id);
      d += 1;
      cur = parent;
    }
    depthCache.set(t.id, d);
    return d;
  };
  return [...tasks].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    const da = depthOf(a);
    const db = depthOf(b);
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
}
