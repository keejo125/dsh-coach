/**
 * 复盘报告 v0.2b 扩展测试（spec/09 §4）：
 * 子智能体汇总、引用分析（高频 Top + 未使用）、Token 投影、上下文构成、
 * timeline 索引与 /coach/api 的 timeline 路由分发。
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCoachReport, extractAgentTask } from '../src/host/coach/report.ts'
import { dispatchCoachApi } from '../src/host/coach/api.ts'
import type { AggregatorEngine, AggregatorEvent, AggregatorLineageNode, AggregatorSessionHeader } from '../src/host/aggregator.ts'

const CWD = '/ws'
const T0 = 1_700_000_000_000

function makeEvents(defs: Array<[type: string, data: unknown]>): AggregatorEvent[] {
  return defs.map(([type, data], index) => ({ type, seq: index + 1, time: T0 + index, data }))
}

const turnStart = (turn: number): [string, unknown] => ['turn/start', { turn }]
const userMsg = (text: string, kind: 'user' | 'plugin' = 'user'): [string, unknown] => [
  'user/message',
  kind === 'user'
    ? { content: [{ type: 'text', text }], source: { kind: 'user' } }
    : { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'coach', form: 'notice', summary: text } },
]
const toolCall = (turn: number, callId: string, name: string, args: unknown): [string, unknown] => [
  'tool/call',
  { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
]
const toolResult = (turn: number, callId: string, meta: unknown, isError = false): [string, unknown] => [
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
  },
]
const assistantMsg = (turn: number, text: string, usage?: Record<string, number>): [string, unknown] => [
  'assistant/message',
  { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...usage !== undefined ? { usage } : {} },
]

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

describe('report · 子智能体汇总', () => {
  it('每个直接子会话 readSession 聚合：规模/产物/最终答复', async () => {
    const engine = makeEngine(
      {
        main: {
          header: { id: 'main', cwd: CWD },
          events: makeEvents([turnStart(1), userMsg('委派任务'), assistantMsg(1, '完成')]),
        },
        child1: {
          header: { id: 'child1', agentPreset: 'dsh:code-review' },
          events: makeEvents([
            turnStart(1),
            userMsg('请评审 engine.ts'),
            toolCall(1, 'c1', 'read', { file_path: '/ws/engine.ts' }),
            toolResult(1, 'c1', { path: '/ws/engine.ts' }),
            assistantMsg(1, '评审完毕'),
          ]),
        },
        child2: {
          header: { id: 'child2', agentPreset: 'dsh:tester' },
          events: makeEvents([
            turnStart(1),
            userMsg('补测试'),
            toolCall(1, 'c1', 'write', { file_path: '/ws/engine.spec.ts' }),
            toolResult(1, 'c1', { diffs: [] }),
          ]),
        },
      },
      { main: ['child1', 'child2'] },
    )
    const report = await buildCoachReport(engine, 'main')
    expect(report.scope.delegations).toBe(2)
    expect(report.agents).toHaveLength(2)
    const reviewer = report.agents.find(a => a.label === 'code-review')
    expect(reviewer).toMatchObject({ readFiles: 1, toolCalls: 1, failedToolCalls: 0, hasFinalAnswer: true })
    const tester = report.agents.find(a => a.label === 'tester')
    expect(tester).toMatchObject({ writtenFiles: 1, hasFinalAnswer: false })
    // v0.2b 产物清单：子会话产物并入主清单（全 agent 视角，同 Context 输出树）
    expect(report.artifacts.writtenFiles).toBe(1)
    expect(report.artifacts.createdFiles).toBe(1)
    expect(report.artifacts.updatedFiles).toBe(0)
    expect(report.artifacts.files).toEqual([{ path: 'engine.spec.ts', op: 'create', opCount: 1 }])
    expect(tester?.files).toEqual([{ path: 'engine.spec.ts', op: 'create', opCount: 1 }])
  })

  it('产物合并：主会话与子会话同路径 → op 取 create 优先、opCount 相加', async () => {
    const engine = makeEngine(
      {
        main: {
          header: { id: 'main', cwd: CWD },
          events: makeEvents([
            turnStart(1),
            userMsg('写文件'),
            toolCall(1, 'c1', 'edit', { file_path: '/ws/app.ts' }),
            toolResult(1, 'c1', { diffs: [{ path: '/ws/app.ts' }] }),
          ]),
        },
        child1: {
          header: { id: 'child1', agentPreset: 'dsh:code' },
          events: makeEvents([
            turnStart(1),
            userMsg('创建文件'),
            toolCall(1, 'c1', 'write', { file_path: '/ws/app.ts' }),
            toolResult(1, 'c1', { diffs: [] }),
          ]),
        },
      },
      { main: ['child1'] },
    )
    const report = await buildCoachReport(engine, 'main')
    expect(report.artifacts.writtenFiles).toBe(1)
    expect(report.artifacts.files).toEqual([{ path: 'app.ts', op: 'create', opCount: 2 }])
    expect(report.artifacts.updatedFiles).toBe(1) // opCount 2 ≥ 2 → 迭代信号
  })

  it('子会话不可读时跳过（不阻断报告）', async () => {
    const engine = makeEngine(
      { main: { header: { id: 'main' }, events: makeEvents([userMsg('hi'), assistantMsg(1, 'ok')]) } },
      { main: ['missing-child'] },
    )
    const report = await buildCoachReport(engine, 'main')
    expect(report.agents).toHaveLength(0)
    expect(report.scope.delegations).toBe(1)
  })
})

describe('report · 引用分析', () => {
  it('高频 Top 按查看次数降序；被读未写且答复未提 → 未使用引用', async () => {
    const engine = makeEngine({
      main: {
        header: { id: 'main', cwd: CWD },
        events: makeEvents([
          turnStart(1),
          userMsg('重构'),
          toolCall(1, 'c1', 'read', { file_path: '/ws/engine.ts' }),
          toolResult(1, 'c1', { path: '/ws/engine.ts' }),
          toolCall(1, 'c2', 'read', { file_path: '/ws/engine.ts' }),
          toolResult(1, 'c2', { path: '/ws/engine.ts' }),
          toolCall(1, 'c3', 'read', { file_path: '/ws/old/legacy.ts' }),
          toolResult(1, 'c3', { path: '/ws/old/legacy.ts' }),
          toolCall(1, 'c4', 'write', { file_path: '/ws/engine.ts' }),
          toolResult(1, 'c4', { diffs: [{ path: '/ws/engine.ts' }] }),
          assistantMsg(1, 'engine.ts 已重构完成'),
        ]),
      },
    })
    const report = await buildCoachReport(engine, 'main')
    expect(report.references.topReferences[0]).toEqual({ path: 'engine.ts', views: 2 })
    expect(report.references.totalFiles).toBe(2)
    expect(report.references.totalViews).toBe(3)
    // legacy.ts：被读 1 次、未写入、答复未提及 → 未使用
    expect(report.references.unusedReferences).toEqual([{ path: 'old/legacy.ts', views: 1 }])
  })

  it('最终答复提及文件名 → 不算未使用', async () => {
    const engine = makeEngine({
      main: {
        header: { id: 'main', cwd: CWD },
        events: makeEvents([
          userMsg('看看这个文件'),
          toolCall(1, 'c1', 'read', { file_path: '/ws/docs/spec.md' }),
          toolResult(1, 'c1', { path: '/ws/docs/spec.md' }),
          assistantMsg(1, 'spec.md 的内容是……'),
        ]),
      },
    })
    const report = await buildCoachReport(engine, 'main')
    expect(report.references.unusedReferences).toEqual([])
  })
})

describe('report · Token 投影与上下文构成', () => {
  it('assistant usage 扫描：总量/增量/缓存/按轮', async () => {
    const engine = makeEngine({
      main: {
        header: { id: 'main', cwd: CWD },
        events: makeEvents([
          turnStart(1),
          userMsg('任务'),
          assistantMsg(1, '第一答', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, totalTokens: 950 }),
          turnStart(2),
          userMsg('追问'),
          assistantMsg(2, '第二答', { inputTokens: 20, outputTokens: 10, cacheReadTokens: 900, totalTokens: 930 }),
        ]),
      },
    })
    const report = await buildCoachReport(engine, 'main')
    expect(report.token).not.toBeNull()
    expect(report.token?.total).toBe(930)
    expect(report.token?.input).toBe(120)
    expect(report.token?.output).toBe(60)
    expect(report.token?.cache).toBe(900)
    expect(report.token?.perTurn).toHaveLength(2)
    expect(report.token?.perTurn[0]).toEqual({ turn: 1, input: 100, output: 50, total: 950, text: '任务' })
  })

  it('无 usage 数据 → token 为 null（UI 降级）', async () => {
    const engine = makeEngine({
      main: { header: { id: 'main' }, events: makeEvents([userMsg('hi'), assistantMsg(1, 'ok')]) },
    })
    const report = await buildCoachReport(engine, 'main')
    expect(report.token).toBeNull()
  })

  it('上下文构成：用户/注入条数、注入文件、段计数', async () => {
    const engine = makeEngine({
      main: {
        header: { id: 'main', cwd: CWD },
        events: makeEvents([
          userMsg('系统规则', 'plugin'),
          userMsg('真正的任务'),
          assistantMsg(1, '过程答复'),
          assistantMsg(1, '最终答复'),
        ]),
      },
    })
    const report = await buildCoachReport(engine, 'main')
    expect(report.contextProfile).toMatchObject({
      userItems: 1,
      pluginItems: 1,
      finalSegments: 1,
      processSegments: 1,
    })
    expect(report.timeline).toEqual({ id: 'main', rounds: 1 })
  })
})

describe('dispatchCoachApi · timeline 路由', () => {
  it('GET /session/main/timeline → 200 + 逐轮明细', async () => {
    const engine = makeEngine({
      main: {
        header: { id: 'main', cwd: CWD },
        events: makeEvents([
          userMsg('任务'),
          toolCall(1, 'c1', 'write', { file_path: '/ws/a.ts' }),
          toolResult(1, 'c1', { diffs: [] }),
          assistantMsg(1, '完成'),
        ]),
      },
    })
    const response = await dispatchCoachApi(engine, 'GET', '/session/main/timeline')
    expect(response.status).toBe(200)
    if (!response.body.ok) throw new Error('expected ok')
    expect(response.body.data).toMatchObject({
      sessionId: 'main',
      rounds: [{ kind: 'initial', userText: '任务', artifacts: [{ path: 'a.ts', op: 'create', opCount: 1 }] }],
    })
  })

  it('未知路由 → 400；会话不可得 → 404', async () => {
    const engine = makeEngine({})
    expect((await dispatchCoachApi(engine, 'GET', '/session/x/unknown')).status).toBe(400)
    expect((await dispatchCoachApi(engine, 'GET', '/session/missing/report')).status).toBe(404)
  })
})

describe('file 端点与任务缩写（v0.2b+）', () => {
  it('GET /session/:id/file：读工作区文件正文；路径穿越被拒', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-coach-file-'))
    writeFileSync(join(root, 'a.txt'), 'hello coach')
    const engine = makeEngine({ main: { header: { id: 'main', cwd: root }, events: [] } })
    const okRes = await dispatchCoachApi(engine, 'GET', '/session/main/file', new URLSearchParams({ path: 'a.txt' }))
    expect(okRes.status).toBe(200)
    if (!okRes.body.ok) throw new Error('expected ok')
    expect(okRes.body.data).toMatchObject({ path: 'a.txt', text: 'hello coach', truncated: false })
    // 路径穿越与绝对路径拒绝
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b.txt']) {
      const res = await dispatchCoachApi(engine, 'GET', '/session/main/file', new URLSearchParams({ path: bad }))
      expect(res.status).toBe(400)
    }
  })

  it('extractAgentTask：descriptor 优先，否则首个用户消息，单行截断', () => {
    const fromUser = extractAgentTask(makeEvents([
      userMsg('修复登录模块的竞态问题，并补充单元测试', 'user'),
      userMsg('系统注入', 'plugin'),
    ]))
    expect(fromUser).toBe('修复登录模块的竞态问题，并补充单元测试')
    const fromDescriptor = extractAgentTask(makeEvents([
      ['subagent/descriptor', { description: '  评估 ui-greeting 包完整性  ' }],
      userMsg('旧指令', 'user'),
    ]))
    expect(fromDescriptor).toBe('评估 ui-greeting 包完整性')
    const long = extractAgentTask(makeEvents([userMsg('A'.repeat(60), 'user')]))
    expect(long).toMatch(/^A{39}…$/)
    expect(extractAgentTask(makeEvents([]))).toBeNull()
  })
})
