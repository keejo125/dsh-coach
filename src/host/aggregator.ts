/**
 * dsh-coach 核心聚合器：SessionQueryEngine 事件流 → ContextAggregate。
 *
 * 设计要点（§1.3 / §7.3 / §7.5）：
 * - 即时聚合不落盘：readSession 一次载入后对事件流做单遍投影扫描
 *   （只提取 user/message、tool/call、tool/result、assistant/message、
 *   subagent/descriptor 五类，其余事件零成本跳过），不构建中间大数组。
 * - tool/call 与 tool/result 经 callId 单趟 Map 配对，不回溯。
 * - 多 Agent：主会话全量扫；子会话经 traceSession 取谱系后逐个 readSession，
 *   并发池 4、失败隔离；单子会话事件超预算 → 该子会话 degraded（仅徽标，无明细）。
 * - 脏数据（JSON 解析失败、未知工具名、绝对路径不在 cwd 下）单条静默跳过，
 *   不中断整体聚合。
 *
 * 基座类型按「结构化最小投影」引用（不 import 基座运行时代码，避免测试
 * 拖入整棵依赖树）；ctx.sessionQuery 结构上满足 AggregatorEngine。
 */

import {
  CHILD_SCAN_CONCURRENCY,
  MAX_CHILD_EVENTS,
  MAX_CHILD_SESSIONS,
  MAX_INPUT_ITEMS,
  MAX_OUTPUT_SEGMENTS,
  MAX_REFERENCE_FILES,
  MAX_TOTAL_OUTPUT_SEGMENTS,
  PROCESS_PREVIEW_BYTES,
  TEXT_TRUNCATE_BYTES,
} from '../shared/constants.ts'
import { extractInjectFilePaths } from '../shared/extract.ts'
import { makeEntryId } from '../shared/ids.ts'
import { normalizeWorkspacePath, relativizeAgainstRoot } from '../shared/path.ts'
import type {
  AgentBadge,
  AgentFinalAnswer,
  AgentInputGroup,
  AttachmentRef,
  ContextAggregate,
  FileTreeNode,
  InjectContextForm,
  OutputTextSegment,
  PayloadBudgets,
  PluginInjectItem,
  UserInputItem,
  UserInputKind,
} from '../shared/types.ts'

// ============================================================
// 基座类型的结构化投影（只取聚合用到的字段）
// ============================================================

/** 会话 header 投影（SessionHeader 子集；cwd 是 file 端点与路径相对化的锚点）。 */
export interface AggregatorSessionHeader {
  id: string
  cwd?: string
  parentSession?: string
  origin?: string
  delegationDepth?: number
  agentPreset?: string
}

/** 会话事件投影（SessionEvent 子集；data 保持 unknown，扫描内窄化）。 */
export interface AggregatorEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/** readSession 返回投影（SessionLogSnapshot 子集）。 */
export interface AggregatorSessionLog {
  session: AggregatorSessionHeader
  events: AggregatorEvent[]
}

/** traceSession 谱系节点投影（SessionLineageNode 子集）。 */
export interface AggregatorLineageNode {
  session: { header: AggregatorSessionHeader }
  descendants: AggregatorLineageNode[]
}

/** 聚合器所需的基座查询面（SessionQueryEngine 的结构化子集）。 */
export interface AggregatorEngine {
  readSession(sessionId: string): Promise<AggregatorSessionLog>
  // 注意 target 是 SessionRecord 投影（.header 直挂），不是 SessionLogSnapshot
  // 的 .session.header——谱系节点才是后者。两者层级不同，勿混。
  traceSession(sessionId: string): Promise<{ target: { header: AggregatorSessionHeader }; descendants: AggregatorLineageNode[] }>
}

// ============================================================
// 聚合器输出（含 output-text 端点所需的未截断全文侧信道）
// ============================================================

/**
 * aggregateContext 的完整返回：ContextAggregate + 各文字段未截断全文。
 *
 * 全文按**段 id** 索引（增量设计 §1.3），不再是「与 textSegments 下标对齐」的数组：
 * 排序/筛选/预算淘汰都不动 id，端点不会因中间新增输出而静默指向另一段。
 */
export interface AggregateResult {
  aggregate: ContextAggregate
  /** id → 完整正文（不受 4KB 截断与 320B 预览裁剪影响），output-text 端点用。 */
  outputFullTexts: ReadonlyMap<string, string>
}

/**
 * 父会话里一次委派工具调用的观测（`tool/call` 事件，用于子会话降级时兜底）。
 * `description` 只参与形状识别（`isDelegationCall`），不入队。
 */
interface DelegationCall {
  callId: string
  seq: number
  time: number
  turn: number | undefined
  prompt: string
}

// ============================================================
// 内部扫描结构
// ============================================================

interface ToolCallRecord {
  name: string
  args: Record<string, unknown> | null
}

interface RefView {
  count: number
  agents: string[]
}

/** 输出文件条目的可变状态：最终操作态 + 贡献者（agents 是 §3.3 三树共用字段）。 */
interface OutputOp {
  op: 'create' | 'update'
  agents: string[]
}

/** 记录一次输出操作：同文件多次操作时最终态取后写，agents 归集全部贡献者。 */
function recordOutput(scan: SessionScan, path: string, op: 'create' | 'update', agentKey: string): void {
  const existing = scan.outputs.get(path)
  if (existing === undefined) {
    scan.outputs.set(path, { op, agents: [agentKey] })
    return
  }
  existing.op = op
  if (!existing.agents.includes(agentKey)) existing.agents.push(agentKey)
}

interface SessionScan {
  userItems: UserInputItem[]
  pluginItems: PluginInjectItem[]
  refs: Map<string, RefView>
  outputs: Map<string, OutputOp>
  segments: OutputTextSegment[]
  /** id → 未截断全文。随段一起增删，取代原先「下标对齐数组」的脆弱耦合。 */
  fullTexts: Map<string, string>
  /** 因段预算被丢弃的段数（单会话滑动窗口 + 收口）。 */
  droppedSegments: number
  /** 最后一次 `subagent/descriptor` 的 seq（缺省 -1）：其前的 user/message 是继承的父上下文。 */
  descriptorSeq: number
  /** 主会话 `team/member` 事件解析出的 子会话id → {name,description}（team 模式子 Agent 的真名与任务描述）。 */
  teamMembers: Map<string, { name: string; description?: string }>
  /** 尚未被 `subagent/start` 配对的委派调用（FIFO）。 */
  pendingDelegations: DelegationCall[]
  /** `subagent/start.id` → 发起它的委派调用（精确相等配对，门控 2）。 */
  delegationsByChild: Map<string, DelegationCall>
  descriptorLabel: string | undefined
  /**
   * 最后一条 `agent-preset/selected` 的 preset id。
   * 会话 header 的 agentPreset 只是建会话时的默认值（常为 `standard`），
   * 用户在会话中切换 preset 后，真正生效的是这条事件。
   */
  selectedPreset: string | undefined
  inputItemsCapped: boolean
  outputSegmentsCapped: boolean
}

