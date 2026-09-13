/**
 * D. 降级与边界（QA 独立验证）。
 *
 * 逐条踩 §7.4 预算表的等号边界，并验证降级后「徽标仍在、明细丢弃」的口径。
 */

import { describe, expect, it } from 'vitest'
import { aggregateContext } from '../src/host/aggregator.ts'
import { dispatchCtxApi } from '../src/host/api.ts'
import {
  MAX_CHILD_EVENTS,
  MAX_CHILD_SESSIONS,
  MAX_INPUT_ITEMS,
  MAX_OUTPUT_SEGMENTS,
  MAX_REFERENCE_FILES,
  TEXT_TRUNCATE_BYTES,
} from '../src/shared/constants.ts'
import type { AggregatorEngine, AggregatorEvent } from '../src/host/aggregator.ts'
import type { FileTreeNode } from '../src/shared/types.ts'

let clock = 0
function event(type: string, data: unknown): AggregatorEvent {
  clock += 1
  return { type, seq: clock, time: 1_700_000_000_000 + clock, data }
}

const say = (turn: number, text: string): AggregatorEvent =>
  event('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })

const ask = (text: string): AggregatorEvent =>
  event('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })

/** read 工具调用 + 成功结果（成对，才会计入参考）。 */
function readPair(callId: string, path: string): AggregatorEvent[] {
  return [
    event('tool/call', { callId, name: 'read', arguments: JSON.stringify({ file_path: path }) }),
    event('tool/result', {
      message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', isError: false, content: [] }] },
      meta: { path },
    }),
  ]
}

/** 构造引擎：主会话 + 若干子会话，子会话事件数可指定。 */
function engineWithChildren(childCount: number, childEvents: (index: number) => AggregatorEvent[]): AggregatorEngine {
  const logs = new Map<string, AggregatorEvent[]>()
  logs.set('main-session', [...readPair('main-read', 'shared.txt'), say(1, 'main output')])
  const children = Array.from({ length: childCount }, (_, index) => {
    const id = `child-${String(index).padStart(3, '0')}`
    logs.set(id, childEvents(index))
    return id
  })
  return {
    readSession: async id => {
      const events = logs.get(id)
      if (events === undefined) throw new Error(`no such session: ${id}`)
      return { session: { id, cwd: '/ws' }, events }
    },
    traceSession: async id => ({
      target: { header: { id, cwd: '/ws' } },
      descendants: children.map(childId => ({
        session: { header: { id: childId, cwd: '/ws', parentSession: id, delegationDepth: 1 } },
        descendants: [],
      })),
    }),
  }
}

function findFile(nodes: readonly FileTreeNode[], path: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.type === 'file' && node.path === path) return node
    if (node.type === 'dir') {
      const hit = findFile(node.children ?? [], path)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

describe('D1 · 子会话数预算（MAX_CHILD_SESSIONS = 32）', () => {
  it('恰好 32 个子会话：全部扫描，无降级', async () => {
    const engine = engineWithChildren(MAX_CHILD_SESSIONS, index => [
      ask(`child-${String(index)} question`),
      say(1, `child-${String(index)} answer`),
    ])
    const { aggregate } = await aggregateContext(engine, 'main-session')

    expect(aggregate.budgets).toMatchObject({ childrenTotal: 32, childrenScanned: 32 })
    expect(aggregate.agents.filter(badge => badge.degraded === true)).toHaveLength(0)
    // 主会话无 user/message，每个子会话各 1 条
    expect(aggregate.inputs.userItems).toHaveLength(32)
  })

  it('33 个子会话：前 32 个有明细，第 33 个 degraded（仅徽标）', async () => {
    const engine = engineWithChildren(33, index => [say(1, `child-${String(index)} answer`)])
    const { aggregate } = await aggregateContext(engine, 'main-session')

    expect(aggregate.budgets).toMatchObject({ childrenTotal: 33, childrenScanned: 32 })
    expect(aggregate.agents).toHaveLength(34)
    const degraded = aggregate.agents.filter(badge => badge.degraded === true)
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.agentKey).toBe('child-032')
    // 降级子会话的输出不进主载荷：主 1 段 + 前 32 个子会话各 1 段
    expect(aggregate.outputs.textSegments).toHaveLength(33)
    expect(aggregate.outputs.textSegments.some(segment => segment.agentKey === 'child-032')).toBe(false)
  })

  it('40 个子会话：childrenScanned 停在 32，8 个徽标 degraded', async () => {
    const engine = engineWithChildren(40, () => [])
    const { aggregate } = await aggregateContext(engine, 'main-session')
    expect(aggregate.budgets).toMatchObject({ childrenTotal: 40, childrenScanned: 32 })
    expect(aggregate.agents.filter(badge => badge.degraded === true)).toHaveLength(8)
  })

  it('降级子会话与非降级同规则：一律「子Agent · sessionId 短码」，hover 回落 agentPreset', async () => {
    // 34 个子会话 → 最后两个（child-032 / child-033）降级
    const engine = engineWithChildren(34, () => [])
    // 覆写 child-032 的 header：给 agentPreset
    const base = engine.traceSession
    const patched: AggregatorEngine = {
      readSession: engine.readSession,
      traceSession: async id => {
        const trace = await base(id)
        return {
          target: trace.target,
          descendants: trace.descendants.map(node =>
            node.session.header.id === 'child-032'
              ? { ...node, session: { header: { ...node.session.header, agentPreset: 'reviewer' } } }
              : node),
        }
      },
    }
    const { aggregate } = await aggregateContext(patched, 'main-session')
    const degraded = aggregate.agents.find(badge => badge.agentKey === 'child-032')
    // 明细被丢弃，descriptor.label 拿不到 → hover 回落 agentPreset；展示名仍是「子Agent · 短码」
    expect(degraded).toMatchObject({ label: '子Agent · child-032', title: 'reviewer', degraded: true })
    expect(aggregate.budgets).toMatchObject({ childrenTotal: 34, childrenScanned: 32 })
    // 降级与非降级同一规则：一律「子Agent · sessionId 短码」。
    // 34 条 id 在各自十位段内前 8 位撞车（child-00… / child-03…），故统一放宽到 9 位。
    const other = aggregate.agents.find(badge => badge.agentKey === 'child-033')
    expect(other?.label).toBe('子Agent · child-033')
    expect(aggregate.agents.find(badge => badge.agentKey === 'child-030')?.label).toBe('子Agent · child-030')
    expect(aggregate.agents.find(badge => badge.agentKey === 'child-031')?.label).toBe('子Agent · child-031')
    expect(degraded?.label).toBe('子Agent · child-032')
    // 全量去重校验：没有任何两个 Agent 共用同一个展示标签
    const labels = aggregate.agents.map(badge => badge.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('D2 · 单子会话事件预算（MAX_CHILD_EVENTS = 20000）', () => {
  it(`恰好 ${MAX_CHILD_EVENTS} 个事件：不降级`, async () => {
    const engine = engineWithChildren(1, () => [
      ...Array.from({ length: MAX_CHILD_EVENTS - 1 }, (_, i) => event('step/start', { turn: i, step: 1 })),
      say(1, 'child output'),
    ])
    const { aggregate } = await aggregateContext(engine, 'main-session')
    expect(aggregate.budgets.childrenScanned).toBe(1)
    expect(aggregate.agents[1]?.degraded).toBeUndefined()
    expect(aggregate.outputs.textSegments.some(segment => segment.agentKey === 'child-000')).toBe(true)
  })

  it(`${MAX_CHILD_EVENTS + 1} 个事件：该子会话整体降级（明细全丢，不只是截断）`, async () => {
    const engine = engineWithChildren(1, () => [
      say(1, 'child output'),
      ...Array.from({ length: MAX_CHILD_EVENTS }, (_, i) => event('step/start', { turn: i, step: 1 })),
    ])
    const { aggregate } = await aggregateContext(engine, 'main-session')
    expect(aggregate.budgets).toMatchObject({ childrenTotal: 1, childrenScanned: 0 })
    expect(aggregate.agents[1]).toMatchObject({ agentKey: 'child-000', degraded: true })
    // 已扫到的那一条输出也不保留：降级是整会话丢弃，不是部分截断
    expect(aggregate.outputs.textSegments.some(segment => segment.agentKey === 'child-000')).toBe(false)
  })

  it('主会话事件数不受该预算限制（主会话永不 degraded）', async () => {
    const events = [
      ...Array.from({ length: MAX_CHILD_EVENTS + 500 }, (_, i) => event('step/start', { turn: i, step: 1 })),
      say(1, 'late main output'),
    ]
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 'main-session')
    expect(aggregate.agents).toHaveLength(1)
    expect(aggregate.agents[0]?.degraded).toBeUndefined()
    expect(aggregate.outputs.textSegments).toHaveLength(1)
  })
})

describe('D3 · 载荷预算：参考 / 输出 / 输入', () => {
  it(`参考文件数达 ${MAX_REFERENCE_FILES}：置 referencesTruncated，超出部分不再计入`, async () => {
    const events = Array.from({ length: MAX_REFERENCE_FILES + 10 }, (_, index) =>
      readPair(`call-${String(index)}`, `dir/f-${String(index).padStart(5, '0')}.txt`),
    ).flat()
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 'main-session')
    expect(aggregate.references.totalFiles).toBe(MAX_REFERENCE_FILES)
    expect(aggregate.budgets.referencesTruncated).toBe(true)
    expect(findFile(aggregate.references.tree, `dir/f-${String(MAX_REFERENCE_FILES).padStart(5, '0')}.txt`)).toBeUndefined()
  })

  it(`输出段达 ${MAX_OUTPUT_SEGMENTS}：置 outputsTruncated，超出丢弃`, async () => {
    const events = Array.from({ length: MAX_OUTPUT_SEGMENTS + 5 }, (_, index) => say(index + 1, `seg-${String(index)}`))
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 'main-session')
    expect(aggregate.outputs.textSegments).toHaveLength(MAX_OUTPUT_SEGMENTS)
    expect(aggregate.budgets.outputsTruncated).toBe(true)
    expect(aggregate.budgets.droppedOutputSegments).toBe(5)
    // 段预算淘汰方向是「保留最新」（§1.2 F6）：被丢的应是最早的 5 段，
    // 末段仍是最后说出的那一段——否则最终答复判定会在超长会话上失效
    expect(aggregate.outputs.textSegments[0]?.text).toBe('seg-5')
    expect(aggregate.outputs.textSegments.at(-1)?.text).toBe(`seg-${String(MAX_OUTPUT_SEGMENTS + 4)}`)
  })

  it(`输入条目达 ${MAX_INPUT_ITEMS}：置 inputsTruncated，超出丢弃`, async () => {
    const events = Array.from({ length: MAX_INPUT_ITEMS + 5 }, (_, index) => ask(`q-${String(index)}`))
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 'main-session')
    expect(aggregate.inputs.userItems).toHaveLength(MAX_INPUT_ITEMS)
    expect(aggregate.budgets.inputsTruncated).toBe(true)
  })
})

describe('D4 · 单条文本预算与全文侧信道', () => {
  it(`单段文本超过 ${TEXT_TRUNCATE_BYTES} 字符被截断，output-text 端点给全文`, async () => {
    const long = 'a'.repeat(TEXT_TRUNCATE_BYTES) + 'TAIL-MARKER'
    // 事件数组必须**先固化**：会话日志是 append-only、seq 不重写，
    // 段 id 才能在多次聚合之间恒定（若每次 readSession 都重建事件，seq 就会漂移）
    const events = [say(1, long)]
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 'main-session')
    const segment = aggregate.outputs.textSegments[0]
    expect(segment?.textTruncated).toBe(true)
    expect(segment?.text).toHaveLength(TEXT_TRUNCATE_BYTES)
    expect(segment?.text).not.toContain('TAIL-MARKER')
    // 语义窄化（§1.6）：outputsTruncated 只表达「段数超预算被丢弃」，
    // 本例只有 1 段、没超段预算 → 必须为 false；「单条正文被截断」由 client
    // 基于筛选后可见集合的 textTruncated 判定（信号仍在，见下一行断言）
    expect(aggregate.budgets.outputsTruncated).toBe(false)
    expect(aggregate.budgets.droppedOutputSegments).toBe(0)
    expect(segment?.textTruncated).toBe(true)
    // 本例没有输入条目超限，inputsTruncated 不应被误置
    expect(aggregate.budgets.inputsTruncated).toBe(false)

    // 端点按 id 取全文（?id= 为首选路径）
    const response = await dispatchCtxApi(engine, 'GET', '/session/main-session/output-text', new URLSearchParams(`id=${encodeURIComponent(segment?.id ?? '')}`))
    expect(response).toMatchObject({ status: 200, body: { ok: true, data: { text: long } } })
    // deprecated 的 ?index= 仍返回同一段全文
    const byIndex = await dispatchCtxApi(engine, 'GET', '/session/main-session/output-text', new URLSearchParams('index=0'))
    expect(byIndex).toMatchObject({ status: 200, body: { ok: true, data: { index: 0, text: long } } })
  })

  it('恰好等于阈值不截断（边界等号）', async () => {
    const exact = 'b'.repeat(TEXT_TRUNCATE_BYTES)
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events: [say(1, exact), ask(exact)] }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 'main-session')
    expect(aggregate.outputs.textSegments[0]?.textTruncated).toBe(false)
    expect(aggregate.inputs.userItems[0]?.textTruncated).toBe(false)
    expect(aggregate.budgets.inputsTruncated).toBe(false)
  })
})

