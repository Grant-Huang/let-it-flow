import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, statSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTasksDir, getArtifactsDir, ensureStorageDirs } from "../core/config.js";

/**
 * 最小文件存储：任务相关文件的读写封装。
 * 存储布局（见 08 §8.5）：
 *   data/tasks/{taskId}/meta.json     — 任务元数据（单文件覆盖写）
 *   data/tasks/{taskId}/events.jsonl  — 事件追加日志（断线重连续传用）
 *   data/artifacts/{taskId}/          — 产物目录
 */

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 原子地写入 JSON 文件（写临时文件后 rename，避免半写）。 */
export function writeJsonAtomicSync(filePath: string, data: unknown): void {
  ensureDir(resolve(filePath, ".."));
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  // 同目录 rename 是原子的（POSIX）
  renameSync(tmp, filePath);
}

/** 读 JSON 文件；不存在返回 null。 */
export function readJsonSync<T = unknown>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 向 jsonl 文件追加一行（自动建目录）。 */
export function appendJsonlLine(filePath: string, line: unknown): void {
  ensureDir(resolve(filePath, ".."));
  appendFileSync(filePath, `${JSON.stringify(line)}\n`, "utf8");
}

/** 读 jsonl 文件全部行；不存在返回空数组。 */
export function readJsonlSync<T = unknown>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  const out: T[] = [];
  for (const ln of content.split("\n")) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // 跳过损坏行（如崩溃时半写的最后一行）
    }
  }
  return out;
}

/** 读 jsonl 文件从指定 seq 起的行（用于断线重连 ?since=N）。 */
export function readJsonlSinceSync<T extends { seq: number }>(
  filePath: string,
  since: number,
): T[] {
  const all = readJsonlSync<T>(filePath);
  return all.filter((e) => e.seq > since);
}

/** 任务目录路径。 */
export function taskDir(taskId: string): string {
  return join(getTasksDir(), taskId);
}

/** 任务 meta.json 路径。 */
export function taskMetaPath(taskId: string): string {
  return join(taskDir(taskId), "meta.json");
}

/** 任务 events.jsonl 路径。 */
export function taskEventsPath(taskId: string): string {
  return join(taskDir(taskId), "events.jsonl");
}

/** 产物目录路径。 */
export function taskArtifactsDir(taskId: string): string {
  return join(getArtifactsDir(), taskId);
}

/** 列出所有任务 id（按创建时间倒序）。用于管理/调试。 */
export function listTaskIds(): string[] {
  const tasksDir = getTasksDir();
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((name) => {
      const p = join(tasksDir, name);
      return statSync(p).isDirectory() && existsSync(join(p, "meta.json"));
    })
    .sort()
    .reverse();
}

// 重新导出 ensureStorageDirs（向后兼容旧导入位置）。
export { ensureStorageDirs };
