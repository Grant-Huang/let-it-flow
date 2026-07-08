import "dotenv/config";
import { loadConfig } from "../src/llm/config-loader.js";

const cfg = loadConfig();
console.log("nexus_narrate:", JSON.stringify(cfg.resolveEndpoint("nexus_narrate"), null, 2));
console.log("nexus_agent:", JSON.stringify(cfg.resolveEndpoint("nexus_agent"), null, 2));
console.log("nexus_review:", JSON.stringify(cfg.resolveEndpoint("nexus_review"), null, 2));
