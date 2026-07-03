/**
 * 轻量启动日志（E 层 —— 平台基础设施）。
 *
 * 双写：控制台 + 滚动日志文件，无第三方依赖。
 *
 * 设计要点：
 *   - 标准库 fs 实现，按天滚动文件（nexusops-YYYY-MM-DD.log）
 *   - 行级追加写（appendFileSync），无需手动管理文件句柄
 *   - 写文件失败降级（仅控制台，进程不挂）
 *   - 三个语义级别对齐 console：log/warn/error
 *   - 缺省 logDir 时仅写控制台（向后兼容 / 测试不依赖 fs）
 *
 * 使用：
 *   const log = createBootLogger({ logDir: "<dataDir>/logs", ns: "nexusops" });
 *   log.info("MCP server 预热完成");       // → 控制台 + 文件
 *   log.warn("...降级...");                 // → 控制台 stderr + 文件
 *
 * 日志目录由调用方解析（不强绑 getDataDir/resolveAppDataDir），保持模块边界清晰。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 构造选项。 */
export interface BootLoggerOptions {
  /** 日志目录（缺省则仅控制台输出）。 */
  logDir?: string;
  /** 日志命名空间前缀（如 "nexusops"）。 */
  ns?: string;
}

/** 日志记录器接口（与 console 语义对齐）。 */
export interface BootLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** 一行日志的文件格式：[ISO 时间] [LEVEL] <ns> msg */
function formatLine(level: string, ns: string, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] ${ns} ${msg}\n`;
}

/** 取当天日志文件名（按天滚动）。 */
function todayLogFile(logDir: string): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(logDir, `nexusops-${day}.log`);
}

/**
 * 创建启动日志记录器。
 *
 * @param opts 配置（logDir / ns）
 * @returns BootLogger 实例
 */
export function createBootLogger(opts: BootLoggerOptions = {}): BootLogger {
  const ns = opts.ns ?? "nexusops";
  const logDir = opts.logDir;

  // logDir 首次使用前确保目录存在（一次性，失败不抛）
  let dirEnsured = false;
  let fileWriteFailed = false; // 写失败一次后不再尝试（避免刷屏）
  const ensureDir = (): boolean => {
    if (!logDir) return false;
    if (dirEnsured) return true;
    try {
      mkdirSync(logDir, { recursive: true });
      dirEnsured = true;
      return true;
    } catch {
      if (!fileWriteFailed) {
        process.stderr.write(`[${ns}] 日志目录创建失败，仅控制台输出：${logDir}\n`);
        fileWriteFailed = true;
      }
      return false;
    }
  };

  const writeToFile = (level: string, msg: string): void => {
    if (!logDir || fileWriteFailed) return;
    if (!ensureDir()) return;
    try {
      appendFileSync(todayLogFile(logDir), formatLine(level, ns, msg));
    } catch {
      if (!fileWriteFailed) {
        process.stderr.write(`[${ns}] 日志文件写入失败，仅控制台输出\n`);
        fileWriteFailed = true;
      }
    }
  };

  return {
    info(msg: string): void {
      // 控制台：彩色前缀便于区分；文件：纯文本（便于 grep）
      process.stdout.write(`[${ns}] ${msg}\n`);
      writeToFile("INFO", msg);
    },
    warn(msg: string): void {
      process.stderr.write(`[${ns}] ${msg}\n`);
      writeToFile("WARN", msg);
    },
    error(msg: string): void {
      process.stderr.write(`[${ns}] ${msg}\n`);
      writeToFile("ERROR", msg);
    },
  };
}
