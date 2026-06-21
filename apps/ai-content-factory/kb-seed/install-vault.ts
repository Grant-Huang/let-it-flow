/**
 * 把 kb-seed/vault/* 拷贝到 OBSIDIAN_VAULT_PATH 指定的目标 vault。
 *
 * 用法：
 *   OBSIDIAN_VAULT_PATH=./data/aicf-vault \
 *     tsx apps/ai-content-factory/kb-seed/install-vault.ts
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const seedRoot = join(here, "vault");

function copyTree(src: string, dst: string): number {
  let n = 0;
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true });
      n += copyTree(s, d);
    } else {
      mkdirSync(dirname(d), { recursive: true });
      writeFileSync(d, readFileSync(s));
      n += 1;
    }
  }
  return n;
}

function main(): void {
  const target = process.env.OBSIDIAN_VAULT_PATH;
  if (!target) {
    console.error("OBSIDIAN_VAULT_PATH 未设置");
    process.exit(1);
  }
  mkdirSync(target, { recursive: true });
  const n = copyTree(seedRoot, target);
  console.log(`[ai-content-factory] 已铺 ${n} 篇笔记到 ${relative(process.cwd(), target)}`);
}

main();