describe('D7 · 跨会话合并后 segments 与全文侧信道的下标对齐', () => {
  it('子会话输出在时间上插在主会话两条输出之间时，output-text 取到的仍是该段的全文', async () => {
    // 主会话：t=1000「main-first」、t=3000「main-second」
    // 子会话：t=2000「child-middle」→ 合并后时间序为 main-first / child-middle / main-second
    const mainEvents: AggregatorEvent[] = [
      { type: 'assistant/message', seq: 1, time: 1000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'MAIN-FIRST' }] } } },
      { type: 'assistant/message', seq: 2, time: 3000, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'MAIN-SECOND' }] } } },
    ]
    const childEvents: AggregatorEvent[] = [
      { type: 'assistant/message', seq: 1, time: 2000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'CHILD-MIDDLE' }] } } },
    ]
    const engine: AggregatorEngine = {
      readSession: async id => ({
        session: { id, cwd: '/ws' },
        events: id === 'child' ? childEvents : mainEvents,
      }),
      traceSession: async id => ({
        target: { header: { id, cwd: '/ws' } },
        descendants: [{ session: { header: { id: 'child', cwd: '/ws', parentSession: id } }, descendants: [] }],
      }),
    }

    const { aggregate, outputFullTexts } = await aggregateContext(engine, 'main')
    expect(aggregate.outputs.textSegments.map(segment => segment.text)).toEqual(['MAIN-FIRST', 'CHILD-MIDDLE', 'MAIN-SECOND'])
    // id 一一对应：任一段按自己的 id 取到的全文都必须是它自己的
    expect(outputFullTexts.size).toBe(aggregate.outputs.textSegments.length)
    for (const segment of aggregate.outputs.textSegments) {
      expect(outputFullTexts.get(segment.id), `id=${segment.id}`).toBe(segment.text)
    }
    // 端点侧同样按 id 命中，且 index 诊断字段与时间序一致
    for (const [index, expected] of ['MAIN-FIRST', 'CHILD-MIDDLE', 'MAIN-SECOND'].entries()) {
      const segment = aggregate.outputs.textSegments[index]
      const response = await dispatchCtxApi(engine, 'GET', '/session/main/output-text', new URLSearchParams(`id=${encodeURIComponent(segment?.id ?? '')}`))
      expect(response, `index=${index}`).toMatchObject({ status: 200, body: { ok: true, data: { index, text: expected } } })
    }
  })

  it('截断场景下 output-text 给全文、聚合载荷给 4KB 截断副本，且下标仍对齐', async () => {
    const long = 'z'.repeat(6000)
    const mainEvents: AggregatorEvent[] = [
      { type: 'assistant/message', seq: 1, time: 1000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'SHORT-MAIN' }] } } },
      { type: 'assistant/message', seq: 2, time: 3000, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: long }] } } },
    ]
    const childEvents: AggregatorEvent[] = [
      { type: 'assistant/message', seq: 1, time: 2000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'CHILD-MIDDLE' }] } } },
    ]
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events: id === 'child' ? childEvents : mainEvents }),
      traceSession: async id => ({
        target: { header: { id, cwd: '/ws' } },
        descendants: [{ session: { header: { id: 'child', cwd: '/ws', parentSession: id } }, descendants: [] }],
      }),
    }
    const { aggregate } = await aggregateContext(engine, 'main')
    const last = aggregate.outputs.textSegments[2]
    expect(last?.textTruncated).toBe(true)
    const response = await dispatchCtxApi(engine, 'GET', '/session/main/output-text', new URLSearchParams(`id=${encodeURIComponent(last?.id ?? '')}`))
    expect(response).toMatchObject({ status: 200, body: { ok: true, data: { index: 2, text: long } } })
    const firstId = aggregate.outputs.textSegments[0]?.id ?? ''
    const first = await dispatchCtxApi(engine, 'GET', '/session/main/output-text', new URLSearchParams(`id=${encodeURIComponent(firstId)}`))
    expect(first).toMatchObject({ status: 200, body: { ok: true, data: { index: 0, text: 'SHORT-MAIN' } } })
  })
})

