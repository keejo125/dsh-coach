/**
 * 最终答复判定（增量设计 §1.2 规则 F1~F6）。
 *
 * 判定发生在合并 + 全局时间排序之后：「最后一段」是时间序概念，扫描期无从预知。
 * host 计算并下发 `finalByAgent`，client 只消费、不自行推导。
 */

import { describe, expect, it } from 'vitest'
import { aggregateContext, type AggregatorEngine, type AggregatorEvent, type AggregatorSessionHeader } from '../src/host/aggregator.ts'
import { MAX_OUTPUT_SEGMENTS, MAX_TOTAL_OUTPUT_SEGMENTS, PROCESS_PREVIEW_BYTES } from '../src/shared/constants.ts'

const CWD = '/ws'
const T0 = 1_700_000_000_000

/** 构造事件（seq 自动递增，time 随 seq 递增，保证时间序 == 事件序）。 */
function makeEvents(defs: Array<[type: string, data: unknown]>): AggregatorEvent[] {
  return defs.map(([type, data], index) => ({ type, seq: index + 1, time: T0 + index, data }))
}

/** 指定 seq/time 的事件（用于构造交错时间线）。 */
function ev(seq: number, time: number, turn: number, text: string, type = 'assistant/message'): AggregatorEvent {
  return { type, seq, time, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

const say = (turn: number, text: string): [string, unknown] =>
  ['assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }]

const sayInterrupted = (turn: number, text: string): [string, unknown] =>
  ['assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, interrupted: true }]

/** 纯工具调用产生的空 assistant/message（基座实证形态）。 */
const sayEmpty = (turn: number): [string, unknown] =>
  ['assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read', input: {} }] } }]

const ask = (text: string): [string, unknown] =>
  ['user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }]

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

describe('F1 · 空文本段无资格', () => {
  it('Agent 只有空 assistant/message → finalByAgent.segment === null', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([sayEmpty(1), sayEmpty(2)]) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    // 空文本段扫描期即剔除，不产出段（语义变更 3）
    expect(aggregate.outputs.textSegments).toEqual([])
    expect(aggregate.outputs.finalByAgent).toEqual([{ agentKey: 'main', segment: null, processCount: 0 }])
    expect(aggregate.outputs.processCount).toBe(0)
  })

  it('空段夹在中间不影响判定：最终答复 = 其前最后一段非空文本', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, '第一段'), sayEmpty(2), sayEmpty(3)]) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.outputs.textSegments).toHaveLength(1)
    expect(aggregate.outputs.finalByAgent[0]?.segment?.text).toBe('第一段')
  })
})

describe('F2 · 最终答复 = 时间序最后一段非空文本', () => {
  it('同一 Agent 多段：取最后一段；其余降为 process', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, 'A'), say(2, 'B'), say(3, 'C')]) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    const entry = aggregate.outputs.finalByAgent[0]
    expect(entry?.segment?.text).toBe('C')
    expect(entry?.processCount).toBe(2)
    expect(aggregate.outputs.processCount).toBe(2)
    expect(aggregate.outputs.textSegments.map(segment => segment.kind)).toEqual(['process', 'process', 'final'])
  })

  it('F2b：最终答复之后又出现新工具调用 + 新文本 → 新段成为最终答复', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, '旧结论'), sayEmpty(2), say(2, '新结论')]) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.outputs.finalByAgent[0]?.segment?.text).toBe('新结论')
  })
})

describe('F3 · 被中断的段仍是最终答复', () => {
  it('interrupted 段保留标记且被判为最终答复', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, '先说一段'), sayInterrupted(2, '半截就断了')]) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    const segment = aggregate.outputs.finalByAgent[0]?.segment
    expect(segment?.text).toBe('半截就断了')
    expect(segment?.interrupted).toBe(true)
  })
})

describe('F4 · 零非空文本的 Agent 不出现在文字区', () => {
  it('该 Agent 的 finalByAgent 条目 segment === null，但徽标与文件树仍在', async () => {
    const writePair = (seq: number, path: string): AggregatorEvent[] => ([
      { type: 'tool/call', seq, time: T0 + seq, data: { callId: `w${String(seq)}`, name: 'write', arguments: JSON.stringify({ file_path: path, content: 'x' }) } },
      { type: 'tool/result', seq: seq + 1, time: T0 + seq + 1, data: { message: { source: { kind: 'tool', callId: `w${String(seq)}` }, content: [{ type: 'tool-result', isError: false }] }, meta: { diffs: [] } } },
    ])
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, '主 Agent 结论')]) },
      quiet: {
        header: { id: 'quiet', parentSession: 's1', origin: 'subagent' },
        events: [...writePair(10, 'out/quiet.txt'), ...makeEvents([])],
      },
    }, { s1: ['quiet'] })

    const { aggregate } = await aggregateContext(engine, 's1')
    // 徽标仍在（它可能贡献了文件产出）
    expect(aggregate.agents.map(badge => badge.agentKey)).toEqual(['main', 'quiet'])
    // finalByAgent 占位但 segment 为 null：不凭空造答复
    const quiet = aggregate.outputs.finalByAgent.find(entry => entry.agentKey === 'quiet')
    expect(quiet).toMatchObject({ agentKey: 'quiet', segment: null, processCount: 0 })
    // 文件树上仍能看到它
    expect(aggregate.outputs.files.flatMap(node => node.children ?? []).map(node => node.path)).toContain('out/quiet.txt')
  })

  it('子会话 degraded 时该 Agent 的 finalByAgent 条目 segment === null', async () => {
    const flood = Array.from({ length: 20_001 }, (_, index) => ['step/start', { turn: index, step: 1 }] as [string, unknown])
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, '主结论')]) },
      big: { header: { id: 'big', origin: 'subagent' }, events: makeEvents([say(1, '子结论'), ...flood]) },
    }, { s1: ['big'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    const big = aggregate.outputs.finalByAgent.find(entry => entry.agentKey === 'big')
    expect(big?.segment).toBeNull()
    expect(aggregate.agents.find(badge => badge.agentKey === 'big')?.degraded).toBe(true)
  })
})

