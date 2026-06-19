/**
 * Obsidian vault 初始化脚本（应用层 —— C 内容）。
 *
 * 把 apps/nexusops/kb-seed/ 的 seed 内容拷贝到 OBSIDIAN_VAULT_PATH。
 * 幂等：已存在的文件不覆盖（避免冲掉用户改动）。
 *
 * 用法：tsx apps/nexusops/kb-seed/install-vault.ts
 */
import { cp, mkdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = __dirname;
const TARGET = process.env.OBSIDIAN_VAULT_PATH ?? join(process.cwd(), ".nexus-vault");

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function installVault(): Promise<void> {
  if (!existsSync(SEED_DIR)) {
    console.error(`[nexusops] seed 目录不存在：${SEED_DIR}`);
    process.exit(1);
  }

  if (await exists(TARGET)) {
    console.log(`[nexusops] vault 已存在：${TARGET}（不覆盖，如需重置请先删除）`);
    return;
  }

  await mkdir(TARGET, { recursive: true });
  await cp(SEED_DIR, TARGET, { recursive: true });
  console.log(`[nexusops] vault 已初始化：${TARGET}`);
  console.log(`[nexusops] seed 内容（精益五类上下文）已拷入`);
}

installVault().catch((e) => {
  console.error("[nexusops] vault 初始化失败：", e);
  process.exit(1);
});