describe('D5 · 空会话与无工具调用会话', () => {
  it('空事件流：三段皆空，仅主徽标，不报错', async () => {
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events: [] }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.inputs.userItems).toEqual([])
    expect(aggregate.inputs.pluginItems).toEqual([])
    expect(aggregate.inputs.groups).toEqual([
      { agentKey: 'main', order: 0, entryIds: [], counts: { user: 0, inherited: 0, delegations: 0, agentMessages: 0, injections: 0 } },
    ])
    expect(aggregate.inputs.totalItems).toBe(0)
    expect(aggregate.references).toEqual({ tree: [], totalFiles: 0, totalViews: 0 })
    expect(aggregate.outputs).toEqual({
      textSegments: [],
      finalByAgent: [{ agentKey: 'main', segment: null, processCount: 0 }],
      processCount: 0,
      files: [],
      totalFiles: 0,
    })
    expect(aggregate.agents).toHaveLength(1)
    expect(aggregate.budgets).toMatchObject({
      inputsTruncated: false,
      referencesTruncated: false,
      outputsTruncated: false,
      droppedOutputSegments: 0,
      childrenScanned: 0,
      childrenTotal: 0,
    })
  })

  it('有对话但无工具调用：参考/输出文件树为空', async () => {
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events: [ask('hello'), say(1, 'hi')] }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.inputs.userItems).toHaveLength(1)
    expect(aggregate.references.totalFiles).toBe(0)
    expect(aggregate.outputs.files).toEqual([])
    expect(aggregate.outputs.textSegments).toHaveLength(1)
  })

  it('header 缺 cwd：绝对路径无法相对化 → 参考整条丢弃（宁缺勿错）', async () => {
    const events = readPair('c1', '/abs/path/file.txt')
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id }, events }),
      traceSession: async id => ({ target: { header: { id } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.references.totalFiles).toBe(0)
  })
})

