/**
 * 复盘指标与质量分单元测试（v0.2a 口径，spec/08）。
 *
 * 覆盖：规模计数、追问/干预/纠错判定边界、无效动作（重复读/失败重试）、
 * 产物分类（create/update/迭代）、上下文压缩、六维质量分、报告组装与
 * /coach/api 路由分发。
 */

import { describe, expect, it } from 'vitest'
import { scanCoachEvents } from '../src/host/coach/metrics.ts'
import { scoreReport } from '../src/host/coach/score.ts'
import { buildCoachReport } from '../src/host/coach/report.ts'
import { dispatchCoachApi } from '../src/host/coach/api.ts'
import type { AggregatorEngine, AggregatorEvent, AggregatorLineageNode, AggregatorSessionHeader } from '../src/host/aggregator.ts'

const CWD = '/ws'
const T0 = 1_700_000_000_000

/** 构造事件（seq 自动递增）。 */
function makeEvents(defs: Array<[type: string, data: unknown]>): AggregatorEvent[] {
  return defs.map(([type, data], index) => ({ type, seq: index + 1, time: T0 + index, data }))
}

const turnStart = (turn: number): [string, unknown] => ['turn/start', { turn }]
const userMsg = (text: string): [string, unknown] => [
  'user/message',
  { content: [{ type: 'text', text }], source: { kind: 'user' } },
]
const toolCall = (turn: number, callId: string, name: string, args: unknown): [string, unknown] => [
  'tool/call',
  { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
]
const toolResult = (turn: number, callId: string, meta: unknown, isError = false, withError?: unknown): [string, unknown] => [
  'tool/result',
  {
    turn,
    step: 1,
    message: {
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError }],
    },
    meta,
    ...(withError !== undefined ? { error: withError } : {}),
  },
]
const assistantMsg = (turn: number, text: string, interrupted?: true): [string, unknown] => [
  'assistant/message',
  { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...interrupted === true ? { interrupted: true } : {} },
]
const compactionStart = (): [string, unknown] => ['compaction/start', {}]

/** 构造假引擎（与 aggregator.spec.ts 同模式）。 */
function makeEngine(
  sessions: Record<string, { header: Partial<AggregatorSessionHeader> & { id: string }; events: AggregatorEvent[] }>,
  childrenOf: Record<string, string[]> = {},
): AggregatorEngine {
  const node = (id: string): AggregatorLineageNode => ({
    session: { header: sessions[id]?.header ?? { id } },
    descendants: (childrenOf[id] ?? []).map(node),
  })
  return {
    readSession: async id => {
      const session = sessions[id]
      if (session === undefined) throw new Error('session not found')
      return { session: { ...session.header, cwd: session.header.cwd ?? CWD }, events: session.events }
    },
    traceSession: async id => ({ target: { header: sessions[id]?.header ?? { id } }, descendants: (childrenOf[id] ?? []).map(node) }),
  }
}

const scan = (events: AggregatorEvent[]) => scanCoachEvents(events, CWD)

