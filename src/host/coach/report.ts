/**
 * 复盘报告组装：readSession 事件流 + traceSession 谱系 → CoachReport（v0.2b 扩展）。
 *
 * - 会话不可得（readSession 抛数据层错误）时上抛 `CoachSessionUnavailableError`，
 *   由 /coach/api 分发层归一为 COACH_SESSION_NOT_FOUND；
 * - traceSession 失败不影响报告主体：委派数按 0 计、子智能体为空（谱系是增强信息）；
 * - 子智能体明细：对每个直接子会话 readSession + scanCoachEvents 聚合（失败跳过）；
 * - 未使用引用判定：被读 ≥ 1 次、未出现在任何产物路径、最终答复未提及
 *   （文件名/路径末段子串匹配，宽松口径）。
 */

import type { CoachAgentSummary, CoachReferenceStats, CoachReport } from '../../shared/types.ts'
import type { AggregatorEngine, AggregatorLineageNode } from '../aggregator.ts'
import { scanCoachEvents } from './metrics.ts'
import { scoreReport } from './score.ts'

export class CoachSessionUnavailableError extends Error {
  constructor() {
    super('session is unavailable')
    this.name = 'CoachSessionUnavailableError'
  }
}

/** 参考 Top 条数。 */
const TOP_REFERENCES_LIMIT = 10

/** 对单个会话生成复盘报告（每次请求即时计算，host 无跨请求状态）。 */
export async function buildCoachReport(engine: AggregatorEngine, sessionId: string): Promise<CoachReport> {
  let log
  try {
    log = await engine.readSession(sessionId)
  } catch (error) {
    // 实现缺陷（TypeError 等）不属于「会话不可得」，原样上抛给 COACH_INTERNAL
    if (error instanceof Error && ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError'].includes(error.name)) {
      throw error
    }
    throw new CoachSessionUnavailableError()
  }

  const lineage = await engine.traceSession(sessionId).catch(() => undefined)
  const delegations = lineage?.descendants.length ?? 0

  const scan = scanCoachEvents(log.events, log.session.cwd)
  const scope = { ...scan.scope, delegations }

  const agents = lineage === undefined ? [] : await summarizeAgents(engine, lineage.descendants)
  const references = buildReferences(scan)
  const contextProfile = {
    userItems: scan.context.userItems,
    pluginItems: scan.context.pluginItems,
    delegations,
    injectFiles: scan.context.injectFiles,
    totalFiles: scan.refCounts.size,
    totalViews: [...scan.refCounts.values()].reduce((sum, count) => sum + count, 0),
    finalSegments: scan.context.finalSegments,
    processSegments: scan.context.processSegments,
  }

  const report: CoachReport = {
    sessionId,
    generatedAt: Date.now(),
    scope,
    signals: scan.signals,
    artifacts: scan.artifacts,
    score: scoreReport({
      scope,
      signals: scan.signals,
      artifacts: scan.artifacts,
      lastAssistantText: scan.lastAssistantText,
      lastAssistantInterrupted: scan.lastAssistantInterrupted,
    }),
    // ===== v0.2b =====
    agents,
    references,
    token: scan.token,
    contextProfile,
    timeline: { id: sessionId, rounds: scope.userTurns },
  }
  return report
}

/** 汇总直接子会话（各自 readSession + 扫描；读不到的跳过）。 */
async function summarizeAgents(
  engine: AggregatorEngine,
  descendants: readonly AggregatorLineageNode[],
): Promise<CoachAgentSummary[]> {
  const summaries: CoachAgentSummary[] = []
  for (const node of descendants) {
    const header = node.session?.header
    if (header === undefined) continue
    const childId = header.id
    let childLog
    try {
      childLog = await engine.readSession(childId)
    } catch {
      continue // 子会话不可读：跳过（增强信息，不阻断报告）
    }
    const childScan = scanCoachEvents(childLog.events, childLog.session.cwd)
    summaries.push({
      sessionId: childId,
      label: labelOf(header.agentPreset),
      role: 'subagent',
      userTurns: childScan.scope.userTurns,
      delegations: Math.max(0, childScan.scope.userTurns - 1),
      readFiles: childScan.refCounts.size,
      toolCalls: childScan.scope.toolCalls,
      failedToolCalls: childScan.scope.failedToolCalls,
      writtenFiles: childScan.artifacts.writtenFiles,
      hasFinalAnswer: childScan.lastAssistantText !== undefined,
    })
  }
  return summaries
}

/** 展示名：agentPreset 末段；缺失降级「子Agent」。 */
function labelOf(agentPreset: string | undefined): string {
  if (agentPreset === undefined || agentPreset.length === 0) return '子Agent'
  const last = agentPreset.split(/[\/:]/).pop()
  return last !== undefined && last.length > 0 ? last : '子Agent'
}

/** 引用统计：高频 Top + 未使用引用。 */
function buildReferences(
  scan: ReturnType<typeof scanCoachEvents>,
): CoachReferenceStats {
  const entries = [...scan.refCounts.entries()]
  const topReferences = entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_REFERENCES_LIMIT)
    .map(([path, views]) => ({ path, views }))

  const outputSet = new Set(scan.outputPaths)
  const finalText = scan.lastAssistantText ?? ''
  const unusedReferences = entries
    .filter(([path]) => !outputSet.has(path) && !mentionsPath(finalText, path))
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views)

  return {
    topReferences,
    unusedReferences,
    totalFiles: scan.refCounts.size,
    totalViews: [...scan.refCounts.values()].reduce((sum, count) => sum + count, 0),
  }
}

/** 最终答复是否提及该文件：文件名（末段）或规范化路径子串匹配（宽松）。 */
function mentionsPath(finalText: string, path: string): boolean {
  if (finalText.length === 0) return false
  if (finalText.includes(path)) return true
  const basename = path.split('/').pop()
  return basename !== undefined && basename.length > 0 && finalText.includes(basename)
}
