/**
 * 输入分组与委派归属（增量设计 §1.5 / §3.3）。
 *
 * 归属口径：委派指令归**收到委派的子 Agent**（谁收到算谁的），不归发出的父 Agent。
 * 子会话自身的 `user/message`（`source.kind === 'user'`）天然落在子会话里，
 * 按 provenance 打语义标签：
 *   - 主会话一律 `user`；
 *   - 子会话 `descriptor` 之前（无 rpcId）= `user`（继承的父上下文历史），
 *     带 rpcId = `inherited`（继承的父上下文原话）；
 *   - 子会话 `descriptor` 之后（无 rpcId）= `delegation`（主 Agent 下发），
 *     带 rpcId = `user`（你直接对该子 Agent 说的）。
 * 本文件 `ask()` 不设置 rpcId，故子会话的追问全部归 `delegation`，不再有 `followup`。
 */

import { describe, expect, it } from 'vitest'
import { aggregateContext, type AggregatorEngine, type AggregatorEvent, type AggregatorSessionHeader } from '../src/host/aggregator.ts'
import type { UserInputKind } from '../src/shared/types.ts'

const CWD = '/ws'
const T0 = 1_700_000_000_000

function makeEvents(defs: Array<[type: string, data: unknown]>): AggregatorEvent[] {
  return defs.map(([type, data], index) => ({ type, seq: index + 1, time: T0 + index, data }))
}

const ask = (text: string): [string, unknown] =>
  ['user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }]

const descriptor = (label: string): [string, unknown] =>
  ['subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'inproc', label }]

const pluginMsg = (plugin: string, text: string): [string, unknown] => [
  'user/message',
  { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, form: 'instructions' } },
]

/** 谱系节点的结构化投影（显式标注，避免递归推导）。 */
interface LineageNode {
  session: { header: AggregatorSessionHeader }
  descendants: LineageNode[]
}

/** 构造引擎：sessions[id] = { header, events }；childrenOf 描述一级子会话。 */
function makeEngine(
  sessions: Record<string, { header: Partial<AggregatorSessionHeader> & { id: string }; events: AggregatorEvent[] }>,
  childrenOf: Record<string, string[]> = {},
): AggregatorEngine {
  const node = (id: string): LineageNode => ({
    session: { header: sessions[id]?.header ?? { id } },
    descendants: (childrenOf[id] ?? []).map(node),
  })
  return {
    readSession: async id => {
      const session = sessions[id]
      if (session === undefined) throw new Error(`no such session: ${id}`)
      return { session: { ...session.header, cwd: session.header.cwd ?? CWD }, events: session.events }
    },
    traceSession: async id => ({ target: { header: sessions[id]?.header ?? { id } }, descendants: (childrenOf[id] ?? []).map(node) }),
  }
}

/** 取某 Agent 的输入条目（按时间升序）。 */
function itemsOf(aggregate: Awaited<ReturnType<typeof aggregateContext>>['aggregate'], agentKey: string) {
  return aggregate.inputs.userItems.filter(item => item.agentKey === agentKey)
}

function kindsOf(aggregate: Awaited<ReturnType<typeof aggregateContext>>['aggregate'], agentKey: string): UserInputKind[] {
  return itemsOf(aggregate, agentKey).map(item => item.inputKind)
}

describe('inputKind 判定（§1.5 主路径）', () => {
  it('主会话全部 user/message → user', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([ask('第一条'), ask('第二条')]) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(kindsOf(aggregate, 'main')).toEqual(['user', 'user'])
  })

  it('子会话首条 user/message（descriptor 之后）→ delegation', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([]) },
      c1: {
        header: { id: 'c1', parentSession: 's1', origin: 'subagent' },
        events: makeEvents([descriptor('审阅员'), ask('请审阅 src/**')]),
      },
    }, { s1: ['c1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(kindsOf(aggregate, 'c1')).toEqual(['delegation'])
  })

  it('子会话第二条及以后（无 rpcId）→ 追加的 delegation', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([]) },
      c1: {
        header: { id: 'c1', parentSession: 's1', origin: 'subagent' },
        events: makeEvents([descriptor('c'), ask('委派任务'), ask('再看一下测试覆盖'), ask('还有吗')]),
      },
    }, { s1: ['c1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(kindsOf(aggregate, 'c1')).toEqual(['delegation', 'delegation', 'delegation'])
  })

  it('带继承父上下文前缀：descriptor 之前的历史条 → user，之后首条才是 delegation', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([]) },
      c1: {
        header: { id: 'c1', parentSession: 's1', origin: 'subagent' },
        events: makeEvents([ask('历史提问 1'), ask('历史提问 2'), descriptor('c'), ask('真正的委派指令'), ask('追问')]),
      },
    }, { s1: ['c1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(kindsOf(aggregate, 'c1')).toEqual(['user', 'user', 'delegation', 'delegation'])
    // 历史条保留可见（不丢弃）
    expect(itemsOf(aggregate, 'c1').map(item => item.text)).toEqual([
      '历史提问 1', '历史提问 2', '真正的委派指令', '追问',
    ])
  })

  it('无 descriptor 事件的子会话：首条 user/message 仍判为 delegation', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([]) },
      c1: {
        header: { id: 'c1', parentSession: 's1', origin: 'subagent' },
        events: makeEvents([ask('无 descriptor 的委派'), ask('追问')]),
      },
    }, { s1: ['c1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(kindsOf(aggregate, 'c1')).toEqual(['delegation', 'delegation'])
  })
})

