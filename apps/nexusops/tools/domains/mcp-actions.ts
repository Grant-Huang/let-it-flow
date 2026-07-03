/**
 * NexusOps mock MCP 动作工具集（应用层 —— T 内容）。
 *
 * 补全 NexusOps 的"执行能力"侧：当前 60 个域工具全是只读取证，
 * 这里补一批 write/destructive 风险的动作工具，让 ReAct 链路能形成
 * "诊断 → 建议 → 执行动作（带 HITL 确认）→ 复检" 的完整闭环。
 *
 * 命名遵循 mcp.<serverId>.<tool> 规范（与 createMcpActionTool 一致），
 * 这样 governance 规则（按 mcp.mes / mcp.qms 等前缀匹配）能直接生效，
 * nexus_advise 的 actionTool 字段也能正确引用这些工具名。
 *
 * 覆盖 5 个业务系统：
 *   - MES：排产调整 / 工单下达 / 换模调度（write）
 *   - ERP：采购申请 / 领料出库（write）
 *   - QMS：质量隔离 / 不良放行 / 返工单（write + destructive 批量报废）
 *   - EAM（设备资产）：维护工单 / 停线（write + destructive 停线）
 *   - process：工艺参数回调（write）
 *
 * 每个动作执行后记录到 actionStore，副作用覆盖可被后续读取工具观察到
 * （如调 mcp.mes.schedule_work_order 后 schedule.attainment 可更新）。
 *
 * 风险评级：
 *   - write：常规业务写入（排产/工单/采购/参数调整）→ HITL 确认门
 *   - destructive：不可逆/高危（停线/批量报废）→ HITL + governance 严管
 */
import { createActionTool } from "../mock-data/tool-factory.js";
import type { FlowConnector } from "../../../../src/tools/base.js";
import { DEFAULT_LINE } from "../../config/defaults.js";

/**
 * 构造全部 mock MCP 动作工具。
 * @returns FlowConnector[]（risk=write/destructive，tier=custom）
 */
