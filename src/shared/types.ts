/**
 * dsh-coach 契约单源：三段聚合数据接口 + /ctx/api 请求/响应契约类型。
 * 设计文档 §3 的全部接口只在这里定义；host 与 client 都从本文件引用，
 * 禁止在其他文件重复声明契约形状。
 *
 * 本目录为纯逻辑共享层：无 IO、无框架依赖、无基座包导入。
 */

// ============================================================
// /ctx/api 统一包络与错误码（§3.6）
// ============================================================

/** /ctx/api 全端点统一错误码。 */
export type CtxApiErrorCode =
  | 'CTX_SESSION_NOT_FOUND'
  | 'CTX_FILE_FORBIDDEN'
  | 'CTX_FILE_NOT_FOUND'
  /** 仅 `?index=`（deprecated）路径使用：非整数 / 越界。 */
  | 'CTX_INDEX_OUT_OF_RANGE'
  /** `?id=` 未命中任何段 → 404。 */
  | 'CTX_SEGMENT_NOT_FOUND'
  | 'CTX_BAD_REQUEST'
  | 'CTX_INTERNAL'

/** 错误响应体；message 已脱敏（不含绝对路径与内部栈）。 */
export interface CtxApiErrorBody {
  code: CtxApiErrorCode
  message: string
}

/** /ctx/api 全端点统一包络：成功 `{ok:true,data}` / 失败 `{ok:false,error}`。 */
export type CtxApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: CtxApiErrorBody }

// ============================================================
// Agent 徽标（§3.1）
// ============================================================

/**
 * 参与聚合的全部 Agent（含主）。展示名推导链：
 * `descriptor.label` → `agentPreset` → 会话 id 前 8 位短码。
 * 主会话 label 固定为 `'main'`，client 侧按 role 渲染 locale 化的「主Agent」。
 */
export interface AgentBadge {
  /** 聚合内稳定键：`'main'` 或子会话 sessionId。 */
  agentKey: string
  sessionId: string
  /** 内联展示短名：主 Agent 有 preset 时为解析出的真名（高见远），否则 `main`；
   *  子 Agent 为 team 名（developer）或保底 `子Agent`。 */
  label: string
  role: 'main' | 'subagent'
  delegationDepth?: number
  /**
   * hover 详情：主 Agent 有 preset 时为 preset id；子 Agent 为任务描述
   * （team 名内联、描述放 hover，避免「名字是一句话」）。
   */
  title?: string
  /** true = 该子会话超出扫描预算，仅提供徽标无明细。 */
  degraded?: boolean
}

// ============================================================
// 载荷预算标记（§3.1 / §7.4）
// ============================================================

/**
 * 各段是否触发截断/降级的标记，client 据此提示。
 *
 * 语义（增量设计 §1.6）：`inputsTruncated` / `referencesTruncated` / `outputsTruncated`
 * 都是**全局事实**（条目/段数超上限被丢弃），只在「全部 Agent」视图显示横幅；
 * 「单条正文被 4KB 截断」不是全局事实，由 client 基于**筛选后可见集合**自身的
 * `textTruncated` 字段实时重算（数据已随条目下发，无需 host 重复下发聚合标记）。
 */
export interface PayloadBudgets {
  /** 输入条目数超 `MAX_INPUT_ITEMS` 被丢弃。**不含**「单条正文被 4KB 截断」。 */
  inputsTruncated: boolean
  /** 参考文件条目超上限被截断。 */
  referencesTruncated: boolean
  /** 输出段因段预算（单会话 / 全局）被丢弃。**不含**「单条正文被 4KB 截断」。 */
  outputsTruncated: boolean
  /** 因段预算被丢弃的输出段数量（供横幅与「显示过程输出」计数说明省略量）。 */
  droppedOutputSegments: number
  /** 实际扫描的子会话数。 */
  childrenScanned: number
  /** 谱系中的子会话总数。 */
  childrenTotal: number
}

// ============================================================
// 文件树节点（§3.3；参考树 / 输出树 / 注入树三处复用）
// ============================================================

/** 目录树节点。同层按 dir 前、字典序排序；树构建与去重用规范化路径做 key。 */
export interface FileTreeNode {
  /** 末级名称（目录名或文件名）。 */
  name: string
  /** 规范化工作区相对路径（目录节点为目录路径，无尾斜杠）。 */
  path: string
  type: 'file' | 'dir'
  /** 仅 dir。 */
  children?: FileTreeNode[]
  /** 参考树专用：累计查看次数（read / read_image / str_replace_editor view）。 */
  viewCount?: number
  /** 输出树专用：输出文件的新建/更新标记。 */
  outputOp?: 'create' | 'update'
  /** 贡献该节点的 agentKey 列表（去重，主在前）。 */
  agents?: string[]
}

