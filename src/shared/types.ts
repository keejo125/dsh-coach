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
  /** 引用分析：本轮被读但未用于任何产物。 */
  unused?: boolean;
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

// ============================================================
// /coach/api 复盘契约（v0.2a：复盘数据层）
// ============================================================

/** /coach/api 全端点统一错误码。 */
export type CoachApiErrorCode =
  | 'COACH_SESSION_NOT_FOUND'
  | 'COACH_BAD_REQUEST'
  | 'COACH_INTERNAL'

/** 错误响应体；message 已脱敏（不含绝对路径与内部栈）。 */
export interface CoachApiErrorBody {
  code: CoachApiErrorCode
  message: string
}

/** /coach/api 全端点统一包络：成功 `{ok:true,data}` / 失败 `{ok:false,error}`。 */
export type CoachApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: CoachApiErrorBody }

/** 会话规模：会话有多长、活动量多大。 */
export interface CoachScope {
  /** 出现事件的轮次数（turn/start 及带 turn 的事件去重）。 */
  turns: number
  /** 用户主动发起的消息数（source.kind === 'user'，主会话视角）。 */
  userTurns: number
  /** 助手步数（assistant/message 事件数，含空文本步）。 */
  assistantSteps: number
  /** 配对成功的工具调用数。 */
  toolCalls: number
  /** 工具调用失败数（result 的 isError / error 字段）。 */
  failedToolCalls: number
  /** 直接子会话数（traceSession 第一层 descendants）。 */
  delegations: number
}

/** 交互质量信号：v0.2a 口径（详见 spec/08 复盘契约）。 */
export interface CoachSignals {
  /**
   * 追问次数 = max(0, userTurns - 1)。
   * v1 简化：首个用户消息视为初始任务，其后的用户消息均算追问/追加。
   */
  followUps: number
  /**
   * 人工干预次数：用户消息紧邻其前一个事件是 tool/result
   * （用户在工具结果落地后介入，而非等助手继续）。
   */
  interventions: number
  /**
   * 纠错轮次：干预中，其前的 tool/result 是失败的
   * （agent 出错后用户介入修正）。
   */
  correctionTurns: number
  /** 重复读文件数：同一文件被 read 查看 ≥ 2 次（未比较内容，v1 口径）。 */
  repeatedReadFiles: number
  /**
   * 失败重试分组数：同一轮次内同一工具名失败 ≥ 2 次的分组
   * （agent 反复调用同一工具连续失败）。
   */
  retriedFailures: number
  /** 上下文压缩次数（compaction/start 事件数）。 */
  compactions: number
}

/** 产物健康：agent 对工作区文件做了什么。 */
export interface CoachArtifacts {
  /** 写入/编辑过的文件总数（write/edit/str_replace_editor 目标，去重）。 */
  writtenFiles: number
  /** 新建文件数（最终操作态为 create）。 */
  createdFiles: number
  /** 被修改 ≥ 2 次的文件数（迭代打磨信号）。 */
  updatedFiles: number
  /** 产物明细（v0.2b 产物树）：每个输出文件的路径、最终操作态与操作次数。 */
  files: CoachArtifactFile[]
}

/** 单个产物文件。 */
export interface CoachArtifactFile {
  /** 规范化工作区相对路径。 */
  path: string
  /** 最终操作态：create=新建；update=更新。 */
  op: 'create' | 'update'
  /** 对该文件执行产物操作的次数（≥1；>1 表示迭代打磨）。 */
  opCount: number
}

/** 质量分维度标识。 */
export type CoachDimensionId = 'completion' | 'efficiency' | 'recovery' | 'artifact' | 'delegation' | 'context'

/** 单维度得分（0-100）。 */
export interface CoachDimensionScore {
  id: CoachDimensionId
  score: number
}

/** 质量分 v1：六维加权（权重见 coach/score.ts 单源）。 */
export interface CoachScore {
  /** 0-100 加权总分。 */
  total: number
  dimensions: CoachDimensionScore[]
}

