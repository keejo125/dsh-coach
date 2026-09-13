/**
 * 复盘报告组装：readSession 事件流 + traceSession 谱系 → CoachReport。
 *
 * - 会话不可得（readSession 抛数据层错误）时上抛 `CoachSessionUnavailableError`，
 *   由 /coach/api 分发层归一为 COACH_SESSION_NOT_FOUND；
 * - traceSession 失败不影响报告主体：委派数按 0 计（谱系是增强信息，非必需）。
 */

import type { CoachReport } from '../../shared/types.ts'
import type { AggregatorEngine } from '../aggregator.ts'
import { scanCoachEvents } from './metrics.ts'
import { scoreReport } from './score.ts'

export class CoachSessionUnavailableError extends Error {
  constructor() {
    super('session is unavailable')
    this.name = 'CoachSessionUnavailableError'
  }
}

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
  }
  return report
}