/** 委派工具的默认工具名（基座 `tool-subagent`）。 */
const SUBAGENT_TOOL_NAME = 'subagent'

/**
 * 是否为一次委派调用。
 *
 * 主判据是工具名；附加**形状兜底**以兼容可配置 `toolName` 的部署：
 * `arguments` 同时含 `description` 与 `prompt` 两个字符串字段（§1.5 门控 3）。
 */
function isDelegationCall(name: string, args: Record<string, unknown> | null): boolean {
  if (args === null) return false
  if (name === SUBAGENT_TOOL_NAME) return typeof args['prompt'] === 'string'
  return typeof args['description'] === 'string' && typeof args['prompt'] === 'string'
}

function safeParseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 单个码点的 UTF-8 字节宽度，以及它占用几个 UTF-16 代码单元。
 * 代理对（emoji 等增补平面字符）算 4 字节、占 2 个代码单元。
 */
function utf8Width(unit: number, next: number | undefined): { width: number; units: number } {
  if (unit >= 0xd800 && unit <= 0xdbff && next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
    return { width: 4, units: 2 } // 代理对：整对保留或整对丢弃，绝不切一半
  }
  if (unit < 0x80) return { width: 1, units: 1 }
  if (unit < 0x800) return { width: 2, units: 1 }
  return { width: 3, units: 1 } // 含孤立代理（按 U+FFFD 计）
}

/**
 * 单条文本按 UTF-8 字节截断（§7.4：4KB；过程段预览：320B）。
 *
 * 阈值是**字节**而非 UTF-16 长度：按 `.length` 截断会让中文载荷实际膨胀到约 3 倍
 * （一个汉字 1 个代码单元但 3 字节），且切片可能落在代理对中间产出半个字符。
 * 这里按真实 UTF-8 字节累计，且遇代理对整对取舍。
 */
function truncateText(text: string, limit = TEXT_TRUNCATE_BYTES): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= limit) return { text, truncated: false }
  let bytes = 0
  let end = 0
  while (end < text.length) {
    const { width, units } = utf8Width(text.charCodeAt(end), end + 1 < text.length ? text.charCodeAt(end + 1) : undefined)
    if (bytes + width > limit) break
    bytes += width
    end += units
  }
  return { text: text.slice(0, end), truncated: true }
}

/**
 * 按段预算收口：保留**最新** `keep` 段，其余从头部丢弃（§1.2 F6）。
 *
 * 方向是「保留最新」而非「保留最早」——最终答复判定取的是时间序最后一段，
 * 保留最早会让该判定在超长会话上永远失效。
 */
function trimSegments(scan: SessionScan, keep: number): void {
  const overflow = scan.segments.length - keep
  if (overflow <= 0) return
  const dropped = scan.segments.splice(0, overflow)
  for (const segment of dropped) scan.fullTexts.delete(segment.id)
  scan.droppedSegments += dropped.length
  scan.outputSegmentsCapped = true
}

/** ContextForm 词表校验：未知 form 落回缺省（不猜测）。 */
function asInjectForm(value: unknown): InjectContextForm | undefined {
  const known: readonly InjectContextForm[] = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']
  return typeof value === 'string' && (known as readonly string[]).includes(value) ? value as InjectContextForm : undefined
}

/** 把基座展示路径折算成规范化工作区相对路径；不可解析返回 null（静默丢弃）。 */
function toWorkspacePath(displayPath: unknown, cwd: string | undefined): string | null {
  const raw = textOf(displayPath)
  if (raw === undefined || raw.length === 0) return null
  const relative = relativizeAgainstRoot(raw, cwd)
  if (relative === null) return null
  return normalizeWorkspacePath(relative)
}

/** 从 user/message 内容块提取 text 块拼接文本与附件（宁缺勿错：未知块类型跳过）。 */
function extractMessageContent(content: unknown): { text: string; attachments: AttachmentRef[] } {
  const texts: string[] = []
  const attachments: AttachmentRef[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') {
        texts.push(record['text'])
      } else if (record['type'] === 'image' && record['attachment'] !== null && typeof record['attachment'] === 'object') {
        // 基座 ImageAttachmentRef 明确「never a filesystem path」，附件 v1 仅展示名。
        const att = record['attachment'] as Record<string, unknown>
        const mediaType = textOf(att['mediaType'])
        const name = textOf(att['name']) ?? mediaType ?? 'image'
        const attachment: AttachmentRef = { name }
        // 契约里 mediaType 可选；无值时保持属性缺省而非显式 undefined
        if (mediaType !== undefined) attachment.mediaType = mediaType
        attachments.push(attachment)
      }
    }
  }
  return { text: texts.join('\n'), attachments }
}

// ============================================================
// 单会话投影扫描
// ============================================================

/**
 * 对一个会话的事件流做单遍投影扫描。
 * @param events 事件流（主会话无上限；子会话超过 MAX_CHILD_EVENTS 返回 degraded=true）。
 * @param agentKey 归属键（主会话恒 `'main'`，子会话为其 sessionId）。
 * @param owningSessionId 拥有者会话 id——条目稳定 id 的前半段（§1.3）。
 */