/** GET /coach/api/session/:id/report 的 data。 */
export interface CoachReport {
  sessionId: string
  /** 生成时间戳（epoch ms）。 */
  generatedAt: number
  scope: CoachScope
  signals: CoachSignals
  artifacts: CoachArtifacts
  score: CoachScore
  // ===== v0.2b 复盘 UI 扩展（spec/09 §4）=====
  /** 子智能体汇总（traceSession 子会话各自 readSession 聚合）。 */
  agents: CoachAgentSummary[]
  /** 文件引用统计（高频 Top + 未使用引用）。 */
  references: CoachReferenceStats
  /** Skill 调用统计（tool/call name='skill'，按 skill 名聚合）。 */
  skills: CoachSkillStats[]
  /** Token 投影（官方 usage 字段扫描；无 usage 数据为 null）。 */
  token: CoachTokenStats | null
  /** 上下文构成投影（轻量版，复用 Context 聚合口径）。 */
  contextProfile: CoachContextProfile | null
  /** 交互时间线索引（详情走 GET /coach/api/session/:id/timeline）。 */
  timeline: { id: string; rounds: number } | null
}

/** 子智能体汇总（v0.2b）。 */
export interface CoachAgentSummary {
  /** 子会话 id。 */
  sessionId: string
  /** 展示名（agentPreset 末段；缺失时降级为「子Agent」）。 */
  label: string
  /** 任务缩写（委派指令/subagent/descriptor 摘要，截断；缺失为 null）。 */
  task: string | null
  role: 'main' | 'subagent'
  /** 用户主动消息数（该子会话视角）。 */
  userTurns: number
  /** 收到委派指令数（其内用户消息数；聚合器口径的近似）。 */
  delegations: number
  /** 读文件数（read 族成功结果，去重）。 */
  readFiles: number
  /** 配对成功的工具调用数。 */
  toolCalls: number
  /** 工具调用失败数。 */
  failedToolCalls: number
  /** 写入/编辑过的文件数（去重）。 */
  writtenFiles: number
  /** 产物明细（v0.2b：并入主会话产物清单；同路径 op 取 create 优先、opCount 相加）。 */
  files: CoachArtifactFile[]
  /** 是否有非空最终答复。 */
  hasFinalAnswer: boolean
  /** 会话日志是否可读（C01：不可读时前端灰行占位，各计数为 0）。 */
  readable: boolean
}

/** 文件引用统计（v0.2b）。 */
export interface CoachReferenceStats {
  /** 查看次数 Top（按 views 降序，至多 10 条）。 */
  topReferences: Array<{ path: string; views: number }>
  /**
   * 未使用引用：被读 ≥ 1 次、未出现在任何产物路径、
   * 且最终答复文本未提及（文件名/路径末段子串匹配）的文件。
   */
  unusedReferences: Array<{ path: string; views: number }>
  /** 参考文件总数（去重）。 */
  totalFiles: number
  /** 查看次数合计（read 族每次调用 +1，与聚合器 §3.7 同口径）。 */
  totalViews: number
}

/** 单次 Skill 调用统计（v0.2b+）：tool/call name='skill'。 */
export interface CoachSkillStats {
  /** skill 名（arguments.name）。 */
  name: string
  /** 调用次数。 */
  calls: number
  /** 失败次数（result isError）。 */
  failed: number
}

/** Token 投影（v0.2b）：assistant/message.data.usage（官方 token-meter 投影）直接扫描。 */
export interface CoachTokenStats {
  /** 会话当前总压力（最后一条 usage.totalTokens）。 */
  total: number
  /** 各条增量 inputTokens 之和。 */
  input: number
  /** 各条增量 outputTokens 之和。 */
  output: number
  /** 最后一条 cacheReadTokens（累计缓存命中）。 */
  cache: number
  /** 按轮次的增量分布（有 usage 的轮次，按轮次升序）。 */
  perTurn: Array<{ turn: number; input: number; output: number; total: number; text: string }>
  /**
   * 输入构成估算（按事件文本字符量，非精确 token 拆解）：
   * system=request/header.system（纯系统提示词）；user=用户主动消息；
   * tools=工具调用参数与结果；plugin=上下文注入（系统注入）；
   * delegation=委派指令（agent-instructions/team-message）。
   * 与上下文构成五对象同名同序：系统提示词/用户提示/委派指令/工具调用/上下文注入。
   */
  profile: { system: number; user: number; tools: number; plugin: number; delegation: number } | null
}