export function registerMcpActionTools(): FlowConnector[] {
  return [
    // ── MES：排产执行系统 ──────────────────────────────────────────
    createActionTool({
      name: "mcp.mes.schedule_work_order",
      description:
        "向 MES 下达/调整工单排产（修改指定产线的在产订单或数量）。需 HITL 确认。" +
        "用于：排产达成率低时重新排程、紧急订单插单、产能重分配。",
      triggers: ["下达工单", "调整排产", "重新排程", "插单", "排产调整"],
      notFor: ["只查询排产（走 schedule.current）", "物料采购（走 mcp.erp.purchase_request）"],
      inputSchema: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "工单号（如 PO-2026-0619-01）" },
          qty: { type: "number", description: "调整后的目标数量" },
          priority: { type: "string", enum: ["normal", "urgent"], description: "优先级" },
        },
        required: ["orderId"],
      },
      risk: "write",
      system: "MES",
      ticketPrefix: "WO",
      run: (args) => {
        const qty = args.qty as number | undefined;
        return {
          ticketId: "",
          status: "scheduled",
          summary: `工单 ${args.orderId} 已重新排程${qty ? `（目标数量 ${qty}）` : ""}，预计下一班次生效`,
          sideEffects: qty ? { "schedule.plannedQty": qty } : undefined,
        };
      },
      provenance: (a) => `/mes/schedule/work_order?order=${a.orderId ?? ""}`,
      semanticTags: ["schedule_attainment"],
    }),

    createActionTool({
      name: "mcp.mes.changeover",
      description:
        "调度产线换模/换型（SMED）。需 HITL 确认。" +
        "用于：换模超时导致可用率损失时，优化换模时序或提前准备工装。",
      triggers: ["换模调度", "换型安排", "SMED 调度", "提前换模"],
      notFor: ["查询换模历史（走 schedule.changeover）"],
      inputSchema: {
        type: "object",
        properties: {
          fromProduct: { type: "string", description: "当前产品" },
          toProduct: { type: "string", description: "目标产品" },
          slot: { type: "string", enum: ["next_shift", "weekend"], description: "换模时段" },
        },
        required: ["toProduct"],
      },
      risk: "write",
      system: "MES",
      ticketPrefix: "CO",
      run: (args) => ({
        ticketId: "",
        status: "scheduled",
        summary: `换模任务已调度：${args.fromProduct ?? "?"} → ${args.toProduct}（${args.slot ?? "next_shift"}）`,
        sideEffects: { "schedule.changeoverPlanned": true },
      }),
      provenance: (a) => `/mes/changeover?to=${a.toProduct ?? ""}`,
      semanticTags: ["schedule_attainment", "oee_availability"],
    }),

    createActionTool({
      name: "mcp.mes.reallocate_capacity",
      description:
        "跨产线产能重分配（把某产线部分负荷转移到其他产线）。需 HITL 确认。" +
        "用于：某产线瓶颈/故障时，临时把订单分流到备用产线保交付。",
      triggers: ["产能重分配", "订单分流", "负荷转移", "产线平衡"],
      notFor: ["单产线排产（走 mcp.mes.schedule_work_order）"],
      inputSchema: {
        type: "object",
        properties: {
          fromLine: { type: "string", description: "源产线" },
          toLine: { type: "string", description: "目标产线" },
          orderIds: { type: "array", items: { type: "string" }, description: "转移的工单号列表" },
        },
        required: ["fromLine", "toLine"],
      },
      risk: "write",
      system: "MES",
      ticketPrefix: "CR",
      run: (args) => {
        const orders = (args.orderIds as string[]) ?? [];
        return {
          ticketId: "",
          status: "scheduled",
          summary: `${orders.length} 个工单已从 ${args.fromLine} 转移到 ${args.toLine}`,
          sideEffects: { "schedule.capacityReallocated": true },
        };
      },
      provenance: (a) => `/mes/reallocate?from=${a.fromLine ?? ""}&to=${a.toLine ?? ""}`,
      semanticTags: ["schedule_attainment"],
    }),

    // ── ERP：企业资源计划（物料/采购）──────────────────────────────
    createActionTool({
      name: "mcp.erp.purchase_request",
      description:
        "向 ERP 提交采购申请（缺料风险时补货）。需 HITL 确认。" +
        "用于：material.supply_risk 高或 inventory 低时，主动补料防缺料停线。",
      triggers: ["采购申请", "补料", "缺料补货", "请购"],
      notFor: ["查询库存（走 material.inventory）", "领料出库（走 mcp.erp.material_issue）"],
      inputSchema: {
        type: "object",
        properties: {
          materialCode: { type: "string", description: "物料编码" },
          qty: { type: "number", description: "采购数量" },
          urgency: { type: "string", enum: ["normal", "urgent"], description: "紧急程度" },
        },
        required: ["materialCode", "qty"],
      },
      risk: "write",
      system: "ERP",
      ticketPrefix: "PR",
      run: (args) => ({
        ticketId: "",
        status: "accepted",
        summary: `采购申请已提交：${args.materialCode} × ${args.qty}（${args.urgency ?? "normal"}）`,
        sideEffects: { "material.purchasePending": true },
      }),
      provenance: (a) => `/erp/purchase?mat=${a.materialCode ?? ""}&qty=${a.qty ?? ""}`,
      semanticTags: ["supply_risk", "wip_level"],
    }),

    createActionTool({
      name: "mcp.erp.material_issue",
      description:
        "ERP 领料出库（从仓库向产线发料）。需 HITL 确认。" +
        "用于：WIP 过低或排产插单后补发物料到线边。",
      triggers: ["领料", "发料", "物料出库", "线边补料"],
      notFor: ["采购（走 mcp.erp.purchase_request）"],
      inputSchema: {
        type: "object",
        properties: {
          materialCode: { type: "string", description: "物料编码" },
          qty: { type: "number", description: "出库数量" },
          toLine: { type: "string", description: "目标产线" },
        },
        required: ["materialCode", "qty"],
      },
      risk: "write",
      system: "ERP",
      ticketPrefix: "MI",
      run: (args) => ({
        ticketId: "",
        status: "executed",
        summary: `已出库 ${args.materialCode} × ${args.qty} 至 ${args.toLine ?? DEFAULT_LINE} 线边`,
        sideEffects: { "material.issued": true },
      }),
      provenance: (a) => `/erp/material/issue?mat=${a.materialCode ?? ""}&qty=${a.qty ?? ""}`,
      semanticTags: ["wip_level"],
    }),

    // ── QMS：质量管理系统 ──────────────────────────────────────────
    createActionTool({
      name: "mcp.qms.quarantine",
      description:
        "QMS 质量隔离（把疑似不良批冻结，待复检）。需 HITL 确认。" +
        "用于：quality.defect_rate 超标或 inspection 发现批量异常时，隔离防止流出。",
      triggers: ["质量隔离", "批冻结", "可疑品隔离", "put on hold"],
      notFor: ["查询缺陷率（走 quality.defect_rate）", "批量报废（走 mcp.qms.scrap_batch）"],
      inputSchema: {
        type: "object",
        properties: {
          batchId: { type: "string", description: "批号" },
          reason: { type: "string", description: "隔离原因" },
          qty: { type: "number", description: "隔离数量" },
        },
        required: ["batchId", "reason"],
      },
      risk: "write",
      system: "QMS",
      ticketPrefix: "QH",
      run: (args) => ({
        ticketId: "",
        status: "executed",
        summary: `批 ${args.batchId}（${args.qty ?? "?"} 件）已质量隔离：${args.reason}`,
        sideEffects: { "quality.quarantined": true },
      }),
      provenance: (a) => `/qms/quarantine?batch=${a.batchId ?? ""}`,
      semanticTags: ["defect_rate"],
    }),

    createActionTool({
      name: "mcp.qms.rework_order",
      description:
        "QMS 下达返工单（对可修复不良品安排返工）。需 HITL 确认。" +
        "用于：quality.rework 高或隔离批判定可修复时，安排返工工序列入排产。",
      triggers: ["返工单", "安排返工", "rework", "修复不良品"],
      notFor: ["隔离（走 mcp.qms.quarantine）", "报废（走 mcp.qms.scrap_batch）"],
      inputSchema: {
        type: "object",
        properties: {
          batchId: { type: "string", description: "批号" },
          qty: { type: "number", description: "返工数量" },
          reworkProcess: { type: "string", description: "返工工序" },
        },
        required: ["batchId", "qty"],
      },
      risk: "write",
      system: "QMS",
      ticketPrefix: "RW",
      run: (args) => ({
        ticketId: "",
        status: "scheduled",
        summary: `返工单已下达：批 ${args.batchId} × ${args.qty}（${args.reworkProcess ?? "标准返工"}）`,
        sideEffects: { "quality.reworkScheduled": true },
      }),
      provenance: (a) => `/qms/rework?batch=${a.batchId ?? ""}&qty=${a.qty ?? ""}`,
      semanticTags: ["defect_rate"],
    }),

    createActionTool({
      name: "mcp.qms.scrap_batch",
      description:
        "QMS 批量报废（不可逆，destructive）。必须 HITL 确认 + governance 放行。" +
        "用于：quality.scrap 超标或隔离批判定不可修复时的最终处置。慎用。",
      triggers: ["批量报废", "报废批", "scrap", "销毁不良品"],
      notFor: ["可修复品（走 mcp.qms.rework_order）", "隔离待判（走 mcp.qms.quarantine）"],
      inputSchema: {
        type: "object",
        properties: {
          batchId: { type: "string", description: "批号" },
          qty: { type: "number", description: "报废数量" },
          reason: { type: "string", description: "报废原因" },
        },
        required: ["batchId", "qty", "reason"],
      },
      risk: "destructive",
      system: "QMS",
      ticketPrefix: "SC",
      run: (args) => ({
        ticketId: "",
        status: "executed",
        summary: `批 ${args.batchId} × ${args.qty} 已报废（${args.reason}）。此操作不可逆。`,
        sideEffects: { "quality.scrapped": true, "quality.scrapQty": args.qty },
      }),
      provenance: (a) => `/qms/scrap?batch=${a.batchId ?? ""}&qty=${a.qty ?? ""}`,
      semanticTags: ["defect_rate"],
    }),

    // ── EAM：设备资产管理（维护/停线）──────────────────────────────
    createActionTool({
      name: "mcp.eam.maintenance_order",
      description:
        "EAM 下达维护/维修工单（针对故障设备安排预防/纠正性维护）。需 HITL 确认。" +
        "用于：equipment.health 低或 failure_predict 预警时，主动安排维护防故障。",
      triggers: ["维护工单", "维修单", "安排维护", "PM 工单", "CM 工单"],
      notFor: ["查询设备状态（走 equipment.status）", "停线（走 mcp.eam.stop_line）"],
      inputSchema: {
        type: "object",
        properties: {
          equipmentId: { type: "string", description: "设备编号（如 注塑机#1）" },
          type: { type: "string", enum: ["PM", "CM"], description: "PM 预防 / CM 纠正" },
          description: { type: "string", description: "维护内容描述" },
        },
        required: ["equipmentId", "type"],
      },
      risk: "write",
      system: "EAM",
      ticketPrefix: "PM",
      run: (args) => ({
        ticketId: "",
        status: "scheduled",
        summary: `${args.type === "PM" ? "预防性" : "纠正性"}维护工单已下达：${args.equipmentId}（${args.description ?? ""}）`,
        sideEffects: { "equipment.maintenanceScheduled": true },
      }),
      provenance: (a) => `/eam/maintenance?equip=${a.equipmentId ?? ""}&type=${a.type ?? ""}`,
      semanticTags: ["equipment_reliability"],
    }),

    createActionTool({
      name: "mcp.eam.spare_part_order",
      description:
        "EAM 备件采购/领用（针对故障设备订购备件）。需 HITL 确认。" +
        "用于：equipment.failure_predict 预警备件寿命或故障根因涉及备件时。",
      triggers: ["备件订购", "备件领用", "spare part", "订购备件"],
      notFor: ["物料采购（走 mcp.erp.purchase_request）"],
      inputSchema: {
        type: "object",
        properties: {
          partCode: { type: "string", description: "备件编码" },
          qty: { type: "number", description: "数量" },
          forEquipment: { type: "string", description: "用于设备" },
        },
        required: ["partCode", "qty"],
      },
      risk: "write",
      system: "EAM",
      ticketPrefix: "SP",
      run: (args) => ({
        ticketId: "",
        status: "accepted",
        summary: `备件 ${args.partCode} × ${args.qty} 已订购（用于 ${args.forEquipment ?? "待定"}）`,
        sideEffects: { "equipment.spareOrdered": true },
      }),
      provenance: (a) => `/eam/spare?part=${a.partCode ?? ""}&qty=${a.qty ?? ""}`,
      semanticTags: ["equipment_reliability"],
    }),

    createActionTool({
      name: "mcp.eam.stop_line",
      description:
        "EAM 停线（不可逆，destructive）。必须 HITL 确认 + governance 放行。" +
        "用于：crisis 场景设备重大故障或安全风险时，紧急停线防事故扩大。极慎用。",
      triggers: ["停线", "停产", "紧急停机", "stop line", "pause line"],
      notFor: ["安排维护（走 mcp.eam.maintenance_order）", "降速运行（无对应工具）"],
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "停线原因（须具体）" },
          duration: { type: "string", description: "预计停线时长" },
        },
        required: ["reason"],
      },
      risk: "destructive",
      system: "EAM",
      ticketPrefix: "SL",
      run: (args) => ({
        ticketId: "",
        status: "executed",
        summary: `产线已停线：${args.reason}（预计 ${args.duration ?? "待定"}）。此操作严重影响产能。`,
        sideEffects: { "equipment.lineStopped": true, "schedule.attainment": 0 },
      }),
      provenance: (a) => `/eam/stop_line?reason=${encodeURIComponent(String(a.reason ?? ""))}`,
      semanticTags: ["oee_availability"],
    }),

    // ── process：工艺参数执行 ─────────────────────────────────────
    createActionTool({
      name: "mcp.process.adjust_parameters",
      description:
        "回调工艺参数到标准值（温度/压力/速度等）。需 HITL 确认。" +
        "用于：process.deviation 显示参数偏离 spec 时，直接回调到标准工艺窗口。" +
        "判官特别关注：诊断出参数漂移后，本工具是首选可执行动作。",
      triggers: ["参数回调", "工艺调整", "调参", "回调参数", "adjust process"],
      notFor: ["查询参数（走 process.parameters）", "查询偏差（走 process.deviation）"],
      inputSchema: {
        type: "object",
        properties: {
          parameters: {
            type: "object",
            description: "要调整的参数键值（如 {temperature: 185, pressure: 4.2}）",
          },
          reason: { type: "string", description: "调整原因" },
        },
        required: ["parameters"],
      },
      risk: "write",
      system: "MOM",
      ticketPrefix: "PA",
      run: (args) => {
        const params = (args.parameters as Record<string, unknown>) ?? {};
        const paramList = Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        return {
          ticketId: "",
          status: "executed",
          summary: `工艺参数已回调：${paramList || "（无）"}（原因：${args.reason ?? "未说明"}）`,
          sideEffects: { ...params, "process.adjusted": true },
        };
      },
      provenance: (a) => `/mom/process/adjust?params=${JSON.stringify(a.parameters ?? {})}`,
      semanticTags: ["process_deviation"],
    }),
  ];
}