describe('D6 · 脏数据鲁棒性', () => {
  it('JSON 解析失败 / 事件缺字段 / 未知工具名 均不中断聚合', async () => {
    const engine: AggregatorEngine = {
      readSession: async id => ({
        session: { id, cwd: '/ws' },
        events: [
          event('tool/call', { callId: 'c1', name: 'read', arguments: '{not json' }),
          event('tool/result', {
            message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', isError: false, content: [] }] },
            meta: { path: 'ok.txt' },
          }),
          event('tool/call', { name: 'read' }), // 缺 callId
          event('tool/result', {}), // 缺 callId → 无法配对
          event('tool/call', { callId: 'c2', name: 'unknown-tool', arguments: '{}' }),
          event('tool/result', {
            message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', isError: false, content: [] }] },
            meta: { path: 'unknown.txt' },
          }),
          event('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'model' } }),
          event('user/message', { content: [{ type: 'text', text: 'y' }] }), // 缺 source
          ask('real question'),
        ],
      }),
      traceSession: async id => ({ target: { header: { id, cwd: '/ws' } }, descendants: [] }),
    }
    const { aggregate } = await aggregateContext(engine, 's1')
    // arguments 解析失败 → 回落 meta.path 仍然计数
    expect(aggregate.references.totalFiles).toBe(1)
    expect(findFile(aggregate.references.tree, 'ok.txt')).toMatchObject({ viewCount: 1 })
    // 未知工具名不计参考
    expect(findFile(aggregate.references.tree, 'unknown.txt')).toBeUndefined()
    // 非 user / plugin 的 source.kind 与缺 source 的事件都不进用户输入
    expect(aggregate.inputs.userItems).toHaveLength(1)
    expect(aggregate.inputs.userItems[0]?.text).toBe('real question')
  })

  it('concurrency=4 下 40 个子会话不丢不重（并发池无竞态）', async () => {
    const engine = engineWithChildren(MAX_CHILD_SESSIONS, index => [say(1, `child-${String(index)}`)])
    const { aggregate } = await aggregateContext(engine, 'main-session')
    const keys = aggregate.outputs.textSegments.map(segment => segment.agentKey)
    const childKeys = keys.filter(key => key.startsWith('child-'))
    expect(new Set(childKeys).size).toBe(MAX_CHILD_SESSIONS)
    expect(childKeys).toHaveLength(MAX_CHILD_SESSIONS)
    expect(aggregate.agents).toHaveLength(MAX_CHILD_SESSIONS + 1)
  })
})
