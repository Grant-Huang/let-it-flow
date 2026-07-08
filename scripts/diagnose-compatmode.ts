import "dotenv/config";
import { LlmService } from "../src/services/llm-service.js";
import { loadConfig } from "../src/llm/config-loader.js";
import { ensureSeedConfig } from "../src/llm/seed.js";

ensureSeedConfig();
const llm = new LlmService({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  runtimeConfig: loadConfig(),
});

console.log("═".repeat(60));
console.log("  compatMode 诊断");
console.log("═".repeat(60));
console.log("OPENAI_BASE_URL:", process.env.OPENAI_BASE_URL || "(未设置)");
console.log("useChat (全局):", (llm as unknown as { useChat: boolean }).useChat);
console.log("");
console.log("compatModeFor('nexus_agent'):", llm.compatModeFor("nexus_agent"));
console.log("compatModeFor('nexus_narrate'):", llm.compatModeFor("nexus_narrate"));
console.log("compatModeFor('nexus_review'):", llm.compatModeFor("nexus_review"));
console.log("");

const agentModel = llm.model("nexus_agent");
console.log("agent model:", agentModel?.constructor?.name);
const narrateModel = llm.model("nexus_narrate");
console.log("narrate model:", narrateModel?.constructor?.name);
