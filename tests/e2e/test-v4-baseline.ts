/**
 * P8.0 v4 全量回归基线测试（@e2e，默认排除）。
 *
 * 目的：建立一个可对照的基线，验证 v4 全量链路（URL → 7 步 → final.mp4）
 * 产出的关键产物存在且尺寸正确。P8.3 迁移 5 个 LLM 步骤到 TS 直连后，
 * 重跑此测试对照产物质量不下降。
 *
 * 运行方式（手动触发，不在默认 test-gates 内）：
 *   LIF_BASELINE_ARTIFACTS=/path/to/baseline vitest run tests/e2e/test-v4-baseline.ts
 *
 * 基线产物：data/artifacts/t_e4049990-08a/（首次 v4 全量运行的产物）
 */
import { describe, it, expect } from "vitest";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 基线产物目录。优先用环境变量指定（便于 CI 切换），缺省回退到首次运行产物。
 */
const BASELINE_DIR = resolve(
  process.env.LIF_BASELINE_ARTIFACTS ??
    "data/artifacts/t_e4049990-08a",
);

/** 跳过整个测试套件若基线目录不存在（避免 CI 无基线时报错）。 */
const hasBaseline = existsSync(BASELINE_DIR);
const describeOrSkip = hasBaseline ? describe : describe.skip;

/**
 * 用 ffprobe 取视频/图片尺寸（width,height 格式）。
 * ffprobe 不可用时返回空字符串（测试降级为只检查存在性）。
 */
function probeSize(filePath: string): string {
  try {
    return execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      filePath,
    ], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

describeOrSkip("P8.0 v4 全量回归基线", () => {
  describe("产物完整性", () => {
    it("audio/voiceover_full.mp3 存在且非空", () => {
      const f = join(BASELINE_DIR, "audio/voiceover_full.mp3");
      expect(existsSync(f)).toBe(true);
      expect(statSync(f).size).toBeGreaterThan(10_000);
    });

    it("audio/segments.json 存在且含段落对齐信息", () => {
      const f = join(BASELINE_DIR, "audio/segments.json");
      expect(existsSync(f)).toBe(true);
      const content = JSON.parse(readFileSync(f, "utf8"));
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
      expect(content[0]).toHaveProperty("para_index");
      expect(content[0]).toHaveProperty("start_time");
      expect(content[0]).toHaveProperty("end_time");
      expect(content[0]).toHaveProperty("image_path");
    });

    it("images/ 下有封面 + 至少 1 张段落配图（PNG）", () => {
      const dir = join(BASELINE_DIR, "images");
      expect(existsSync(dir)).toBe(true);
      const pngs = readdirSync(dir).filter((f) => f.endsWith(".png"));
      expect(pngs.length).toBeGreaterThanOrEqual(2);
      expect(pngs).toContain("cover.png");
    });

    it("video/final.mp4 存在且非空（视频链产出 .mp4）", () => {
      const f = join(BASELINE_DIR, "video/final.mp4");
      expect(existsSync(f)).toBe(true);
      expect(statSync(f).size).toBeGreaterThan(50_000);
    });

    it("video/subtitle.srt 存在（字幕对齐产出）", () => {
      const f = join(BASELINE_DIR, "video/subtitle.srt");
      expect(existsSync(f)).toBe(true);
      expect(statSync(f).size).toBeGreaterThan(100);
    });

    it("step2 translate 产出分段译稿（script_v1_chunk_NN.txt）", () => {
      const dir = join(BASELINE_DIR, "scripts");
      const chunks = readdirSync(dir).filter(
        (f) => f.startsWith("script_v1_chunk_") && f.endsWith(".txt"),
      );
      expect(chunks.length, "应有至少 1 个分段译稿").toBeGreaterThan(0);
    });

    it("scenes/image_prompts.json 存在（生图提示词产出）", () => {
      const f = join(BASELINE_DIR, "scenes/image_prompts.json");
      expect(existsSync(f)).toBe(true);
      const content = JSON.parse(readFileSync(f, "utf8"));
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
      expect(content[0]).toHaveProperty("image_prompt");
      expect(content[0]).toHaveProperty("image_path");
    });
  });

  describe("尺寸一致性（无拉伸/比例错位）", () => {
    it("所有 PNG 配图尺寸一致（1280x720）", () => {
      const dir = join(BASELINE_DIR, "images");
      const pngs = readdirSync(dir).filter((f) => f.endsWith(".png"));
      for (const name of pngs) {
        const size = probeSize(join(dir, name));
        if (size) {
          expect(size, `${name} 尺寸应为 1280x720`).toBe("1280,720");
        }
      }
    });

    it("final.mp4 与配图尺寸一致（无拉伸，目标 1280x720）", () => {
      // 注意：基线产物 t_e4049990-08a 是图片尺寸修复前生成的，
      // 其 final.mp4=1920x1080 但配图=1280x720（已知 bug 产物）。
      // 此测试的目的是：未来重新生成的基线 / P8.3 迁移后的产物，
      // 视频与配图尺寸必须一致。基线产物若不一致，用 LIF_BASELINE_SKIP_SIZE=1 跳过。
      if (process.env.LIF_BASELINE_SKIP_SIZE === "1") {
        // 旧基线已知不一致，跳过；新基线应移除此 env 让测试生效
        return;
      }
      const videoSize = probeSize(join(BASELINE_DIR, "video/final.mp4"));
      const imgSize = probeSize(join(BASELINE_DIR, "images/cover.png"));
      if (videoSize && imgSize) {
        expect(videoSize, "视频尺寸应与配图一致").toBe(imgSize);
      }
    });
  });

  describe("链路完整性（9 步全部产出）", () => {
    /**
     * 验证 9 个步骤的关键产物都存在。step2/3/3b/3c 是文本链，
     * step3d 是提示词，step4a/4b 是并行重 IO，step5 字幕，step6 视频。
     */
    it("9 步链路全部产出（translate→rewrite→seam→terminology→image_prompts→tts∥image_gen→subtitle→video_build）", () => {
      // step2 产出分段文件 script_v1_chunk_NN.txt（非单一 translated.txt）
      const scriptsDir = join(BASELINE_DIR, "scripts");
      const hasTranslateChunks = existsSync(scriptsDir) &&
        readdirSync(scriptsDir).some((f) => f.startsWith("script_v1_chunk_"));
      const checks: Array<[string, boolean]> = [
        ["step2 translate", hasTranslateChunks],
        ["step3 rewrite", existsSync(join(BASELINE_DIR, "scripts/script_v2_raw.txt"))],
        ["step3b seam_repair", existsSync(join(BASELINE_DIR, "scripts/script_v2_seamed.txt"))],
        ["step3c terminology", existsSync(join(BASELINE_DIR, "scripts/script_v2.txt"))],
        ["step3d image_prompts", existsSync(join(BASELINE_DIR, "scenes/image_prompts.json"))],
        ["step4b tts", existsSync(join(BASELINE_DIR, "audio/voiceover_full.mp3"))],
        ["step4a image_gen", existsSync(join(BASELINE_DIR, "images/cover.png"))],
        ["step5 subtitle", existsSync(join(BASELINE_DIR, "video/subtitle.srt"))],
        ["step6 video_build", existsSync(join(BASELINE_DIR, "video/final.mp4"))],
      ];
      const missing = checks.filter(([, ok]) => !ok).map(([s]) => s);
      expect(missing, `缺失产物：${missing.join(", ")}`).toEqual([]);
    });
  });
});
