/**
 * Podcast-Generator KB Vault 一次性铺设脚本。
 *
 * 把 examples/podcast-generator/kb-seed/vault 下的笔记复制到 OBSIDIAN_VAULT_PATH。
 *
 * 用法：
 *   OBSIDIAN_VAULT_PATH=/path/to/vault pnpm tsx examples/podcast-generator/kb-seed/install-vault.ts
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function main(): void {
  const target = process.env.OBSIDIAN_VAULT_PATH;
  if (!target) {
    console.error("缺少 OBSIDIAN_VAULT_PATH 环境变量。");
    process.exit(1);
  }
  const source = join(__dirname, "vault");
  if (!existsSync(source)) {
    console.error(`vault seed 目录不存在：${source}`);
    process.exit(1);
  }
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
  cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  console.log(`✓ KB vault seed 已铺到 ${target}`);
}

main();
