/**
 * 全流程场景测试 —— 场景定义（tests/scenarios/）。
 *
 * 每个场景代表一个"假设 → 操作 → 预期"的完整验收单元。
 * 与 vitest 单测的区别：单测验证单个函数/模块的正确性；
 * 场景测试验证跨层全流程的行为是否符合产品预期（供人阅读的验收报告）。
 *
 * 场景不依赖真实 LLM 决策（那是 e2e 的职责），而是直接驱动各层机制：
 *   - 直接调 precondition / governance / postToolUse / validator 等纯函数
 *   - 直接执行 mock 域工具（真实走 EvidenceEnvelope 包装链路）
 *   - 直接驱动 skill-miner / skill-registry / skill-confirm
 *
 * 这覆盖了"系统能否在离线条件下确定性输出符合预期的可信结果"这一核心问题。
 */

/** 单个断言。 */
export interface ScenarioAssertion {
  /** 断言描述（人话）。 */
  name: string;
  /** 预期结果（人话）。 */
  expected: string;
  /** 实际结果（运行时填充）。 */
  actual?: string;
  /** 是否通过（运行时填充）。 */
  passed?: boolean;
  /** 失败时的详情（运行时填充）。 */
  detail?: string;
}

/** 调用来源标记：用于报告里区分 mock 与 real，让读者判断可信度边界。 */
export interface CallProvenance {
  /** 被调用的模块/函数/工具（如 buildNexusGovernance、oee.realtime、generateText）。 */
  target: string;
  /** 调用性质。 */
  kind: "mock" | "real" | "synthetic";
  /** 说明（为什么是这种性质 / mock 了什么）。 */
  note: string;
}

/** 单个场景。 */
export interface Scenario {
  /** 场景 ID。 */
  id: string;
  /** 所属层（ETCLOVG）。E=端到端 fixture 回放。 */
  layer: "V" | "G" | "C" | "L" | "T" | "E";
  /** 场景标题。 */
  title: string;
  /** 背景假设（"如果……"）。 */
  hypothesis: string;
  /** 测试目的（"验证……"）。 */
  purpose: string;
  /** 简要过程（步骤摘要）。 */
  procedure: string[];
  /**
   * 调用来源清单：本场景执行时实际涉及哪些调用，每个是 mock/real/synthetic。
   *  - mock：替身（如 LLM 不真调网络）
   *  - real：真实生产代码路径（如真实 governance 规则判定）
   *  - synthetic：构造的输入数据（如手搓的 StepTrace），非真实运行产物
   * 报告里逐条展示，让读者知道"通过≠全链路真实"。
   */
  calls: CallProvenance[];
  /** 断言列表。 */
  assertions: ScenarioAssertion[];
  /** 执行函数：填充 assertions 的 actual/passed，可抛错表示场景级失败。 */
  run: () => Promise<void>;
}

/** 场景执行结果（run 之后）。 */
export interface ScenarioResult {
  scenario: Scenario;
  passed: boolean;
  failedAssertions: number;
  totalAssertions: number;
  duration: number;
  error?: string;
}