function scanSession(
  events: readonly AggregatorEvent[],
  agentKey: string,
  cwd: string | undefined,
  isChild: boolean,
  owningSessionId: string,
): { scan: SessionScan; degraded: boolean } {
  const scan: SessionScan = {
    userItems: [],
    pluginItems: [],
    refs: new Map(),
    outputs: new Map(),
    segments: [],
    fullTexts: new Map(),
    droppedSegments: 0,
    descriptorSeq: -1,
    teamMembers: new Map(),
    pendingDelegations: [],
    delegationsByChild: new Map(),
    descriptorLabel: undefined,
    selectedPreset: undefined,
    inputItemsCapped: false,
    outputSegmentsCapped: false,
  }
  const calls = new Map<string, ToolCallRecord>()
  const turnRounds = new Map<number, number>()
  let currentTurn: number | undefined
  let eventCount = 0

  // 前置一趟找最后一次 `subagent/descriptor` 的 seq（缺省 -1）。
  // 必须在扫描前确定：带继承父上下文前缀的子会话里，历史 user/message 排在 descriptor
  // **之前**，若边扫边更新分界点，这些历史条会被误判成委派指令（§1.5）。
  // 只对事件 type 做一次比较，成本与扫描本身同阶，可忽略。
  for (const event of events) {
    if (event.type === 'subagent/descriptor') scan.descriptorSeq = Math.max(scan.descriptorSeq, event.seq)
  }

  for (const event of events) {
    eventCount += 1
    if (isChild && eventCount > MAX_CHILD_EVENTS) {
      // 子会话扫描预算（§7.4）：超出即降级，丢弃该会话全部明细
      return { scan, degraded: true }
    }
    // preset 切换：以**最后一条**为准（header 的 agentPreset 只是建会话时的默认值）
    if (event.type === 'agent-preset/selected') {
      const data = event.data
      if (data !== null && typeof data === 'object') {
        const id = (data as Record<string, unknown>)['agentPreset']
        if (typeof id === 'string' && id.length > 0) scan.selectedPreset = id
      }
      continue
    }
    switch (event.type) {
      case 'turn/start': {
        const data = event.data as { turn?: unknown }
        currentTurn = typeof data.turn === 'number' ? data.turn : undefined
        break
      }
      case 'user/message': {
        const data = event.data as { content?: unknown; source?: Record<string, unknown> }
        const source = data.source
        if (source === undefined || typeof source !== 'object') break
        const sourceKind = source['kind']
        const { text, attachments } = extractMessageContent(data.content)
        if (sourceKind === 'user' || sourceKind === 'team-message') {
          if (scan.userItems.length + scan.pluginItems.length >= MAX_INPUT_ITEMS) {
            scan.inputItemsCapped = true
            break
          }
          const truncated = truncateText(text)
          if (sourceKind === 'team-message') {
            // Agent 间消息（Team 模式主 Agent 的后续指令等）：归入输入栏，标签「来自XXX的消息」
            const senderName = textOf(source['senderName']) ?? 'unknown'
            const item: UserInputItem = {
              id: makeEntryId(owningSessionId, event.seq),
              seq: event.seq,
              time: event.time,
              agentKey,
              inputKind: 'agent-message',
              text: truncated.text,
              textTruncated: truncated.truncated,
              attachments,
              senderName,
            }
            if (currentTurn !== undefined) item.turn = currentTurn
            scan.userItems.push(item)
          } else {
            const rpcId = source['rpcId']
            const hasRpcId = typeof rpcId === 'string' && rpcId.length > 0
            const item: UserInputItem = {
              id: makeEntryId(owningSessionId, event.seq),
              seq: event.seq,
              time: event.time,
              agentKey,
              inputKind: classifyInputKind(scan, agentKey, event.seq, hasRpcId),
              text: truncated.text,
              textTruncated: truncated.truncated,
              attachments,
            }
            if (currentTurn !== undefined) item.turn = currentTurn
            scan.userItems.push(item)
          }
        } else if (sourceKind === 'plugin') {
          if (scan.userItems.length + scan.pluginItems.length >= MAX_INPUT_ITEMS) {
            scan.inputItemsCapped = true
            break
          }
          const plugin = textOf(source['plugin']) ?? 'unknown'
          const form = asInjectForm(source['form'])
          // 快照 form：逐 sections[].text 独立提取后合并；notice 摘要也参与提取
          let extractTexts: string[]
          let displayText: string
          if (form === 'snapshot' && Array.isArray(source['sections'])) {
            const sectionTexts = (source['sections'] as unknown[])
              .map(section => (section !== null && typeof section === 'object' ? textOf((section as Record<string, unknown>)['text']) : undefined))
              .filter((value): value is string => value !== undefined)
            extractTexts = sectionTexts
            displayText = sectionTexts.join('\n\n')
          } else {
            const summary = form === 'notice' ? textOf(source['summary']) : undefined
            extractTexts = summary !== undefined ? [summary, text] : [text]
            displayText = text
          }
          const truncated = truncateText(displayText)
          const item: PluginInjectItem = {
            id: makeEntryId(owningSessionId, event.seq),
            seq: event.seq,
            time: event.time,
            agentKey,
            plugin,
            text: truncated.text,
            textTruncated: truncated.truncated,
            filePaths: extractInjectFilePaths(form, extractTexts),
          }
          if (form !== undefined) item.form = form
          if (form === 'notice') {
            const summary = textOf(source['summary'])
            if (summary !== undefined) item.summary = summary
          }
          scan.pluginItems.push(item)
        }
        // 其他 source.kind（model/tool 等不该出现在 user/message）静默跳过
        break
      }
      case 'tool/call': {
        const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown; turn?: unknown }
        if (typeof data.callId !== 'string' || typeof data.name !== 'string') break
        const args = typeof data.arguments === 'string' ? safeParseArgs(data.arguments) : null
        calls.set(data.callId, { name: data.name, args })
        // 委派调用入待配对队列（父会话侧，供子会话降级时兜底，§1.5）
        if (isDelegationCall(data.name, args)) {
          const prompt = args === null ? undefined : textOf(args['prompt'])
          if (prompt !== undefined) {
            const call: DelegationCall = {
              callId: data.callId,
              seq: event.seq,
              time: event.time,
              turn: typeof data.turn === 'number' ? data.turn : undefined,
              prompt,
            }
            scan.pendingDelegations.push(call)
          }
        }
        break
      }
      case 'tool/result': {
        const data = event.data as { callId?: unknown; message?: { content?: unknown }; meta?: unknown; error?: unknown }
        const callId = typeof (data as Record<string, unknown>)['callId'] === 'string' ? (data as Record<string, unknown>)['callId'] as string : undefined
        // 实际 callId 在 message.source.callId；顶层亦有 message.source
        const sourceCallId = data.message !== undefined && typeof data.message === 'object'
          ? ((data.message as { source?: { callId?: unknown } }).source?.['callId'])
          : undefined
        const resolvedCallId = typeof sourceCallId === 'string' ? sourceCallId : callId
        if (resolvedCallId === undefined) break
        // 委派调用一旦被 result 消费就退出配对窗口（基座时序：call → start → result）
        consumeDelegation(scan, resolvedCallId)
        const call = calls.get(resolvedCallId)
        if (call === undefined) break // 未配对调用不计数（§3.7 计数源须有配对 result）
        calls.delete(resolvedCallId)
        // 失败结果（isError）不计参考——未真实查看内容
        const firstBlock = Array.isArray(data.message?.content) ? (data.message.content as unknown[])[0] : undefined
        if (firstBlock !== null && typeof firstBlock === 'object' && (firstBlock as Record<string, unknown>)['isError'] === true) break
        const meta = (data.meta !== null && typeof data.meta === 'object' && !Array.isArray(data.meta)) ? data.meta as Record<string, unknown> : undefined
        const args = call.args
        classifyToolResult(call.name, args, meta, cwd, agentKey, scan)
        break
      }
      case 'assistant/message': {
        const data = event.data as { turn?: unknown; step?: unknown; message?: { content?: unknown }; interrupted?: unknown }
        const turn = typeof data.turn === 'number' ? data.turn : 0
        const step = typeof data.step === 'number' ? data.step : 0
        const { text } = extractMessageContent(data.message?.content)
        // 规则 F1：空文本段无资格成为最终答复，且对 UI 零贡献——扫描期即跳过，
        // 避免「输出 N 段」计数被纯工具调用的空 assistant/message 灌水。
        if (text.trim().length === 0) break
        // 段预算滑动窗口（§1.2 F6）：触达 2× 水位时一次性裁掉最早的一半，
        // 避免每次 shift() 的 O(n²)，内存上界 ≈ 1000 段。
        if (scan.segments.length >= MAX_OUTPUT_SEGMENTS * 2) trimSegments(scan, MAX_OUTPUT_SEGMENTS)
        const truncated = truncateText(text)
        let round = turnRounds.get(turn)
        if (round === undefined) {
          round = turnRounds.size + 1
          turnRounds.set(turn, round)
        }
        const id = makeEntryId(owningSessionId, event.seq)
        const segment: OutputTextSegment = {
          id,
          seq: event.seq,
          time: event.time,
          turn,
          step,
          agentKey,
          round,
          text: truncated.text,
          textTruncated: truncated.truncated,
          kind: 'process', // 真正归属由 markFinalSegments 在合并排序后裁定
          previewOnly: false,
        }
        if (data.interrupted === true) segment.interrupted = true
        scan.segments.push(segment)
        scan.fullTexts.set(id, text)
        break
      }
      case 'subagent/descriptor': {
        // 子会话内 descriptor 事件携带 label（最后一个生效）；
        // 其 seq 同时是「继承父上下文前缀」与「委派指令」的分界（§1.5）
        const data = event.data as { label?: unknown }
        const label = textOf(data.label)
        if (label !== undefined && label.length > 0) scan.descriptorLabel = label
        break
      }
      case 'subagent/start': {
        // 基座 SubagentRunInfo.id 就是子会话 id（packages/subagent/subagent/src/types.ts:38-46）。
        // 时序上 tool/call → subagent/start → tool/result，故此刻该 call 仍在待配对队列。
        const data = event.data as { id?: unknown }
        const childId = textOf(data.id)
        if (childId === undefined || childId.length === 0) break
        if (scan.pendingDelegations.length === 1) {
          const call = scan.pendingDelegations[0]
          scan.pendingDelegations.length = 0
          // 门控 2：配对锚点必须精确相等；同一子会话只认首次配对
          if (call !== undefined && !scan.delegationsByChild.has(childId)) {
            scan.delegationsByChild.set(childId, call)
          }
        } else if (scan.pendingDelegations.length > 1) {
          // 门控 4：多个无法区分的未配对委派调用 → 全部放弃（宁缺勿错）
          scan.pendingDelegations.length = 0
        }
        break
      }
      case 'team/member': {
        // Team 模式：主会话里登记子 Agent 的真名与任务描述（name=developer，description=任务）。
        // 仅主会话侧出现，故只有主扫描会填充 teamMembers；子会话据此取「短名 + 描述 hover」。
        const data = event.data as { member?: Record<string, unknown> }
        const member = data.member
        if (member !== null && typeof member === 'object') {
          const id = textOf(member['id'])
        if (id !== undefined && id.length > 0) {
          const name = textOf(member['name']) ?? id
          const description = textOf(member['description'])
          scan.teamMembers.set(id, description !== undefined ? { name, description } : { name })
        }
        }
        break
      }
      default:
        // 其余事件零成本跳过（§7.5）
        break
    }
  }
  // 扫描收口：单会话段数按「保留最新」收口到 MAX_OUTPUT_SEGMENTS
  trimSegments(scan, MAX_OUTPUT_SEGMENTS)
  return { scan, degraded: false }
}

