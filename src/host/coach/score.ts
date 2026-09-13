/**
 * 质量分 v1：DSH 化六维加权，0-100。
 *
 * 设计原则（spec/08）：
 * - 全部确定性、可解释——每个维度一条独立规则，权重单源在本文件；
 * - v1 不用 LLM：分数只依赖事件流可计算的事实，便于单测与对拍；
 * - 中性偏上：无法评估时给中性分（如无文件产物 70），避免「无数据=低分」的误判。
 *
 * 维度（id / 权重 / 判据）：
 * - completion 0.25：有非空最终答复 90；被中断 60；无答复 30；
 * - efficiency 0.20：无效动作占比（重复读 + 失败 + 重试）/ 总调用；无调用时 100；
 * - recovery  0.20：纠错成本 = 追问 + 干预 + 纠错×2，每单位扣 12 分（下限 0）；
 * - artifact  0.15：有产物且迭代打磨（≥2 次修改）95；有产物未迭代 75；无产物 70；
 * - delegation 0.10：0 子会话 100；1-4 合理 90；5-8 偏多 70；>8 过多 40；
 * - context   0.10：无压缩 100；1 次 80；2 次 65；≥3 次 45。
 */

import type { CoachArtifacts, CoachDimensionId, CoachScope, CoachScore, CoachSignals } from '../../shared/types.ts'

/** 维度权重单源（总和 = 1）。 */
export const COACH_DIMENSION_WEIGHTS: ReadonlyArray<{ id: CoachDimensionId; weight: number }> = [
  { id: 'completion', weight: 0.25 },
  { id: 'efficiency', weight: 0.2 },
  { id: 'recovery', weight: 0.2 },
  { id: 'artifact', weight: 0.15 },
  { id: 'delegation', weight: 0.1 },
  { id: 'context', weight: 0.1 },
]

/** 计分输入：规模/信号/产物 + completion 所需的最后答复观测。 */
export interface CoachScoreInput {
  scope: CoachScope
  signals: CoachSignals
  artifacts: CoachArtifacts
  lastAssistantText: string | undefined
  lastAssistantInterrupted: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 计算质量分 v1（确定性、可解释）。 */
export function scoreReport(input: CoachScoreInput): CoachScore {
  const { scope, signals, artifacts } = input

  // completion：有没有把任务做完
  const completion = input.lastAssistantText === undefined
    ? 30
    : (input.lastAssistantInterrupted ? 60 : 90)

  // efficiency：无效动作占比越低越好
  const waste = signals.repeatedReadFiles + scope.failedToolCalls + signals.retriedFailures
  const efficiency = scope.toolCalls === 0
    ? 100
    : Math.round(100 * clamp(1 - waste / scope.toolCalls, 0, 1))

  // recovery：追问/干预/纠错都是「没一次做对」的成本
  const cost = signals.followUps + signals.interventions + signals.correctionTurns * 2
  const recovery = Math.max(0, 100 - 12 * cost)

  // artifact：产物健康——有、且被迭代打磨过最好
  const artifact = artifacts.writtenFiles === 0
    ? 70
    : (artifacts.updatedFiles > 0 ? 95 : 75)

  // delegation：委派数量适中
  const delegation = scope.delegations === 0
    ? 100
    : (scope.delegations <= 4 ? 90 : (scope.delegations <= 8 ? 70 : 40))

  // context：触发压缩越少越好
  const context = signals.compactions === 0
    ? 100
    : (signals.compactions === 1 ? 80 : (signals.compactions === 2 ? 65 : 45))

  const values: Record<CoachDimensionId, number> = { completion, efficiency, recovery, artifact, delegation, context }
  const total = COACH_DIMENSION_WEIGHTS.reduce((sum, { id, weight }) => sum + (values[id] ?? 0) * weight, 0)

  return {
    total: Math.round(total),
    dimensions: COACH_DIMENSION_WEIGHTS.map(({ id }) => ({ id, score: values[id] })),
  }
}
