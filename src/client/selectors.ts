/**
 * 筛选后「可见集合」的唯一产出地（增量设计 §4.3）。
 *
 * 存在的理由：横幅、栏头计数、渲染三处必须基于**同一份**筛选结果。v1.0 里
 * ContextView 用 `budgets`（未筛选的全局事实）判定横幅、两个 Pane 各自
 * `filter` 一遍，选中单个 Agent 后横幅与视图必然不符。
 *
 * 约定：
 * - 全部为纯函数、无 React 依赖，可脱离 DOM 直接单测；
 * - 只做「筛选 + 解析 id」，**不重跑 host 的判定规则**——最终答复（`finalByAgent`）
 *   与输入分组（`groups`）都是 host 下发的投影，client 照单消费。
 */

import type {
  AgentFinalAnswer,
  AgentInputGroup,
  ContextAggregate,
  InputEntry,
  OutputTextSegment,
} from '../shared/types.ts'
import type { ContextLocaleKey } from './locales/zh-CN.ts'

/** 一条提示横幅：文案键 + 插值参数（由调用方用 `t` 渲染）。 */
export interface BannerItem {
  key: ContextLocaleKey
  params?: Record<string, string | number> | undefined
}

/** 分组 + 已解析条目的组合（供输入栏按 Agent 分块渲染）。 */
export interface ResolvedInputGroup {
  agentKey: string
  order: number
  counts: AgentInputGroup['counts']
  entries: InputEntry[]
}

/** 可见集合的截断判定结果（§1.6 的「可见类」横幅依据）。 */
export interface VisibleTruncation {
  /** 可见条目中存在单条正文被 4KB 截断。 */
  anyTextTruncated: boolean
}

/** 建 id → 条目索引。`groups` 只存 id 引用，解析在这里集中做一次。 */
function entryIndex(aggregate: ContextAggregate): Map<string, InputEntry> {
  const index = new Map<string, InputEntry>()
  for (const item of aggregate.inputs.userItems) index.set(item.id, { entryKind: 'user', item })
  for (const item of aggregate.inputs.pluginItems) index.set(item.id, { entryKind: 'inject', item })
  return index
}

/**
 * 按 Agent 分组的可见输入集合。
 *
 * 筛选语义是「过滤块」而非「过滤条目」：选中某 Agent 时只返回该 Agent 的块，
 * 与 §5.1 的 UI 结构一致。
 */
export function selectInputGroups(aggregate: ContextAggregate, selectedAgentKey: string | null): ResolvedInputGroup[] {
  const index = entryIndex(aggregate)
  const groups: ResolvedInputGroup[] = []
  for (const group of aggregate.inputs.groups) {
    if (selectedAgentKey !== null && group.agentKey !== selectedAgentKey) continue
    const entries: InputEntry[] = []
    for (const id of group.entryIds) {
      const entry = index.get(id)
      if (entry !== undefined) entries.push(entry)
    }
    groups.push({ agentKey: group.agentKey, order: group.order, counts: group.counts, entries })
  }
  return groups
}

/** 按分组顺序展平的可见输入条目（栏头计数与可见截断判定用）。 */
export function selectInputEntries(aggregate: ContextAggregate, selectedAgentKey: string | null): InputEntry[] {
  return selectInputGroups(aggregate, selectedAgentKey).flatMap(group => group.entries)
}

/**
 * 可见的最终答复（规则 F4：零非空文本的 Agent 不出现在文字区）。
 *
 * `finalByAgent` 里这类 Agent 以 `segment: null` 占位（host 侧保留，让 client
 * 能区分「无文字输出」与「Agent 不存在」），这里统一滤掉——文字区不凭空造答复。
 */
export function selectFinalAnswers(aggregate: ContextAggregate, selectedAgentKey: string | null): AgentFinalAnswer[] {
  return aggregate.outputs.finalByAgent.filter(entry =>
    entry.segment !== null && (selectedAgentKey === null || entry.agentKey === selectedAgentKey),
  )
}

/** 可见的最终答复段（与 `selectFinalAnswers` 同源，去掉包装便于计数与截断判定）。 */
export function selectFinalSegments(aggregate: ContextAggregate, selectedAgentKey: string | null): OutputTextSegment[] {
  return aggregate.outputs.textSegments.filter(segment =>
    segment.kind === 'final' && (selectedAgentKey === null || segment.agentKey === selectedAgentKey),
  )
}

/** 可见的过程段（受「显示过程输出」开关控制的那一批）。 */
export function selectProcessSegments(aggregate: ContextAggregate, selectedAgentKey: string | null): OutputTextSegment[] {
  return aggregate.outputs.textSegments.filter(segment =>
    segment.kind === 'process' && (selectedAgentKey === null || segment.agentKey === selectedAgentKey),
  )
}

/**
 * 基于**筛选后可见集合**重算的截断判定（§1.6 可见类横幅）。
 *
 * 只看 `textTruncated`（4KB 预算约束）。`previewOnly`（320B 预览裁剪）是产品决策、
 * 不是预算损失，**刻意不参与**——否则过程段一多，横幅会永远为真。
 */
export function selectVisibleTruncation(
  entries: readonly InputEntry[],
  segments: readonly OutputTextSegment[],
): VisibleTruncation {
  for (const entry of entries) {
    if (entry.item.textTruncated) return { anyTextTruncated: true }
  }
  for (const segment of segments) {
    if (segment.textTruncated) return { anyTextTruncated: true }
  }
  return { anyTextTruncated: false }
}

/**
 * 横幅两类分派的唯一决定处（§1.6 缺陷修复的核心）。
 *
 * - **全局类**（输入/参考/输出条目数超上限、子会话降级）是未筛选的全局事实，
 *   只在「全部 Agent」视图显示——否则选中单个 Agent 后，横幅说的仍是全集的事，
 *   与用户眼前的视图不符。
 * - **可见类**（单条正文被 4KB 截断）任何视图都显示，因为它描述的就是用户
 *   此刻看得见的东西，跟着筛选走才不会漏提示。
 */
export function selectBanners(
  aggregate: ContextAggregate,
  selectedAgentKey: string | null,
  truncation: VisibleTruncation,
): BannerItem[] {
  const banners: BannerItem[] = []
  const budgets = aggregate.budgets
  if (selectedAgentKey === null) {
    if (budgets.inputsTruncated) banners.push({ key: 'banner.truncated.inputs' })
    if (budgets.referencesTruncated) banners.push({ key: 'banner.truncated.references' })
    if (budgets.outputsTruncated) banners.push({ key: 'banner.truncated.outputs' })
    if (budgets.childrenTotal > budgets.childrenScanned) {
      banners.push({
        key: 'banner.truncated.children',
        params: { scanned: budgets.childrenScanned, total: budgets.childrenTotal },
      })
    }
  }
  if (truncation.anyTextTruncated) banners.push({ key: 'banner.truncated.text' })
  return banners
}