/**
 * 判定一条 user/message（source.kind === 'user'）在输入栏里的语义分类（按来源 provenance）。
 *
 * 硬判据（见契约注释 `UserInputKind`）：
 * - 主会话：一律 `user`；
 * - 子会话 descriptor **之前**：带 rpcId → `inherited`（继承的父上下文原话）；否则 `user`；
 * - 子会话 descriptor 之后：带 rpcId → `user`（你直接对该子 Agent 说的）；
 *   无 rpcId → `delegation`（主 Agent 下发；非 Team 模式 send_message 追加指令也归此，
 *   凭「是否多条」区分 Team / 非 Team）。
 *
 * `rpcId` 是真实客户端请求的标识：有 rpcId = 用户/客户端真说过这句话；无 rpcId = 系统/programmatic 注入。
 */
function classifyInputKind(scan: SessionScan, agentKey: string, seq: number, hasRpcId: boolean): UserInputKind {
  if (agentKey === 'main') return 'user'
  if (seq <= scan.descriptorSeq) return hasRpcId ? 'inherited' : 'user'
  return hasRpcId ? 'user' : 'delegation'
}

/** 委派调用被 tool/result 消费后退出配对窗口。 */
function consumeDelegation(scan: SessionScan, callId: string): void {
  const index = scan.pendingDelegations.findIndex(call => call.callId === callId)
  if (index >= 0) scan.pendingDelegations.splice(index, 1)
}

/** 参考/输出操作分类（§3.7 计数口径 + 架构师修正的 write 兜底口径）。 */
function classifyToolResult(
  toolName: string,
  args: Record<string, unknown> | null,
  meta: Record<string, unknown> | undefined,
  cwd: string | undefined,
  agentKey: string,
  scan: SessionScan,
): void {
  const argPath = (key: string): string | undefined => (args === null ? undefined : textOf(args[key]))

  // —— 参考计数：read / read_image / str_replace_editor view ——
  let refPath: string | undefined
  if (toolName === 'read') {
    // 路径来源优先 meta.path（基座持久化展示载荷，绝对展示路径），缺失回落 arguments.file_path
    refPath = textOf(meta?.['path']) ?? argPath('file_path')
  } else if (toolName === 'read_image') {
    // read_image 无 presentationMeta（read-image.ts 实证），回落 arguments.file_path
    refPath = argPath('file_path')
  } else if (toolName === 'str_replace_editor') {
    // str_replace_editor 仅计 view 命令；参数名是 path（非 file_path）
    if (args !== null && args['command'] === 'view') refPath = argPath('path')
  }
  if (refPath !== undefined) {
    const normalized = toWorkspacePath(refPath, cwd)
    if (normalized !== null) {
      const existing = scan.refs.get(normalized)
      if (existing === undefined) {
        // 预算：参考文件条目上限（超出不再计入新文件）
        if (scan.refs.size < MAX_REFERENCE_FILES) {
          scan.refs.set(normalized, { count: 1, agents: [agentKey] })
        }
      } else {
        // 部分读口径：每次调用 +1，不按行加权；重复读累计
        existing.count += 1
        if (!existing.agents.includes(agentKey)) existing.agents.push(agentKey)
      }
    }
    return // read / read_image / str_replace_editor view 都是参考操作，不判输出
  }

  // —— 输出操作：write / edit / str_replace_editor(create|str_replace|insert) ——
  if (toolName === 'write') {
    // 架构师修正口径：write 新建文件时 meta.diffs === []（before === null → diffs 空），
    // create/update 判定 = diffs 非空 → update / 空 → create；
    // 新建路径必须从 tool/call.arguments 解析 file_path 兜底。
    const diffs = Array.isArray(meta?.['diffs']) ? meta['diffs'] as unknown[] : []
    const path = toWorkspacePath(argPath('file_path') ?? textOf((diffs[0] as Record<string, unknown> | undefined)?.['path']), cwd)
    if (path !== null) recordOutput(scan, path, diffs.length > 0 ? 'update' : 'create', agentKey)
  } else if (toolName === 'edit') {
    const diffs = Array.isArray(meta?.['diffs']) ? meta['diffs'] as unknown[] : []
    const path = toWorkspacePath(argPath('file_path') ?? textOf((diffs[0] as Record<string, unknown> | undefined)?.['path']), cwd)
    if (path !== null) recordOutput(scan, path, 'update', agentKey)
  } else if (toolName === 'str_replace_editor') {
    const command = args === null ? undefined : textOf(args['command'])
    if (command === 'create' || command === 'str_replace' || command === 'insert') {
      const path = toWorkspacePath(argPath('path'), cwd)
      if (path !== null) recordOutput(scan, path, command === 'create' ? 'create' : 'update', agentKey)
    }
  }
}