describe('F5 · finalByAgent 顺序 = 主 Agent 最前 + 子 Agent 徽标序', () => {
  it('子 Agent 最终答复时间晚于主 Agent 时，顺序仍是 main 在前（非时间序）', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: [ev(1, 1000, 1, 'MAIN-EARLY')] },
      child1: { header: { id: 'child1', parentSession: 's1', origin: 'subagent' }, events: [ev(1, 5000, 1, 'CHILD-LATE')] },
    }, { s1: ['child1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.outputs.finalByAgent.map(entry => entry.agentKey)).toEqual(['main', 'child1'])
    expect(aggregate.outputs.finalByAgent.map(entry => entry.segment?.text ?? null)).toEqual(['MAIN-EARLY', 'CHILD-LATE'])
    // 时间序数组里子会话的段在后（对照：投影顺序 ≠ 时间序）
    expect(aggregate.outputs.textSegments.map(segment => segment.text)).toEqual(['MAIN-EARLY', 'CHILD-LATE'])
  })

  it('子 Agent 最终答复早于主 Agent 时，投影顺序依然是 main 在前', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: [ev(5, 9000, 1, 'MAIN-LATE')] },
      child1: { header: { id: 'child1', parentSession: 's1', origin: 'subagent' }, events: [ev(1, 1000, 1, 'CHILD-EARLY')] },
    }, { s1: ['child1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.outputs.finalByAgent.map(entry => entry.segment?.text ?? null)).toEqual(['MAIN-LATE', 'CHILD-EARLY'])
    // 时间序数组里子会话的段在前——投影顺序与时间序在此处相反
    expect(aggregate.outputs.textSegments.map(segment => segment.text)).toEqual(['CHILD-EARLY', 'MAIN-LATE'])
  })
})

describe('F6 · 预算豁免与淘汰方向', () => {
  it('F6a：单会话段数超 MAX_OUTPUT_SEGMENTS → 保留最新的 N 段', async () => {
    const total = MAX_OUTPUT_SEGMENTS + 7
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents(Array.from({ length: total }, (_, index) => say(index + 1, `seg-${String(index)}`))) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.outputs.textSegments).toHaveLength(MAX_OUTPUT_SEGMENTS)
    // 被丢的是最早的 7 段
    expect(aggregate.outputs.textSegments[0]?.text).toBe('seg-7')
    expect(aggregate.outputs.textSegments.at(-1)?.text).toBe(`seg-${String(total - 1)}`)
    expect(aggregate.budgets.outputsTruncated).toBe(true)
    expect(aggregate.budgets.droppedOutputSegments).toBe(7)
    // 最终答复仍是最后一段（淘汰方向正确性的直接体现）
    expect(aggregate.outputs.finalByAgent[0]?.segment?.text).toBe(`seg-${String(total - 1)}`)
  })

  it('F6b：全局超 MAX_TOTAL_OUTPUT_SEGMENTS → 淘汰最早过程段，final 段豁免', async () => {
    // 5 个子会话 × 500 段 = 2500 > 2000：全局预算生效，淘汰最早的过程段
    const children = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`c${String(index)}`, {
        header: { id: `c${String(index)}`, parentSession: 's1', origin: 'subagent' },
        events: makeEvents(Array.from({ length: MAX_OUTPUT_SEGMENTS }, (_, k) => say(k + 1, `c${String(index)}-${String(k)}`))),
      }]),
    )
    const engine = makeEngine({ s1: { header: { id: 's1' }, events: makeEvents([]) }, ...children }, { s1: Object.keys(children) })
    const { aggregate } = await aggregateContext(engine, 's1')

    expect(aggregate.outputs.textSegments).toHaveLength(MAX_TOTAL_OUTPUT_SEGMENTS)
    expect(aggregate.budgets.outputsTruncated).toBe(true)
    expect(aggregate.budgets.droppedOutputSegments).toBe(5 * MAX_OUTPUT_SEGMENTS - MAX_TOTAL_OUTPUT_SEGMENTS)
    // 计数按**收口后**的集合重算：processCount 与数组内 process 段数必须相等（§3.2）
    const processes = aggregate.outputs.textSegments.filter(segment => segment.kind === 'process')
    expect(aggregate.outputs.processCount).toBe(processes.length)
    expect(aggregate.outputs.processCount).toBe(MAX_TOTAL_OUTPUT_SEGMENTS - 5)
    expect(aggregate.outputs.finalByAgent.reduce((total, entry) => total + entry.processCount, 0))
      .toBe(aggregate.outputs.processCount)
    // 每个子 Agent 的最终答复都还在（final 段豁免）；主会话本例无输出，故为 null
    expect(aggregate.outputs.finalByAgent.find(entry => entry.agentKey === 'main')?.segment).toBeNull()
    for (const entry of aggregate.outputs.finalByAgent.filter(item => item.agentKey !== 'main')) {
      expect(entry.segment, entry.agentKey).not.toBeNull()
      expect(aggregate.outputs.textSegments).toContain(entry.segment)
    }
    // 被淘汰的段都是最早的：首个子会话的最后一段已不在数组里
    const texts = new Set(aggregate.outputs.textSegments.map(segment => segment.text))
    expect(texts.has('c0-0')).toBe(false)
    expect(texts.has('c4-499')).toBe(true)
  })

  it('单会话触达 2× 水位时滑动窗口收口，内存不随事件数线性增长', async () => {
    // 3000 段：窗口在 1000 处收口到 500，随后重复，最终收口到 500
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents(Array.from({ length: 3_000 }, (_, index) => say(index + 1, `seg-${String(index)}`))) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.outputs.textSegments).toHaveLength(MAX_OUTPUT_SEGMENTS)
    expect(aggregate.outputs.textSegments.at(-1)?.text).toBe('seg-2999')
    expect(aggregate.budgets.outputsTruncated).toBe(true)
  })
})

