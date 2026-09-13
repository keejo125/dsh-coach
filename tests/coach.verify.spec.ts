/**
 * 复盘数据层 · 真实日志对拍验证（v0.2a）。
 *
 * 用基座仓库 deepseek-harness 的真实 session 日志（V3 快照）验证：
 * - scanCoachEvents 在真实事件流上不崩、确定性（两次扫描结果逐字段相等）；
 * - buildCoachReport 全字段可产出、数值落在合理范围；
 * - 与聚合器共享的事件解析口径（callId 双源、isError/error、meta.diffs）
 *   在真实数据上不产生 NaN / Infinity / 负数。
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { BASE_ROOT, BASE_AVAILABLE, loadSessionLog, makeRealEngine } from './real-log.verify.helper.ts'
import { scanCoachEvents } from '../src/host/coach/metrics.ts'
import { buildCoachReport } from '../src/host/coach/report.ts'

const SNAPSHOT_ROOT = join(BASE_ROOT, 'snapshots')

/** 真实日志样本：覆盖 文件读写/问答/图片 三类形态。 */
const SAMPLES = ['session/fs-delete-recreate', 'sdk/text-turn', 'sdk/inline-image-prompt'] as const

describe.skipIf(!BASE_AVAILABLE)('coach · 真实 V3 日志对拍', () => {
  const logs = SAMPLES.map(name => loadSessionLog(join(SNAPSHOT_ROOT, name, 'session.jsonl')))

  it('scanCoachEvents 确定性：两次扫描结果逐字段相等', () => {
    for (const log of logs) {
      const first = scanCoachEvents(log.events, '/snapshots/ws')
      const second = scanCoachEvents(log.events, '/snapshots/ws')
      expect(first).toEqual(second)
    }
  })

  it('scanCoachEvents 数值健康：全部有限、非负、互不越界', () => {
    for (const log of logs) {
      const { scope, signals, artifacts } = scanCoachEvents(log.events, '/snapshots/ws')
      for (const value of [...Object.values(scope), ...Object.values(signals)]) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
      // artifacts 含 files 数组（v0.2b 产物树）：数值字段单独校验，files 校验元素结构
      for (const value of Object.values(artifacts)) {
        if (Array.isArray(value)) {
          for (const file of value) {
            expect(Number.isFinite(file.opCount)).toBe(true)
            expect(file.opCount).toBeGreaterThanOrEqual(1)
            expect(file.op === 'create' || file.op === 'update').toBe(true)
            expect(typeof file.path).toBe('string')
          }
        } else {
          expect(Number.isFinite(value)).toBe(true)
          expect(value).toBeGreaterThanOrEqual(0)
        }
      }
      expect(scope.userTurns).toBeGreaterThanOrEqual(1) // 三份样本都有用户输入
      expect(scope.turns).toBeGreaterThanOrEqual(1)
      expect(signals.followUps).toBe(scope.userTurns - 1)
      expect(signals.correctionTurns).toBeLessThanOrEqual(signals.interventions)
      expect(artifacts.createdFiles + artifacts.updatedFiles).toBeLessThanOrEqual(Math.max(artifacts.writtenFiles, 1))
    }
  })

  it('buildCoachReport 全字段可产出，质量分在 0-100', async () => {
    const engine = makeRealEngine(logs)
    for (const log of logs) {
      const report = await buildCoachReport(engine, log.header.id)
      expect(report.sessionId).toBe(log.header.id)
      expect(report.generatedAt).toBeGreaterThan(0)
      expect(report.score.total).toBeGreaterThanOrEqual(0)
      expect(report.score.total).toBeLessThanOrEqual(100)
      expect(report.score.dimensions).toHaveLength(6)
      for (const dimension of report.score.dimensions) {
        expect(dimension.score).toBeGreaterThanOrEqual(0)
        expect(dimension.score).toBeLessThanOrEqual(100)
      }
      // 口径一致性：信号字段与 scope 的约束
      expect(report.signals.followUps).toBe(Math.max(0, report.scope.userTurns - 1))
      expect(report.artifacts.writtenFiles).toBeGreaterThanOrEqual(report.artifacts.createdFiles)
    }
  })
})