// ============================================================
// 文件树构建
// ============================================================

interface TreeEntry {
  viewCount?: number
  outputOp?: 'create' | 'update'
  agents?: string[]
}

/** 用规范化路径集合构建目录树；同层 dir 前、字典序。文件规模上限 2000，两段式构建成本可接受。 */
function buildFileTree(entries: ReadonlyMap<string, TreeEntry>): FileTreeNode[] {
  // 第一段：按路径段插入中间字典树（dirs 嵌套 + files 叶子）
  interface Builder { files: Map<string, TreeEntry>; dirs: Map<string, Builder> }
  const tree: Builder = { files: new Map(), dirs: new Map() }
  for (const [path, entry] of entries) {
    const segments = path.split('/')
    let level = tree
    for (let index = 0; index < segments.length - 1; index += 1) {
      const seg = segments[index] as string
      let dir = level.dirs.get(seg)
      if (dir === undefined) {
        dir = { files: new Map(), dirs: new Map() }
        level.dirs.set(seg, dir)
      }
      level = dir
    }
    const fileName = segments.at(-1)
    if (fileName !== undefined) level.files.set(fileName, entry)
  }

  const emit = (builder: Builder, parentPath: string): FileTreeNode[] => {
    const nodes: FileTreeNode[] = []
    const dirNames = [...builder.dirs.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of dirNames) {
      const dir = builder.dirs.get(name)
      if (dir === undefined) continue
      const path = parentPath.length === 0 ? name : `${parentPath}/${name}`
      const children = emit(dir, path)
      const node: FileTreeNode = { name, path, type: 'dir', children }
      // 目录节点的 agents 汇总其下文件的去重贡献（主在前）
      const agents = collectAgents(children)
      if (agents.length > 0) node.agents = agents
      nodes.push(node)
    }
    const fileNames = [...builder.files.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of fileNames) {
      const entry = builder.files.get(name)
      if (entry === undefined) continue
      const path = parentPath.length === 0 ? name : `${parentPath}/${name}`
      const node: FileTreeNode = { name, path, type: 'file' }
      if (entry.viewCount !== undefined) node.viewCount = entry.viewCount
      if (entry.outputOp !== undefined) node.outputOp = entry.outputOp
      if (entry.agents !== undefined && entry.agents.length > 0) node.agents = sortAgents(entry.agents)
      nodes.push(node)
    }
    return nodes
  }

  return emit(tree, '')
}

/** agents 去重 + 主在前（§3.3：去重，主在前；其余按首次出现）。 */
function sortAgents(agents: readonly string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const agent of agents) {
    if (seen.has(agent)) continue
    seen.add(agent)
    ordered.push(agent)
  }
  ordered.sort((a, b) => {
    if (a === 'main') return -1
    if (b === 'main') return 1
    return 0 // 保持首次出现序
  })
  return ordered
}

function collectAgents(nodes: readonly FileTreeNode[]): string[] {
  const merged: string[] = []
  for (const node of nodes) {
    for (const agent of node.agents ?? []) {
      if (!merged.includes(agent)) merged.push(agent)
    }
  }
  return sortAgents(merged)
}

// ============================================================
// 顶层聚合
// ============================================================

/** 谱系树 DFS 展平为子会话 header 列表（保持树序）。 */
function flattenDescendants(nodes: readonly AggregatorLineageNode[], out: AggregatorSessionHeader[]): void {
  for (const node of nodes) {
    out.push(node.session.header)
    flattenDescendants(node.descendants, out)
  }
}

/** 会话 id 短码长度（§7.2 的 id 前 8 位；冲突消解时也用作起始长度）。 */
const SHORT_ID_LENGTH = 8

/**
 * 取能在本组内区分开的最短 id 前缀（至少 SHORT_ID_LENGTH 位）。
 *
 * 真实会话 id 前 8 位已足够区分，故常规形态就是「前 8 位短码」；但 id 前 8 位
 * **自身**就相同的情况（如 child-030 / child-031 / child-033）必须再放宽几位，
 * 否则追加了短码仍然重名，等于没修。
 */
function uniqueIdPrefix(sessionId: string, group: readonly AgentBadge[]): string {
  for (let length = SHORT_ID_LENGTH; length <= sessionId.length; length += 1) {
    const prefix = sessionId.slice(0, length)
    const collides = group.some(badge => badge.sessionId !== sessionId && badge.sessionId.startsWith(prefix))
    if (!collides) return prefix
  }
  return sessionId
}

/**
 * 子 Agent 标签冲突消解：同名标签追加 sessionId 短码（`standard · a17c3f2b`）。
 *
 * 只在**真正冲突**时追加——有真实 `descriptor.label` 的保持原样，不给所有标签
 * 都挂短码（真实 12-Agent 会话里 5 个子 Agent 都是 agentPreset='standard' 且
 * 无 descriptor，下拉里 5 条一模一样，无从分辨）。
 *
 * 用 sessionId 短码而不是序号：序号会随筛选/降级情况跳变，短码稳定且唯一。
 * 落在 host 侧做（而非 client）：`AgentBadge.label` 是「这个 Agent 叫什么」的
 * 唯一真相，徽标与筛选下拉两处都读它，天然一致，无需在组件间传递额外映射。
 *
 * 主 Agent 不参与：全局只有一个 main，其展示名由 client 按 role 做 locale 化。
 */