describe('过程段预览裁剪（§1.4）', () => {
  it('过程段 previewOnly === true 且正文 ≤ PROCESS_PREVIEW_BYTES；final 段 previewOnly === false', async () => {
    const long = 'x'.repeat(2_000)
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, long), say(2, '这是很短的结论')]) },
    })
    const { aggregate, outputFullTexts } = await aggregateContext(engine, 's1')

    const process = aggregate.outputs.textSegments[0]
    expect(process?.kind).toBe('process')
    expect(process?.previewOnly).toBe(true)
    expect(Buffer.byteLength(process?.text ?? '', 'utf-8')).toBeLessThanOrEqual(PROCESS_PREVIEW_BYTES)
    // 预览裁剪不进 budgets（否则横幅永远为真）
    expect(aggregate.budgets.outputsTruncated).toBe(false)
    expect(aggregate.budgets.droppedOutputSegments).toBe(0)
    // 全文仍可按 id 取回
    expect(outputFullTexts.get(process?.id ?? '')).toBe(long)

    const final = aggregate.outputs.finalByAgent[0]?.segment
    expect(final?.kind).toBe('final')
    expect(final?.previewOnly).toBe(false)
    expect(final?.text).toBe('这是很短的结论')
  })

  it('正文不足阈值的过程段不置 previewOnly', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, '短'), say(2, '结论')]) },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.outputs.textSegments[0]?.previewOnly).toBe(false)
    expect(aggregate.outputs.textSegments[0]?.text).toBe('短')
  })

  it('processCount 与 textSegments 中 kind=process 的段数一致', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([say(1, 'a'), say(2, 'b'), say(3, 'c'), ...[ask('追问')]]) },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: makeEvents([say(1, 'x'), say(2, 'y')]) },
    }, { s1: ['c1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    const processes = aggregate.outputs.textSegments.filter(segment => segment.kind === 'process')
    expect(aggregate.outputs.processCount).toBe(processes.length)
    expect(aggregate.outputs.processCount).toBe(3)
    // 各 Agent 的 processCount 之和 == 全局 processCount
    const sum = aggregate.outputs.finalByAgent.reduce((total, entry) => total + entry.processCount, 0)
    expect(sum).toBe(aggregate.outputs.processCount)
  })
})

describe('多 Agent 交错：每个 Agent 各自取到自己的最后一段', () => {
  it('主/子会话输出交错时互不干扰', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: [ev(1, 1000, 1, 'M1'), ev(3, 3000, 1, 'M2')] },
      c1: { header: { id: 'c1', parentSession: 's1', origin: 'subagent' }, events: [ev(1, 2000, 1, 'C1'), ev(2, 5000, 2, 'C2')] },
    }, { s1: ['c1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    const byKey = new Map(aggregate.outputs.finalByAgent.map(entry => [entry.agentKey, entry.segment?.text]))
    expect(byKey.get('main')).toBe('M2')
    expect(byKey.get('c1')).toBe('C2')
    // 每个 Agent 各自的 processCount
    expect(aggregate.outputs.finalByAgent.find(entry => entry.agentKey === 'main')?.processCount).toBe(1)
    expect(aggregate.outputs.finalByAgent.find(entry => entry.agentKey === 'c1')?.processCount).toBe(1)
  })
})
