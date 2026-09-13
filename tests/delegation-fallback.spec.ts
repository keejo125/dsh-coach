/**
 * 父会话 `subagent` tool/call 兜底（增量设计 §1.5 四条门控）。
 *
 * 门控（缺一不可）：
 * 1. 仅当该子会话**无明细**时启用（degraded / 未扫描）；
 * 2. 配对锚点必须精确相等：`subagent/start.id` === 子会话 id；
 * 3. 工具名匹配（`subagent`），或 arguments 同时含 `description` + `prompt` 字符串字段；
 * 4. 宁缺勿错：FIFO 配对，一个 `subagent/start` 只消费一个未配对 call；
 *    同一时刻存在多个无法区分的未配对委派 call 时**全部放弃**。
 */

import { describe, expect, it } from 'vitest'
import { aggregateContext, type AggregatorEngine, type AggregatorEvent, type AggregatorSessionHeader } from '../src/host/aggregator.ts'

const CWD = '/ws'
const T0 = 1_700_000_000_000

function makeEvents(defs: Array<[type: string, data: unknown]>): AggregatorEvent[] {
  return defs.map(([type, data], index) => ({ type, seq: index + 1, time: T0 + index, data }))
}

/** 委派工具调用（基座 tool-subagent 的 arguments 形状）。 */
const call = (callId: string, name: string, args: unknown): [string, unknown] =>
  ['tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }]

const result = (callId: string): [string, unknown] => [
  'tool/result',
  {
    turn: 1, step: 1,
    message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }] },
    meta: null,
  },
]

/** 基座 SubagentRunInfo（packages/subagent/subagent/src/types.ts:38-46）。 */
const subagentStart = (childId: string, runId = `run-${childId}`): [string, unknown] =>
  ['subagent/start', { runId, provider: 'inproc', id: childId, local: true }]

const ask = (text: string): [string, unknown] =>
  ['user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }]

const descriptor = (label: string): [string, unknown] =>
  ['subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'inproc', label }]

/** 20 001 个事件：令子会话超出 MAX_CHILD_EVENTS 而 degraded。 */
function flood(): Array<[string, unknown]> {
  return Array.from({ length: 20_001 }, (_, index) => ['step/start', { turn: index, step: 1 }] as [string, unknown])
}

/** 谱系节点的结构化投影（显式标注，避免递归推导）。 */
interface LineageNode {
  session: { header: AggregatorSessionHeader }
  descendants: LineageNode[]
}

/** 构造引擎；unreadable 里的子会话 readSession 直接抛错。 */
function makeEngine(
  sessions: Record<string, { header: Partial<AggregatorSessionHeader> & { id: string }; events: AggregatorEvent[] }>,
  childrenOf: Record<string, string[]>,
  unreadable: readonly string[] = [],
): AggregatorEngine {
  const node = (id: string): LineageNode => ({
    session: { header: sessions[id]?.header ?? { id } },
    descendants: (childrenOf[id] ?? []).map(node),
  })
  return {
    readSession: async id => {
      if (unreadable.includes(id)) throw new Error(`child unreadable: ${id}`)
      const session = sessions[id]
      if (session === undefined) throw new Error(`no such session: ${id}`)
      return { session: { ...session.header, cwd: session.header.cwd ?? CWD }, events: session.events }
    },
    traceSession: async id => ({ target: { header: sessions[id]?.header ?? { id } }, descendants: (childrenOf[id] ?? []).map(node) }),
  }
}

/** 取某 Agent 的输入条目。 */
function itemsOf(aggregate: Awaited<ReturnType<typeof aggregateContext>>['aggregate'], agentKey: string) {
  return aggregate.inputs.userItems.filter(item => item.agentKey === agentKey)
}

describe('门控 1 · 仅当子会话无明细时启用', () => {
  it('子会话正常 → 不使用父侧 prompt（一手记录优先）', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '审阅代码', prompt: '父侧委派文本' }),
          subagentStart('c1'),
          result('d1'),
        ]),
      },
      c1: {
        header: { id: 'c1', parentSession: 's1', origin: 'subagent' },
        events: makeEvents([descriptor('c1'), ask('子会话自身记录的委派')]),
      },
    }, { s1: ['c1'] })

    const { aggregate } = await aggregateContext(engine, 's1')
    const items = itemsOf(aggregate, 'c1')
    expect(items).toHaveLength(1)
    expect(items[0]?.text).toBe('子会话自身记录的委派')
    expect(items[0]?.provisional).toBeUndefined()
  })

  it('子会话 degraded（超 MAX_CHILD_EVENTS）→ 用父侧 prompt 生成 provisional 条目', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '审阅代码', prompt: '父侧委派文本' }),
          subagentStart('c1'),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([ask('不可见'), ...flood()]) },
    }, { s1: ['c1'] })

    const { aggregate } = await aggregateContext(engine, 's1')
    const items = itemsOf(aggregate, 'c1')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      inputKind: 'delegation',
      text: '父侧委派文本',
      provisional: true,
      agentKey: 'c1',
    })
    // 兜底不改变 degraded 标记
    expect(aggregate.agents.find(badge => badge.agentKey === 'c1')?.degraded).toBe(true)
    expect(aggregate.budgets.childrenScanned).toBe(0)
  })

  it('子会话读取失败（未扫描）→ 同样兜底', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '跑测试', prompt: '父侧 prompt' }),
          subagentStart('c1'),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')).toHaveLength(1)
    expect(itemsOf(aggregate, 'c1')[0]?.provisional).toBe(true)
  })
})