function disambiguateAgentLabels(agents: readonly AgentBadge[]): void {
  const byLabel = new Map<string, AgentBadge[]>()
  for (const badge of agents) {
    if (badge.role !== 'subagent') continue
    const list = byLabel.get(badge.label)
    if (list === undefined) byLabel.set(badge.label, [badge])
    else list.push(badge)
  }
  for (const group of byLabel.values()) {
    if (group.length < 2) continue
    for (const badge of group) {
      badge.label = `${badge.label} · ${uniqueIdPrefix(badge.sessionId, group)}`
    }
  }
}

// ============================================================
// 最终答复判定（§1.2 规则 F1~F6）
// ============================================================

interface FinalMark {
  finalByAgent: AgentFinalAnswer[]
}

/**
 * 标记每段的 `kind` 并产出 `finalByAgent` 投影。
 *
 * 必须在**合并 + 全局时间排序之后**调用——「最后一段」是时间序概念。
 * segments 已按 `time || seq` 升序，故单趟扫描「后到的覆盖先到的」即为规则 F2
 * （被覆盖的旧候选降级为 `process`）。空文本段在扫描期已剔除（规则 F1），
 * 被打断的段（规则 F3）不予区别对待——它就是该 Agent 最后说出的话。
 */
function markFinalSegments(segments: readonly OutputTextSegment[], agents: readonly AgentBadge[]): FinalMark {
  const finalByKey = new Map<string, OutputTextSegment>()
  const processCountByKey = new Map<string, number>()
  for (const segment of segments) {
    const previous = finalByKey.get(segment.agentKey)
    if (previous !== undefined) {
      previous.kind = 'process'
      processCountByKey.set(segment.agentKey, (processCountByKey.get(segment.agentKey) ?? 0) + 1)
    }
    finalByKey.set(segment.agentKey, segment)
    segment.kind = 'final'
  }
  // 规则 F5：顺序 = agents 徽标序（main 最前，子会话按谱系树序），**不是时间序**。
  // 零非空文本的 Agent 以 segment: null 出现（规则 F4），由 client 决定是否渲染。
  // processCount 先置 0，由 recountProcess 在段预算收口后统一重算（见下）。
  const finalByAgent: AgentFinalAnswer[] = agents.map(badge => ({
    agentKey: badge.agentKey,
    segment: finalByKey.get(badge.agentKey) ?? null,
    processCount: 0,
  }))
  for (const [agentKey, count] of processCountByKey) {
    const entry = finalByAgent.find(item => item.agentKey === agentKey)
    if (entry !== undefined) entry.processCount = count
  }
  return { finalByAgent }
}

/**
 * 重算过程段计数（全局 + 每个 Agent）。
 *
 * 必须在段预算收口**之后**调用：全局预算会淘汰最早的过程段，若沿用它之前的
 * 计数，`outputs.processCount` 会大于 `textSegments.filter(kind==='process').length`
 * ——而契约里这两者被定义为相等（§3.2）。
 */
function recountProcess(segments: readonly OutputTextSegment[], finalByAgent: readonly AgentFinalAnswer[]): number {
  const byKey = new Map<string, number>()
  let total = 0
  for (const segment of segments) {
    if (segment.kind !== 'process') continue
    total += 1
    byKey.set(segment.agentKey, (byKey.get(segment.agentKey) ?? 0) + 1)
  }
  for (const entry of finalByAgent) entry.processCount = byKey.get(entry.agentKey) ?? 0
  return total
}

/**
 * 全局段预算（§1.2 F6）：超出 `MAX_TOTAL_OUTPUT_SEGMENTS` 时按时间序淘汰**最早的过程段**。
 * final 段永不淘汰——最终答复是本栏的核心产物。
 */
function applyGlobalSegmentBudget(segments: readonly OutputTextSegment[]): { segments: OutputTextSegment[]; dropped: number } {
  const overflow = segments.length - MAX_TOTAL_OUTPUT_SEGMENTS
  if (overflow <= 0) return { segments: [...segments], dropped: 0 }
  let dropped = 0
  const kept: OutputTextSegment[] = []
  for (const segment of segments) {
    if (dropped < overflow && segment.kind === 'process') {
      dropped += 1
      continue
    }
    kept.push(segment)
  }
  return { segments: kept, dropped }
}

/**
 * 过程段正文按 `PROCESS_PREVIEW_BYTES` 裁剪为预览（§1.4）。
 *
 * 用独立字段 `previewOnly` 表达，**不参与 budgets 计算**：若复用 `textTruncated`，
 * 过程段恒为「已截断」会让顶部横幅永远为真。final 段不受影响（走 4KB 常规截断）。
 */
function applyPreviewTruncation(segments: readonly OutputTextSegment[]): void {
  for (const segment of segments) {
    if (segment.kind !== 'process') {
      segment.previewOnly = false
      continue
    }
    const preview = truncateText(segment.text, PROCESS_PREVIEW_BYTES)
    segment.text = preview.text
    segment.previewOnly = preview.truncated
  }
}

// ============================================================
// 输入分组（§1.5 / §3.3）
// ============================================================

interface GroupCounts {
  user: number
  inherited: number
  delegations: number
  agentMessages: number
  injections: number
}

/**
 * 构建按 Agent 分组的输入投影。
 *
 * `groups` 只存 id 引用：输入条目上限 1 000 条 × 单条 4KB，最坏 4MB；
 * 内嵌条目对象会让载荷直接翻倍，而存 id 只增加 ~30B × 1000 = 30KB。
 * 顺序 = `agents` 徽标序（main 的 `order` 为 0），组内 `entryIds` 按时间升序。
 */
function buildInputGroups(
  userItems: readonly UserInputItem[],
  pluginItems: readonly PluginInjectItem[],
  agents: readonly AgentBadge[],
): AgentInputGroup[] {
  interface Draft { entryIds: string[]; counts: GroupCounts }
  const drafts = new Map<string, Draft>()
  const draftOf = (agentKey: string): Draft => {
    let draft = drafts.get(agentKey)
    if (draft === undefined) {
      draft = { entryIds: [], counts: { user: 0, inherited: 0, delegations: 0, agentMessages: 0, injections: 0 } }
      drafts.set(agentKey, draft)
    }
    return draft
  }
  // 跨会话合并后按时间归序，保证组内 entryIds 时间升序
  const ordered: Array<{ id: string; time: number; seq: number; agentKey: string; kind: 'user' | 'inject'; inputKind: UserInputKind | undefined }> = [
    ...userItems.map(item => ({ id: item.id, time: item.time, seq: item.seq, agentKey: item.agentKey, kind: 'user' as const, inputKind: item.inputKind })),
    ...pluginItems.map(item => ({ id: item.id, time: item.time, seq: item.seq, agentKey: item.agentKey, kind: 'inject' as const, inputKind: undefined })),
  ]
  ordered.sort((a, b) => a.time - b.time || a.seq - b.seq)
  for (const entry of ordered) {
    const draft = draftOf(entry.agentKey)
    draft.entryIds.push(entry.id)
    if (entry.kind === 'inject') draft.counts.injections += 1
    else if (entry.inputKind === 'delegation') draft.counts.delegations += 1
    else if (entry.inputKind === 'agent-message') draft.counts.agentMessages += 1
    else if (entry.inputKind === 'inherited') draft.counts.inherited += 1
    else draft.counts.user += 1
  }
  return agents.map((badge, index) => {
    const draft = drafts.get(badge.agentKey)
    return {
      agentKey: badge.agentKey,
      order: index,
      entryIds: draft?.entryIds ?? [],
      counts: draft?.counts ?? { user: 0, inherited: 0, delegations: 0, agentMessages: 0, injections: 0 },
    }
  })
}