/** 上下文构成投影（v0.2b）：复用 Context 聚合口径的轻量版（不做预算截断判定）。 */
export interface CoachContextProfile {
  /** 用户主动输入条数（source.kind === 'user'）。 */
  userItems: number
  /** 上下文注入条数（source.kind === 'plugin'）。 */
  pluginItems: number
  /** 系统提示词份数（request/header.system 内容去重，通常 1）。 */
  systemItems: number
  /** 直接子会话数。 */
  delegations: number
  /** 系统注入条目中提取的唯一文件路径数（尽力，无则 0 不表示「无注入文件」）。 */
  injectFiles: number
  /** 参考文件总数（去重）。 */
  totalFiles: number
  /** 查看次数合计。 */
  totalViews: number
  /** 最终答复段数（0 或 1）。 */
  finalSegments: number
  /** 过程输出段数（非空 assistant 文本消息数，不含最终段）。 */
  processSegments: number
  /** v0.2c 下钻明细：用户输入摘要列表（clip 160）。 */
  userTexts: string[]
  /** v0.2c 下钻明细：系统注入摘要列表（form/摘要，clip 240）。 */
  pluginSummaries: string[]
  /** v0.2c 下钻明细：委派指令文本列表（agent-instructions，clip 240）。 */
  delegationTexts: string[]
  /** v0.2c 下钻明细：系统注入提取的唯一文件路径（尽力）。 */
  injectPaths: string[]
}

/** 交互时间线：GET /coach/api/session/:id/timeline 的 data。 */
/** P3 建议类型：偏好（用户习惯）/ 规则（操作约定）/ 知识（产物与关键文件）。 */
export type CoachSuggestionKind = 'preference' | 'rule' | 'knowledge'

/** 记忆/规约落点（AGENTS.md 体系：用户全局 ~/.dsh/AGENTS.md 与工作区 AGENTS.md/CLAUDE.md）。 */
export interface CoachMemoryTarget {
  /** 落点类别。 */
  kind: 'global' | 'workspace'
  /** 文件绝对路径。 */
  path: string
  /** 当前是否已存在。 */
  exists: boolean
}

/** 单条复盘建议（host 确定性启发式提炼，无 LLM 依赖）。 */
export interface CoachSuggestion {
  /** 稳定 id（kind + 序号）。 */
  id: string
  kind: CoachSuggestionKind
  /** 一句话标题。 */
  title: string
  /** 建议正文（采纳后写入落点的内容）。 */
  content: string
  /** 依据：来源轮次 / 文件，人类可读。 */
  basis: string
  /** 建议写入的落点。 */
  target: CoachMemoryTarget
}

/** GET /coach/api/session/:id/suggestions 的 data。 */
export interface CoachSuggestions {
  sessionId: string
  /** 生成时间戳（epoch ms）。 */
  generatedAt: number
  /** 检测到的记忆/规约落点（AGENTS.md 体系）。 */
  targets: CoachMemoryTarget[]
  items: CoachSuggestion[]
}

/** POST /coach/api/session/:id/suggestions/accept 的 data。 */
export interface CoachAcceptResult {
  suggestionId: string
  ok: boolean
  /** 实际写入的绝对路径。 */
  path: string
  /** 是否新建了文件。 */
  created: boolean
  /** 人类可读结果说明。 */
  message: string
}

export interface CoachTimeline {
  sessionId: string
  /** 生成时间戳（epoch ms）。 */
  generatedAt: number
  rounds: CoachTimelineRound[]
}

/** 一轮交互（以用户主动消息为分界；结构化事件不单独成轮）。 */
export interface CoachTimelineRound {
  /** 用户输入文本（截断至 400 字符）。 */
  userText: string
  /** 首轮为 initial，其后为 followup。 */
  kind: 'initial' | 'followup'
  signals: {
    /** 该轮存在用户紧邻工具结果后的介入。 */
    intervention: boolean
    /** 该轮存在纠错（介入前工具结果失败）。 */
    correction: boolean
  }
  /** 本轮引用文件（read 成功，path + 本轮查看次数，首次出现序）。 */
  references: CoachTimelineReference[]
  /** 本轮工具动作明细（按事件序；UI 折叠为「过程」）。 */
  actions: CoachTimelineAction[]
  /** 本轮产物明细（成功 write/edit：path + 最终操作态 + 本轮操作次数）。 */
  artifacts: CoachArtifactFile[]
  /** 本轮最后一个非空答复文本（截断至 400 字符）。 */
  assistantText: string | null
}

/** 时间线内单个引用文件。 */
export interface CoachTimelineReference {
  /** 规范化工作区相对路径。 */
  path: string
  /** 本轮内查看次数（read 成功计数）。 */
  views: number
}

/** 时间线内的单个工具动作。 */
export interface CoachTimelineAction {
  name: string
  /** 参考/产物路径（read/write/edit/str_replace_editor 才有；其余为 null）。 */
  path: string | null
  /** 是否失败（result 的 isError / error 字段）。 */
  failed: boolean
  /** 同轮同工具失败 ≥ 2 次的标记（重试后仍失败的信号）。 */
  retried: boolean
}
