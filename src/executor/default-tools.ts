import { ToolRegistry } from "../tools/registry.js";

/**
 * executor 使用的默认工具注册表别名。
 *
 * 实际工具注册由 app 工厂（registerBuiltinTools）完成；executor 只依赖
 * ToolRegistry.get(toolName)。这里导出类型便于 node-runner 引用，避免
 * 循环依赖。
 */
export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

export { ToolRegistry } from "../tools/registry.js";