describe('门控 2 · 配对锚点必须精确相等', () => {
  it('subagent/start.id 与目标子会话 id 不等 → 不填', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '审阅代码', prompt: '父侧委派文本' }),
          subagentStart('someone-else'),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')).toEqual([])
  })

  it('subagent/start 缺 id → 不填', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '审阅代码', prompt: '父侧委派文本' }),
          ['subagent/start', { runId: 'run-1', provider: 'inproc', local: true }],
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')).toEqual([])
  })
})

describe('门控 3 · 工具名与形状兜底', () => {
  it('工具名非 subagent 但 arguments 含 description + prompt 字符串 → 形状兜底命中', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'custom-delegate', { description: '审阅代码', prompt: '自定义工具名的委派' }),
          subagentStart('c1'),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')[0]?.text).toBe('自定义工具名的委派')
  })

  it('名不叫 subagent 且缺少 description → 不认作委派调用', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'read', { file_path: 'src/a.ts' }),
          subagentStart('c1'),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')).toEqual([])
  })

  it('名为 subagent 但 prompt 不是字符串 → 不认作委派调用', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '审阅代码', prompt: 42 }),
          subagentStart('c1'),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')).toEqual([])
  })
})

describe('门控 4 · 宁缺勿错', () => {
  it('同一时刻多个未配对委派 call → 全部放弃', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '任务一', prompt: '委派一' }),
          call('d2', 'subagent', { description: '任务二', prompt: '委派二' }),
          subagentStart('c1'),
          result('d1'),
          result('d2'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    // 两个待配对调用无法区分 → 一次都不猜
    expect(itemsOf(aggregate, 'c1')).toEqual([])
  })

  it('两个子会话各配一个委派调用（串行）→ 各归各的', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '任务一', prompt: '委派给 c1' }),
          subagentStart('c1'),
          result('d1'),
          call('d2', 'subagent', { description: '任务二', prompt: '委派给 c2' }),
          subagentStart('c2'),
          result('d2'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
      c2: { header: { id: 'c2', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1', 'c2'] }, ['c1', 'c2'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')[0]?.text).toBe('委派给 c1')
    expect(itemsOf(aggregate, 'c2')[0]?.text).toBe('委派给 c2')
  })

  it('无 subagent/start 事件 → 不填', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '审阅代码', prompt: '没有 start 事件' }),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')).toEqual([])
  })

  it('tool/result 先到（调用已消费）→ 随后的 start 配不到 call，不填', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '审阅代码', prompt: 'result 抢先' }),
          result('d1'),
          subagentStart('c1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    expect(itemsOf(aggregate, 'c1')).toEqual([])
  })
})

describe('兜底条目的呈现契约', () => {
  it('inputKind === delegation 且 provisional === true；id 落在父会话且唯一', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '审阅代码', prompt: '父侧委派文本' }),
          subagentStart('c1'),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    const item = itemsOf(aggregate, 'c1')[0]
    expect(item?.inputKind).toBe('delegation')
    expect(item?.provisional).toBe(true)
    // id 由父会话 id + tool/call 事件 seq 构成，不会与主/子会话其他条目撞车
    expect(item?.id.startsWith('s1:')).toBe(true)
    const ids = aggregate.inputs.userItems.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 计入该子 Agent 的分组与计数
    const group = aggregate.inputs.groups.find(entry => entry.agentKey === 'c1')
    expect(group?.entryIds).toEqual([item?.id])
    expect(group?.counts).toEqual({ user: 0, inherited: 0, delegations: 1, agentMessages: 0, injections: 0 })
    expect(aggregate.inputs.totalItems).toBe(1)
  })

  it('超长 prompt 按 4KB 截断，textTruncated 置位（与一手条目同口径）', async () => {
    const long = 'z'.repeat(9_000)
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          call('d1', 'subagent', { description: '长任务', prompt: long }),
          subagentStart('c1'),
          result('d1'),
        ]),
      },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['c1'] }, ['c1'])

    const { aggregate } = await aggregateContext(engine, 's1')
    const item = itemsOf(aggregate, 'c1')[0]
    expect(item?.textTruncated).toBe(true)
    expect(Buffer.byteLength(item?.text ?? '', 'utf-8')).toBeLessThanOrEqual(4 * 1024)
  })
})