// ============================================================
// 输入段（§3.2）
// ============================================================

/** 提示词附带的附件。基座 ImageAttachmentRef 明确「never a filesystem path」，
 *  故 v1 附件仅展示名（name ?? mediaType），path 恒缺省——宁缺勿错。 */
export interface AttachmentRef {
  /** 展示名。 */
  name: string
  /** 可解析的工作区相对路径（可点击进抽屉）；v1 恒缺省（见上）。 */
  path?: string
  mediaType?: string
}

/**
 * 用户消息在输入栏里的语义分类（按来源 provenance，硬判据见下）：
 * - `user`        ：用户输入——主会话全部；子会话 descriptor **之后且带 rpcId**（你直接对该子 Agent 说的）
 * - `inherited`   ：继承上下文——子会话 descriptor **之前且带 rpcId**（你对主 Agent 说过、被继承下来的原话）
 * - `delegation`  ：委派指令——子会话 descriptor **之后且无 rpcId**（主 Agent 下发；非 Team 模式 send_message 追加注入也归此，凭「是否多条」区分 Team/非Team）
 * - `agent-message`：来自XXX的消息——`source.kind === 'team-message'` 的 Agent 间消息（含 Team 模式主 Agent 的后续指令）
 */
export type UserInputKind = 'user' | 'inherited' | 'delegation' | 'agent-message'

/** 用户主动输入时间线条目（source.kind === 'user' | 'team-message'）。 */
export interface UserInputItem {
  /** 稳定 id（`makeEntryId(owningSessionId, seq)`），React key / 分组引用 / 定位用。 */
  id: string
  seq: number
  time: number
  turn?: number
  agentKey: string
  /** 语义分类（委派指令归**收到委派的子 Agent**，不归发出的父 Agent）。 */
  inputKind: UserInputKind
  /** 拼接后的纯文本（ContentBlock 中 text 块）。 */
  text: string
  textTruncated: boolean
  attachments: AttachmentRef[]
  /** `agent-message` 专用：消息发送方在 team 注册表里的名字（lead / developer …）。 */
  senderName?: string
  /**
   * true = 本条目由父会话 `subagent` 工具调用兜底提取（该子会话明细不可用）。
   * 仅在该子会话 degraded / 未扫描时可能出现；UI 须以次要样式呈现，
   * 且**不得**覆盖子会话自身的一手记录（§1.5 四条门控）。
   */
  provisional?: boolean
}

/** ContextForm 语义小类（与基座 ContextForm 词表对齐的本地投影）。 */
export type InjectContextForm =
  | 'instructions'
  | 'catalog'
  | 'snapshot'
  | 'notice'
  | 'relay'
  | 'recall'

/** 系统注入折叠区条目（source.kind === 'plugin'）。 */
export interface PluginInjectItem {
  /** 稳定 id（`makeEntryId(owningSessionId, seq)`）。 */
  id: string
  seq: number
  time: number
  agentKey: string
  /** source.plugin。 */
  plugin: string
  form?: InjectContextForm
  /** form='notice' 的一行摘要。 */
  summary?: string
  /** 正文（折叠区展开/抽屉用，单条截断 4KB；快照 form 为各 section 文本拼接）。 */
  text: string
  textTruncated: boolean
  /** extractInjectFilePaths 的提取结果（已规范化，去重保序）。 */
  filePaths: string[]
}

/** 输入分组内的一条条目（判别联合；不复制条目本体，只包一层类型标签）。 */
export type InputEntry =
  | { entryKind: 'user'; item: UserInputItem }
  | { entryKind: 'inject'; item: PluginInjectItem }

/** 一个 Agent 的输入分组（只存 id 引用 + 计数，不内嵌条目本体，避免载荷翻倍）。 */
export interface AgentInputGroup {
  agentKey: string
  /** 展示序号：0 = 主 Agent，其余按 `agents` 徽标序。 */
  order: number
  /** 该 Agent 的输入条目 id 序列（按时间升序）。 */
  entryIds: string[]
  /** 条目计数，供块头展示。 */
  counts: { user: number; inherited: number; delegations: number; agentMessages: number; injections: number }
}

/** 输入段。 */
export interface InputsSection {
  /** 用户主动输入时间线（source.kind === 'user'）。扁平权威数组。 */
  userItems: UserInputItem[]
  /** 系统注入折叠区（source.kind === 'plugin'）。扁平权威数组。 */
  pluginItems: PluginInjectItem[]
  /** 按 Agent 分组的投影（host 计算，client 只做筛选与 id 解析，不自行推导）。 */
  groups: AgentInputGroup[]
  /** 从 pluginItems 提取路径构建的文件树（§3.5）。 */
  injectTree: FileTreeNode[]
  /** 输入条目合计（= userItems.length + pluginItems.length），栏头计数用。 */
  totalItems: number
}