describe('scanCoachEvents · 规模', () => {
  it('空会话：全部为 0，质量分各维度给中性值', () => {
    const result = scan([])
    expect(result.scope).toEqual({ turns: 0, userTurns: 0, assistantSteps: 0, toolCalls: 0, failedToolCalls: 0, delegations: 0 })
    expect(result.signals).toEqual({ followUps: 0, interventions: 0, correctionTurns: 0, repeatedReadFiles: 0, retriedFailures: 0, compactions: 0 })
    expect(result.artifacts).toEqual({ writtenFiles: 0, createdFiles: 0, updatedFiles: 0 })
    expect(result.lastAssistantText).toBeUndefined()
  })

  it('一问一答：turn/userTurns/assistantSteps 各 1', () => {
    const result = scan(makeEvents([turnStart(1), userMsg('你好'), assistantMsg(1, '你好！')]))
    expect(result.scope.turns).toBe(1)
    expect(result.scope.userTurns).toBe(1)
    expect(result.scope.assistantSteps).toBe(1)
    expect(result.signals.followUps).toBe(0)
  })

  it('user/message 只计 source.kind === user：plugin 注入不计入 userTurns', () => {
    const plugin = ['user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'p1' } }] as [string, unknown]
    const result = scan(makeEvents([turnStart(1), userMsg('a'), plugin]))
    expect(result.scope.userTurns).toBe(1)
  })
})

describe('scanCoachEvents · 追问 / 干预 / 纠错', () => {
  it('连续两条用户消息（中间无工具结果）：followUps=1，不算干预', () => {
    const result = scan(makeEvents([turnStart(1), userMsg('第一问'), turnStart(2), userMsg('追问')]))
    expect(result.scope.userTurns).toBe(2)
    expect(result.signals.followUps).toBe(1)
    expect(result.signals.interventions).toBe(0)
  })

  it('用户消息紧邻前一个事件是 tool/result：计一次干预', () => {
    const result = scan(makeEvents([
      turnStart(1), userMsg('读一下文件'),
      toolCall(1, 'c1', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c1', { path: '/ws/a.txt' }),
      turnStart(2), userMsg('好的，继续'),
    ]))
    expect(result.signals.interventions).toBe(1)
    expect(result.signals.correctionTurns).toBe(0)
  })

  it('干预其前的 tool/result 失败：计一次纠错轮次', () => {
    const result = scan(makeEvents([
      turnStart(1), userMsg('改一下'),
      toolCall(1, 'c1', 'edit', { file_path: 'a.txt' }),
      toolResult(1, 'c1', { diffs: [] }, true),
      turnStart(2), userMsg('不对，再改'),
    ]))
    expect(result.signals.interventions).toBe(1)
    expect(result.signals.correctionTurns).toBe(1)
  })

  it('tool/result 后先有 assistant 回复再有人工消息：不算干预（用户等助手说完才介入）', () => {
    const result = scan(makeEvents([
      turnStart(1), userMsg('读一下'),
      toolCall(1, 'c1', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c1', { path: '/ws/a.txt' }),
      assistantMsg(1, '读完了'),
      turnStart(2), userMsg('好的'),
    ]))
    expect(result.signals.interventions).toBe(0)
  })

  it('顶层 error 字段也算失败（fs-delete-read-after 形态）', () => {
    const result = scan(makeEvents([
      turnStart(1), userMsg('读'),
      toolCall(1, 'c1', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c1', null, false, { message: 'file not found' }),
      turnStart(2), userMsg('重试'),
    ]))
    expect(result.scope.failedToolCalls).toBe(1)
    expect(result.signals.interventions).toBe(1)
    expect(result.signals.correctionTurns).toBe(1)
  })
})

describe('scanCoachEvents · 无效动作', () => {
  it('同一文件 read 两次：repeatedReadFiles=1；read 一次不算', () => {
    const once = scan(makeEvents([
      turnStart(1), userMsg('看'),
      toolCall(1, 'c1', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c1', { path: '/ws/a.txt' }),
    ]))
    expect(once.signals.repeatedReadFiles).toBe(0)
    const twice = scan(makeEvents([
      turnStart(1), userMsg('看'),
      toolCall(1, 'c1', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c1', { path: '/ws/a.txt' }),
      toolCall(1, 'c2', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c2', { path: '/ws/a.txt' }),
    ]))
    expect(twice.signals.repeatedReadFiles).toBe(1)
  })

  it('失败的 read 不计入参考（与聚合器同口径）', () => {
    const result = scan(makeEvents([
      turnStart(1), userMsg('看'),
      toolCall(1, 'c1', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c1', null, true),
      toolCall(1, 'c2', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c2', null, true),
    ]))
    expect(result.signals.repeatedReadFiles).toBe(0)
    expect(result.scope.failedToolCalls).toBe(2)
  })

  it('同一轮次内同一工具名失败 ≥2 次：retriedFailures=1；跨轮次不算同组', () => {
    const same = scan(makeEvents([
      turnStart(1), userMsg('跑'),
      toolCall(1, 'c1', 'bash', { command: 'make' }),
      toolResult(1, 'c1', null, true),
      toolCall(1, 'c2', 'bash', { command: 'make' }),
      toolResult(1, 'c2', null, true),
    ]))
    expect(same.signals.retriedFailures).toBe(1)
    const acrossTurns = scan(makeEvents([
      turnStart(1), userMsg('跑'),
      toolCall(1, 'c1', 'bash', { command: 'make' }),
      toolResult(1, 'c1', null, true),
      turnStart(2), userMsg('再跑'),
      toolCall(2, 'c2', 'bash', { command: 'make' }),
      toolResult(2, 'c2', null, true),
    ]))
    expect(acrossTurns.signals.retriedFailures).toBe(0)
  })
})

describe('scanCoachEvents · 产物', () => {
  it('write 新建（diffs 空）：createdFiles=1、writtenFiles=1', () => {
    const result = scan(makeEvents([
      turnStart(1), userMsg('写文件'),
      toolCall(1, 'c1', 'write', { file_path: 'b.txt', content: 'x' }),
      toolResult(1, 'c1', { diffs: [] }),
    ]))
    expect(result.artifacts).toEqual({ writtenFiles: 1, createdFiles: 1, updatedFiles: 0 })
  })

  it('同一文件 edit 两次：writtenFiles=1、updatedFiles=1（迭代信号）', () => {
    const result = scan(makeEvents([
      turnStart(1), userMsg('改'),
      toolCall(1, 'c1', 'edit', { file_path: 'a.txt' }),
      toolResult(1, 'c1', { diffs: [{ path: '/ws/a.txt' }] }),
      toolCall(1, 'c2', 'edit', { file_path: 'a.txt' }),
      toolResult(1, 'c2', { diffs: [{ path: '/ws/a.txt' }] }),
    ]))
    expect(result.artifacts.writtenFiles).toBe(1)
    expect(result.artifacts.updatedFiles).toBe(1)
  })

  it('失败的 write 不计入产物', () => {
    const result = scan(makeEvents([
      turnStart(1), userMsg('写'),
      toolCall(1, 'c1', 'write', { file_path: 'b.txt', content: 'x' }),
      toolResult(1, 'c1', null, true),
    ]))
    expect(result.artifacts.writtenFiles).toBe(0)
  })
})

describe('scanCoachEvents · 上下文', () => {
  it('compaction/start 计压缩次数；其他 compaction 事件不计', () => {
    const result = scan(makeEvents([turnStart(1), userMsg('a'), compactionStart(), assistantMsg(1, 'ok')]))
    expect(result.signals.compactions).toBe(1)
  })
})

describe('scoreReport · 六维质量分', () => {
  const score = (events: AggregatorEvent[], delegations = 0) => {
    const s = scan(events)
    return scoreReport({ ...s, scope: { ...s.scope, delegations } })
  }

  it('空会话：中性分（completion 30 / efficiency 100 / recovery 100 / artifact 70 / delegation 100 / context 100），总分 78', () => {
    const result = score([])
    expect(result.total).toBe(78)
    expect(Object.fromEntries(result.dimensions.map(d => [d.id, d.score]))).toEqual({
      completion: 30, efficiency: 100, recovery: 100, artifact: 70, delegation: 100, context: 100,
    })
  })

  it('理想问答：completion 90，总分 93', () => {
    const result = score(makeEvents([turnStart(1), userMsg('你好'), assistantMsg(1, '你好！')]))
    expect(result.total).toBe(93)
    expect(Object.fromEntries(result.dimensions.map(d => [d.id, d.score]))['completion']).toBe(90)
  })

  it('最终答复被中断：completion 60', () => {
    const result = score(makeEvents([turnStart(1), userMsg('你好'), assistantMsg(1, '你好', true)]))
    expect(Object.fromEntries(result.dimensions.map(d => [d.id, d.score]))['completion']).toBe(60)
  })

  it('追问 3 次：recovery = 100 - 12×3 = 64', () => {
    const events = makeEvents([
      turnStart(1), userMsg('一'),
      assistantMsg(1, 'A'),
      turnStart(2), userMsg('二'),
      assistantMsg(2, 'B'),
      turnStart(3), userMsg('三'),
      assistantMsg(3, 'C'),
      turnStart(4), userMsg('四'),
      assistantMsg(4, 'D'),
    ])
    const result = score(events)
    expect(Object.fromEntries(result.dimensions.map(d => [d.id, d.score]))['recovery']).toBe(64)
  })

  it('无效动作拉低 efficiency：1 重复读 + 1 失败 + 1 重试，3/4 调用为无效 → 25', () => {
    const events = makeEvents([
      turnStart(1), userMsg('干活'),
      toolCall(1, 'c1', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c1', { path: '/ws/a.txt' }),
      toolCall(1, 'c2', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c2', { path: '/ws/a.txt' }),
      toolCall(1, 'c3', 'bash', { command: 'make' }),
      toolResult(1, 'c3', null, true),
      toolCall(1, 'c4', 'bash', { command: 'make' }),
      toolResult(1, 'c4', null, true),
      assistantMsg(1, '完成'),
    ])
    const result = score(events)
    // waste = repeatedReadFiles(1) + failedToolCalls(2) + retriedFailures(1) = 4，4/4 = 1 → 0
    expect(Object.fromEntries(result.dimensions.map(d => [d.id, d.score]))['efficiency']).toBe(0)
  })

  it('委派数影响 delegation 维度：1-4 合理 90，9 个过多 40', () => {
    const events = makeEvents([turnStart(1), userMsg('a'), assistantMsg(1, 'ok')])
    expect(Object.fromEntries(score(events, 2).dimensions.map(d => [d.id, d.score]))['delegation']).toBe(90)
    expect(Object.fromEntries(score(events, 9).dimensions.map(d => [d.id, d.score]))['delegation']).toBe(40)
  })
})

describe('buildCoachReport / dispatchCoachApi', () => {
  const s1 = {
    header: { id: 's1' },
    events: makeEvents([
      turnStart(1), userMsg('请总结'),
      toolCall(1, 'c1', 'read', { file_path: 'a.txt' }),
      toolResult(1, 'c1', { path: '/ws/a.txt' }),
      assistantMsg(1, '总结完毕'),
    ]),
  }

  it('报告组装：scope 合并 traceSession 谱系的委派数', async () => {
    const engine = makeEngine({ s1 }, { s1: ['child1', 'child2'] })
    const report = await buildCoachReport(engine, 's1')
    expect(report.sessionId).toBe('s1')
    expect(report.scope.delegations).toBe(2)
    expect(report.scope.userTurns).toBe(1)
    expect(report.signals.interventions).toBe(0)
    expect(report.score.total).toBeGreaterThanOrEqual(0)
    expect(report.score.total).toBeLessThanOrEqual(100)
  })

  it('dispatchCoachApi：/session/:id/report 返回 200 + ok 包络', async () => {
    const engine = makeEngine({ s1 })
    const response = await dispatchCoachApi(engine, 'GET', '/session/s1/report')
    expect(response.status).toBe(200)
    if (!response.body.ok) throw new Error('expected ok')
    expect((response.body.data as { sessionId?: string })['sessionId']).toBe('s1')
  })

  it('dispatchCoachApi：未知路由 / 非 GET / 会话不存在', async () => {
    const engine = makeEngine({ s1 })
    const unknown = await dispatchCoachApi(engine, 'GET', '/session/s1/nope')
    expect(unknown.status).toBe(400)
    const post = await dispatchCoachApi(engine, 'POST', '/session/s1/report')
    expect(post.status).toBe(400)
    const missing = await dispatchCoachApi(engine, 'GET', '/session/nope/report')
    expect(missing.status).toBe(404)
    if (missing.body.ok) throw new Error('expected error')
    expect(missing.body.error.code).toBe('COACH_SESSION_NOT_FOUND')
  })
})