/**
 * 构造父会话委派调用兜底条目（§1.5）。
 *
 * 仅在该子会话无明细（degraded / 未扫描）时生成，带 `provisional` 标记：
 * 它**不冒充**子会话自身的一手记录，UI 以次要样式呈现。
 */
function makeProvisionalDelegation(owningSessionId: string, childAgentKey: string, call: DelegationCall): UserInputItem {
  const truncated = truncateText(call.prompt)
  const item: UserInputItem = {
    id: makeEntryId(owningSessionId, call.seq),
    seq: call.seq,
    time: call.time,
    agentKey: childAgentKey,
    inputKind: 'delegation',
    text: truncated.text,
    textTruncated: truncated.truncated,
    attachments: [],
    provisional: true,
  }
  if (call.turn !== undefined) item.turn = call.turn
  return item
}

/**
 * 聚合一个会话（含其全部子会话）的三段上下文。
 * @throws 会话读取失败时原样抛出（api 层归一为 CTX_SESSION_NOT_FOUND）。
 */
export async function aggregateContext(engine: AggregatorEngine, sessionId: string, mainAgentName?: string): Promise<AggregateResult> {
  const main = await engine.readSession(sessionId)
  const trace = await engine.traceSession(sessionId)
  const childHeaders: AggregatorSessionHeader[] = []
  flattenDescendants(trace.descendants, childHeaders)
  const childrenTotal = childHeaders.length

  // 主会话扫描（无事件数上限；主会话永不 degraded，事件预算仅作用于子会话）
  const { scan: mainScan } = scanSession(main.events, 'main', main.session.cwd, false, sessionId)

  // 子会话并发扫描（预算内，并发池 4，失败隔离）
  const scanned = childHeaders.slice(0, MAX_CHILD_SESSIONS)
  const childScans: Array<{ header: AggregatorSessionHeader; scan: SessionScan | null; degraded: boolean }> = []
  let cursor = 0
  const worker = async(): Promise<void> => {
    while (cursor < scanned.length) {
      const index = cursor
      cursor += 1
      const header = scanned[index]
      if (header === undefined) return
      try {
        const log = await engine.readSession(header.id)
        const { scan, degraded } = scanSession(log.events, header.id, log.session.cwd, true, header.id)
        childScans[index] = { header, scan: degraded ? null : scan, degraded }
      } catch {
        // 会话级失败：降级为「仅徽标」（§7.3）
        childScans[index] = { header, scan: null, degraded: true }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHILD_SCAN_CONCURRENCY, scanned.length) }, worker))
  // 未扫描的子会话（超 MAX_CHILD_SESSIONS）：徽标照发，degraded
  for (const header of childHeaders.slice(MAX_CHILD_SESSIONS)) {
    childScans.push({ header, scan: null, degraded: true })
  }

  // —— 合并三段 ——
  const userItems: UserInputItem[] = [...mainScan.userItems]
  const pluginItems: PluginInjectItem[] = [...mainScan.pluginItems]
  let segments: OutputTextSegment[] = [...mainScan.segments]
  // id → 未截断全文。段带稳定 id，故两侧不再需要「配对排序」这种下标耦合
  // （v1.0 的 aggregator.ts:634-642 就是在守这条约束，id 化后该约束从代码里消失）。
  const fullTexts = new Map(mainScan.fullTexts)
  const refs = new Map(mainScan.refs)
  const outputs = new Map(mainScan.outputs)

  for (const child of childScans) {
    const scan = child.scan
    if (scan === null) {
      // 门控 1：仅当该子会话**无明细**时才用父侧委派调用兜底。
      // 子会话有明细时绝不用父侧 prompt 覆盖其一手记录。
      const fallback = mainScan.delegationsByChild.get(child.header.id)
      if (fallback !== undefined) {
        if (userItems.length + pluginItems.length >= MAX_INPUT_ITEMS) {
          mainScan.inputItemsCapped = true
        } else {
          userItems.push(makeProvisionalDelegation(sessionId, child.header.id, fallback))
        }
      }
      continue // degraded：仅徽标，无明细
    }
    userItems.push(...scan.userItems)
    pluginItems.push(...scan.pluginItems)
    segments.push(...scan.segments)
    for (const [id, full] of scan.fullTexts) fullTexts.set(id, full)
    for (const [path, view] of scan.refs) {
      const existing = refs.get(path)
      if (existing === undefined) {
        if (refs.size < MAX_REFERENCE_FILES) refs.set(path, view)
      } else {
        existing.count += view.count
        for (const agent of view.agents) {
          if (!existing.agents.includes(agent)) existing.agents.push(agent)
        }
      }
    }
    for (const [path, entry] of scan.outputs) {
      const existing = outputs.get(path)
      if (existing === undefined) {
        outputs.set(path, entry)
        continue
      }
      // 子会话操作时间在主会话之后，最终态取后写；agents 归集全部贡献者
      const agents = [...existing.agents]
      for (const agent of entry.agents) {
        if (!agents.includes(agent)) agents.push(agent)
      }
      outputs.set(path, { op: entry.op, agents })
    }
  }

  // 按时间归序（跨会话合并后恢复时间线）
  userItems.sort((a, b) => a.time - b.time || a.seq - b.seq)
  pluginItems.sort((a, b) => a.time - b.time || a.seq - b.seq)
  segments = [...segments].sort((a, b) => a.time - b.time || a.seq - b.seq)
  // round 重新编号（合并后 turn 可能重复）：按最终时间序重排 turn 首现序
  const roundMap = new Map<number, number>()
  for (const segment of segments) {
    let round = roundMap.get(segment.turn)
    if (round === undefined) {
      round = roundMap.size + 1
      roundMap.set(segment.turn, round)
    }
    segment.round = round
  }

  const refEntries = new Map<string, TreeEntry>()
  let totalViews = 0
  for (const [path, view] of refs) {
    refEntries.set(path, { viewCount: view.count, agents: view.agents })
    totalViews += view.count
  }
  const outputEntries = new Map<string, TreeEntry>()
  for (const [path, entry] of outputs) outputEntries.set(path, { outputOp: entry.op, agents: entry.agents })
  const injectEntries = new Map<string, TreeEntry>()
  for (const item of pluginItems) {
    for (const path of item.filePaths) {
      const existing = injectEntries.get(path)
      if (existing === undefined) {
        injectEntries.set(path, { agents: [item.agentKey] })
      } else if (!(existing.agents ?? []).includes(item.agentKey)) {
        // agents 是三棵树共用字段（§3.3）：注入树也须带上贡献者，
        // 否则 client 按 Agent 筛选时整棵注入树会被清空
        existing.agents = [...(existing.agents ?? []), item.agentKey]
      }
    }
  }

  // —— Agent 徽标（分组与最终答复投影都按此顺序，故须先于二者构建） ——
  // 命名方案（已与用户确认）：
  // - 主 Agent：有 preset 真名（mainAgentName，host 读 preset 文件解析）→ 真名（高见远）；
  //   否则 label 落 'main'，client 按 role 渲染 locale「主Agent」。hover = preset id。
  // - 子 Agent：team/member 有 name（developer）→ 内联短名，hover = 任务描述；
  //   非 Team 派生（无 name 参数）→ 一律「子Agent · sessionId 短码」，hover = 任务描述。
  //   注意非 Team 没有可用的「人名/短名」：`subagent/descriptor` 的 label 实测就是
  //   任务描述文本（详见循环内注释），只能作 hover，不能作展示名。
  // 主 Agent 的 hover：优先会话内最后选中的 preset，回退 header 默认值。
  // 直接用 header 会显示建会话时的 `standard`，与真名（如高见远）自相矛盾。
  const mainPresetId = mainScan.selectedPreset
    ?? (typeof main.session.agentPreset === 'string' ? main.session.agentPreset : undefined)
  const agents: AgentBadge[] = [{
    agentKey: 'main',
    sessionId: sessionId,
    label: mainAgentName ?? 'main',
    role: 'main',
    ...(mainAgentName !== undefined && mainPresetId !== undefined ? { title: mainPresetId } : {}),
  }]
  // 非 Team 子 Agent 统一打「子Agent · sessionId 短码」，收集后统一后缀
  const unnamedChildren: AgentBadge[] = []
  for (const child of childScans) {
    const member = mainScan.teamMembers.get(child.header.id)
    if (member !== undefined) {
      // Team 模式成员：内联短名（team 名，如 developer），hover = 任务描述
      const badge: AgentBadge = {
        agentKey: child.header.id,
        sessionId: child.header.id,
        label: member.name,
        role: 'subagent',
        ...(member.description !== undefined ? { title: member.description } : {}),
      }
      if (child.header.delegationDepth !== undefined) badge.delegationDepth = child.header.delegationDepth
      if (child.degraded) badge.degraded = true
      agents.push(badge)
      continue
    }

    // 非 Team 子 Agent：展示名一律「子Agent · sessionId 短码」。
    //
    // 关键：`subagent/descriptor` 的 `label` 实测等于派生时的 **description（任务描述文本）**，
    // 并不是人名/短名——拿它当名字就会出现「子 Agent 的名字是一句任务」的困惑
    // （同一 Agent 的团队名是 developer，而 descriptor.label 却是一整句任务描述）。
    // 故 descriptor.label 只作 hover 的任务描述，不进展示名。
    // hover 回落：descriptor.label → agentPreset → 无。
    const task = child.scan?.descriptorLabel
    const preset = child.header.agentPreset
    const hover = task !== undefined && task.length > 0
      ? task
      : (typeof preset === 'string' && preset.length > 0 ? preset : undefined)
    const badge: AgentBadge = {
      agentKey: child.header.id,
      sessionId: child.header.id,
      label: '子Agent',
      role: 'subagent',
      ...(hover !== undefined ? { title: hover } : {}),
    }
    if (child.header.delegationDepth !== undefined) badge.delegationDepth = child.header.delegationDepth
    if (child.degraded) badge.degraded = true
    agents.push(badge)
    unnamedChildren.push(badge)
  }
  // 同名子 Agent 消解（须在全部徽标构建完成后统一做：冲突是集合属性）
  disambiguateAgentLabels(agents)
  // 非 Team 子 Agent：无条件挂 sessionId 短码，格式「子Agent · a17c3f2b」
  for (const badge of unnamedChildren) {
    badge.label = `子Agent · ${uniqueIdPrefix(badge.sessionId, unnamedChildren)}`
  }

  // —— 最终答复判定（§1.2）：先标记 final，再施加全局段预算（final 段豁免） ——
  const { finalByAgent } = markFinalSegments(segments, agents)
  const globalBudget = applyGlobalSegmentBudget(segments)
  segments = globalBudget.segments
  applyPreviewTruncation(segments)
  // 过程段计数按**收口后**的集合重算，保证 processCount == textSegments 中 process 段数
  const processCount = recountProcess(segments, finalByAgent)

  // —— 输入分组（委派指令归收到它的子 Agent） ——
  const groups = buildInputGroups(userItems, pluginItems, agents)

  const droppedOutputSegments = mainScan.droppedSegments
    + childScans.reduce((total, child) => total + (child.scan?.droppedSegments ?? 0), 0)
    + globalBudget.dropped

  const budgets: PayloadBudgets = {
    // 语义窄化（§1.6）：纯「条目数超上限被丢弃」，**不再**包含「单条正文被 4KB 截断」——
    // 后者由 client 基于筛选后可见集合自身字段判定，否则选中单个 Agent 后横幅与视图不符。
    inputsTruncated: mainScan.inputItemsCapped || childScans.some(child => child.scan?.inputItemsCapped === true),
    referencesTruncated: refs.size >= MAX_REFERENCE_FILES,
    outputsTruncated: mainScan.outputSegmentsCapped
      || childScans.some(child => child.scan?.outputSegmentsCapped === true)
      || globalBudget.dropped > 0,
    droppedOutputSegments,
    childrenScanned: childScans.filter(child => child.scan !== null).length,
    childrenTotal,
  }

  // 只保留最终留下的段的全文：Map 与 textSegments 一一对应，无陈旧条目
  const outputFullTexts = new Map<string, string>()
  for (const segment of segments) outputFullTexts.set(segment.id, fullTexts.get(segment.id) ?? segment.text)

  return {
    aggregate: {
      sessionId,
      generatedAt: Date.now(),
      agents,
      inputs: {
        userItems,
        pluginItems,
        groups,
        injectTree: buildFileTree(injectEntries),
        totalItems: userItems.length + pluginItems.length,
      },
      references: {
        tree: buildFileTree(refEntries),
        totalFiles: refs.size,
        totalViews,
      },
      outputs: {
        textSegments: segments,
        finalByAgent,
        processCount,
        files: buildFileTree(outputEntries),
        totalFiles: outputs.size,
      },
      budgets,
    },
    outputFullTexts,
  }
}