// ============================================================
// 参考段（§3.3 / §3.7）
// ============================================================

/** 参考段：目录树 + 查看次数合计。部分读口径 = 每次调用 +1，不按行加权。 */
export interface ReferencesSection {
  tree: FileTreeNode[]
  totalFiles: number
  /** 全部查看次数合计。 */
  totalViews: number
}

// ============================================================
// 输出段（§3.4）
// ============================================================

/** 输出文字段的性质（增量设计 §1.2）。 */
export type OutputSegmentKind = 'final' | 'process'

/** 文字输出段（assistant/message 拼接文本）。空文本消息不产出段（规则 F1）。 */
export interface OutputTextSegment {
  /** 稳定 id（`makeEntryId(owningSessionId, seq)`）；output-text 端点按此取全文。 */
  id: string
  seq: number
  time: number
  turn: number
  step: number
  agentKey: string
  /** 轮次序号（turn 首现顺序去重编号，1 起），client 用于过程段分组折叠。 */
  round: number
  /** assistant/message 拼接文本（单段截断 4KB；过程段另按 320B 预览裁剪）。 */
  text: string
  /** 单条正文被 4KB 截断（预算约束）。参与 client 可见类横幅判定。 */
  textTruncated: boolean
  /** 'final' = 该 Agent 的最终答复；'process' = 中间过程输出。 */
  kind: OutputSegmentKind
  /**
   * true = 本段正文是 320B 预览裁剪，全文经 output-text 端点按 id 拉取。
   * final 段恒为 false。**不参与** budgets 计算（与 textTruncated 性质不同）。
   */
  previewOnly: boolean
  /** 被中断的半截输出（仍是该 Agent 的最终答复，规则 F3）。 */
  interrupted?: boolean
}

/** 某个 Agent 的最终答复投影（host 计算并下发，client 不自行推导）。 */
export interface AgentFinalAnswer {
  agentKey: string
  /** 最终答复段；null = 该 Agent 无非空文字输出（规则 F4）。 */
  segment: OutputTextSegment | null
  /** 该 Agent 的过程段数（供「显示过程输出」开关的计数与提示）。 */
  processCount: number
}

/** 输出段。 */
export interface OutputsSection {
  /**
   * 按时间升序的完整段集合（final + process 混排，靠 `kind` 区分）。
   * 唯一权威数组——不拆双数组，避免「同一段属于哪个数组」成为第二处真相。
   */
  textSegments: OutputTextSegment[]
  /**
   * 最终答复投影，顺序 = `agents` 徽标序（主 Agent 最前），**不是时间序**（规则 F5）。
   */
  finalByAgent: AgentFinalAnswer[]
  /** `kind === 'process'` 的段数。 */
  processCount: number
  /** 输出文件树（FileTreeNode.outputOp = create|update）。 */
  files: FileTreeNode[]
  totalFiles: number
}

// ============================================================
// 顶层聚合结果（§3.1）
// ============================================================

/** 三段聚合的顶层载荷（GET /ctx/api/session/:id/context 的 data）。 */
export interface ContextAggregate {
  sessionId: string
  /** 聚合时间戳（epoch ms）。 */
  generatedAt: number
  /** 参与聚合的全部 Agent（含主），供筛选下拉与徽标渲染。 */
  agents: AgentBadge[]
  inputs: InputsSection
  references: ReferencesSection
  outputs: OutputsSection
  budgets: PayloadBudgets
}

// ============================================================
// file / output-text 端点响应（§3.6 ② ③）
// ============================================================

/** GET /ctx/api/session/:id/file 的 data。 */
export interface FileContentResult {
  /** 规范化后的工作区相对路径。 */
  path: string
  realPath: string
  size: number
  /** UTF-8 文本。 */
  content: string
  /** 超过 512KB 截断。 */
  truncated: boolean
  encoding: 'utf-8'
}

/**
 * GET /ctx/api/session/:id/reveal 的 data。
 * 成功只表示「已发出在系统文件管理器中定位的请求」，不保证窗口置顶；
 * 刻意不回传任何路径信息，避免把绝对路径带进 wire 契约。
 */
export interface RevealResult {
  revealed: true
}

/** GET /ctx/api/session/:id/output-text 的 data（完整正文，不受 4KB / 320B 影响）。 */
export interface OutputTextResult {
  /** 段的稳定 id（首选取值键）。 */
  id: string
  /** 段在 `textSegments` 中的下标，仅作诊断保留。 */
  index: number
  agentKey: string
  turn: number
  step: number
  kind: OutputSegmentKind
  text: string
}