describe('groups 投影（§3.3）', () => {
  it('顺序：main(order 0) 在前，子会话按徽标序；entryIds 按时间升序', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([ask('主 1'), ask('主 2')]) },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([descriptor('a'), ask('子 1')]) },
      c2: { header: { id: 'c2', parentSession: 's1', origin: 'subagent' }, events: makeEvents([descriptor('b'), ask('子 2')]) },
    }, { s1: ['c1', 'c2'] })
    const { aggregate } = await aggregateContext(engine, 's1')

    expect(aggregate.inputs.groups.map(group => [group.agentKey, group.order]))
      .toEqual([['main', 0], ['c1', 1], ['c2', 2]])
    expect(aggregate.inputs.totalItems).toBe(aggregate.inputs.userItems.length + aggregate.inputs.pluginItems.length)
    expect(aggregate.inputs.totalItems).toBe(4)

    // 每个 entryId 都能解析到条目本体，且组内按时间升序
    const byId = new Map<string, number>([
      ...aggregate.inputs.userItems.map(item => [item.id, item.time] as const),
      ...aggregate.inputs.pluginItems.map(item => [item.id, item.time] as const),
    ])
    for (const group of aggregate.inputs.groups) {
      const times = group.entryIds.map(id => byId.get(id) ?? -1)
      expect([...times].sort((a, b) => a - b)).toEqual(times)
      expect(group.entryIds.length).toBeGreaterThan(0)
    }
  })

  it('counts 四项与条目实际分类一致（含注入）', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([ask('主提示 1'), pluginMsg('p-main', '注入 one'), ask('主提示 2')]) },
      c1: {
        header: { id: 'c1', parentSession: 's1', origin: 'subagent' },
        events: makeEvents([descriptor('c'), ask('委派活'), ask('追问一波'), pluginMsg('p-child', '注入 two')]),
      },
    }, { s1: ['c1'] })
    const { aggregate } = await aggregateContext(engine, 's1')

    const main = aggregate.inputs.groups.find(group => group.agentKey === 'main')
    expect(main?.counts).toEqual({ user: 2, inherited: 0, delegations: 0, agentMessages: 0, injections: 1 })
    const child = aggregate.inputs.groups.find(group => group.agentKey === 'c1')
    expect(child?.counts).toEqual({ user: 0, inherited: 0, delegations: 2, agentMessages: 0, injections: 1 })
  })

  it('id 稳定且唯一：makeEntryId(sessionId, seq)', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([ask('a'), ask('b')]) },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([descriptor('c'), ask('d')]) },
    }, { s1: ['c1'] })
    const { aggregate, } = await aggregateContext(engine, 's1')
    const ids = [
      ...aggregate.inputs.userItems.map(item => item.id),
      ...aggregate.inputs.pluginItems.map(item => item.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
    // 主会话第 1 条（seq 1）与子会话第 2 条（seq 2，descriptor 占 seq 1）
    expect(aggregate.inputs.userItems.find(item => item.text === 'a')?.id).toBe('s1:1')
    expect(aggregate.inputs.userItems.find(item => item.text === 'd')?.id).toBe('c1:2')
  })

  it('空输入：groups 仍为每个 Agent 产出空块，totalItems 为 0', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([]) },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.inputs.groups).toEqual([
      { agentKey: 'main', order: 0, entryIds: [], counts: { user: 0, inherited: 0, delegations: 0, agentMessages: 0, injections: 0 } },
      { agentKey: 'c1', order: 1, entryIds: [], counts: { user: 0, inherited: 0, delegations: 0, agentMessages: 0, injections: 0 } },
    ])
    expect(aggregate.inputs.totalItems).toBe(0)
  })

  it('降级子会话（无明细）仍有一个块（可能空，也可能由兜底填入）', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([]) },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([ask('不可见')]) },
      c2: { header: { id: 'c2', parentSession: 's1', origin: 'subagent' }, events: makeEvents([ask('不可见')]) },
      c3: { header: { id: 'c3', parentSession: 's1', origin: 'subagent' }, events: makeEvents([ask('不可见')]) },
    }, { s1: ['c1', 'c2', 'c3'] })
    // 只有前两个被扫描（模拟未扫描子会话）过于耦合实现，这里直接断言块齐备即可
    const patched: AggregatorEngine = {
      readSession: async id => {
        if (id === 'c3') throw new Error('child unreadable')
        return engine.readSession(id)
      },
      traceSession: engine.traceSession,
    }
    const { aggregate } = await aggregateContext(patched, 's1')
    const keys = aggregate.inputs.groups.map(group => group.agentKey)
    expect(keys).toEqual(['main', 'c1', 'c2', 'c3'])
    expect(aggregate.inputs.groups.find(group => group.agentKey === 'c3')?.entryIds).toEqual([])
  })
})
