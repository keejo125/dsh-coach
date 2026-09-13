/**
 * client selectors：筛选后可见集合 + 横幅两类分派（增量设计 §1.6 / §4.3）。
 *
 * 纯函数、无 React 依赖，直接单测。核心断言是缺陷修复本身：
 * 「选中单个 Agent 后，全局类横幅不再显示；可见类横幅仍跟随筛选后的集合」
 */

import { describe, expect, it } from 'vitest'
import {
  selectBanners,
  selectFinalAnswers,
  selectFinalSegments,
  selectInputEntries,
  selectInputGroups,
  selectProcessSegments,
  selectVisibleTruncation,
} from '../src/client/selectors.ts'
import { aggregateContext, type AggregatorEngine, type AggregatorEvent, type AggregatorSessionHeader } from '../src/host/aggregator.ts'
import { MAX_CHILD_SESSIONS, MAX_INPUT_ITEMS, MAX_OUTPUT_SEGMENTS } from '../src/shared/constants.ts'
import { makeEntryId } from '../src/shared/ids.ts'
import type {
  AgentInputGroup,
  ContextAggregate,
  FileTreeNode,
  OutputTextSegment,
  PayloadBudgets,
  PluginInjectItem,
  UserInputItem,
} from '../src/shared/types.ts'

const T0 = 1_700_000_000_000

function budgets(partial: Partial<PayloadBudgets> = {}): PayloadBudgets {
  return {
    inputsTruncated: false,
    referencesTruncated: false,
    outputsTruncated: false,
    droppedOutputSegments: 0,
    childrenScanned: 0,
    childrenTotal: 0,
    ...partial,
  }
}

function userItem(seq: number, agentKey: string, text: string, extra: Partial<UserInputItem> = {}): UserInputItem {
  return {
    id: makeEntryId(agentKey === 'main' ? 's1' : agentKey, seq),
    seq,
    time: T0 + seq,
    agentKey,
    inputKind: 'user',
    text,
    textTruncated: false,
    attachments: [],
    ...extra,
  }
}

function injectItem(seq: number, agentKey: string, text: string): PluginInjectItem {
  return {
    id: makeEntryId(agentKey === 'main' ? 's1' : agentKey, seq),
    seq,
    time: T0 + seq,
    agentKey,
    plugin: 'p',
    text,
    textTruncated: false,
    filePaths: [],
  }
}

function segment(seq: number, agentKey: string, text: string, extra: Partial<OutputTextSegment> = {}): OutputTextSegment {
  return {
    id: makeEntryId(agentKey === 'main' ? 's1' : agentKey, seq),
    seq,
    time: T0 + seq,
    turn: 1,
    step: 1,
    agentKey,
    round: 1,
    text,
    textTruncated: false,
    kind: 'process',
    previewOnly: false,
    ...extra,
  }
}

function group(agentKey: string, order: number, entryIds: string[], counts: Partial<AgentInputGroup['counts']> = {}): AgentInputGroup {
  return {
    agentKey,
    order,
    entryIds,
    counts: { user: 0, inherited: 0, delegations: 0, agentMessages: 0, injections: 0, ...counts },
  }
}

function aggregate(partial: Partial<ContextAggregate> = {}): ContextAggregate {
  return {
    sessionId: 's1',
    generatedAt: 1,
    agents: [
      { agentKey: 'main', sessionId: 's1', label: 'main', role: 'main' },
      { agentKey: 'c1', sessionId: 'c1', label: 'builder', role: 'subagent' },
    ],
    inputs: { userItems: [], pluginItems: [], groups: [], injectTree: [], totalItems: 0 },
    references: { tree: [], totalFiles: 0, totalViews: 0 },
    outputs: { textSegments: [], finalByAgent: [], processCount: 0, files: [], totalFiles: 0 },
    budgets: budgets(),
    ...partial,
  }
}

/** 一个双 Agent 载荷：主 2 条输入 + 1 段 final + 1 段 process；子 1 条委派 + 1 段 final。 */
function twoAgentAggregate(): ContextAggregate {
  const mainProcess = segment(1, 'main', '主过程')
  const mainFinal = segment(2, 'main', '主结论', { kind: 'final' })
  const childFinal = segment(1, 'c1', '子结论', { kind: 'final' })
  const mainUser = userItem(1, 'main', '主提示')
  const childDelegation = userItem(2, 'c1', '派给子 Agent 的活', { inputKind: 'delegation' })
  const mainInject = injectItem(3, 'main', '注入正文')
  return aggregate({
    inputs: {
      userItems: [mainUser, childDelegation],
      pluginItems: [mainInject],
      groups: [
        group('main', 0, [mainUser.id, mainInject.id], { user: 1, injections: 1 }),
        group('c1', 1, [childDelegation.id], { delegations: 1 }),
      ],
      injectTree: [],
      totalItems: 3,
    },
    outputs: {
      textSegments: [mainProcess, mainFinal, childFinal],
      finalByAgent: [
        { agentKey: 'main', segment: mainFinal, processCount: 1 },
        { agentKey: 'c1', segment: childFinal, processCount: 0 },
      ],
      processCount: 1,
      files: [],
      totalFiles: 0,
    },
  })
}

describe('输入可见集合', () => {
  it('null = 全部：按分组顺序展平，含用户输入与注入', () => {
    const agg = twoAgentAggregate()
    const entries = selectInputEntries(agg, null)
    expect(entries.map(entry => entry.item.text)).toEqual(['主提示', '注入正文', '派给子 Agent 的活'])
    expect(entries.map(entry => entry.entryKind)).toEqual(['user', 'inject', 'user'])
  })

  it('选中某 Agent：只剩该 Agent 的块（「过滤块」而非「过滤条目」）', () => {
    const agg = twoAgentAggregate()
    const groups = selectInputGroups(agg, 'c1')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.agentKey).toBe('c1')
    expect(groups[0]?.entries.map(entry => entry.item.text)).toEqual(['派给子 Agent 的活'])
    expect(selectInputEntries(agg, 'c1')).toHaveLength(1)
  })

  it('解析不到本体的 id 被静默跳过（分组与条目不同源时不炸）', () => {
    const item = userItem(1, 'main', '存在的一条')
    const agg = aggregate({
      inputs: {
        userItems: [item],
        pluginItems: [],
        groups: [group('main', 0, [item.id, 's1:999'])],
        injectTree: [],
        totalItems: 1,
      },
    })
    expect(selectInputGroups(agg, null)[0]?.entries).toHaveLength(1)
  })
})

describe('输出可见集合', () => {
  it('最终答复：零非空文本的 Agent 不出现在文字区（规则 F4）', () => {
    const childFinal = segment(1, 'c1', '子结论', { kind: 'final' })
    const agg = aggregate({
      outputs: {
        textSegments: [childFinal],
        finalByAgent: [
          { agentKey: 'main', segment: null, processCount: 0 },
          { agentKey: 'c1', segment: childFinal, processCount: 0 },
        ],
        processCount: 0,
        files: [],
        totalFiles: 0,
      },
    })
    // main 无文字输出 → 被滤掉，不凭空造答复
    expect(selectFinalAnswers(agg, null).map(entry => entry.agentKey)).toEqual(['c1'])
    expect(selectFinalSegments(agg, null).map(segment => segment.text)).toEqual(['子结论'])
  })

  it('过程段与最终答复按 kind 分离，合计等于 textSegments', () => {
    const agg = twoAgentAggregate()
    expect(selectFinalSegments(agg, null).map(segment => segment.text)).toEqual(['主结论', '子结论'])
    expect(selectProcessSegments(agg, null).map(segment => segment.text)).toEqual(['主过程'])
    expect(selectFinalSegments(agg, null).length + selectProcessSegments(agg, null).length)
      .toBe(agg.outputs.textSegments.length)
  })

  it('选中某 Agent：最终答复与过程段都只留该 Agent 的', () => {
    const agg = twoAgentAggregate()
    expect(selectFinalAnswers(agg, 'c1').map(entry => entry.segment?.text)).toEqual(['子结论'])
    expect(selectProcessSegments(agg, 'c1')).toEqual([])
    expect(selectProcessSegments(agg, 'main').map(segment => segment.text)).toEqual(['主过程'])
  })
})

describe('可见截断判定（§1.6 可见类）', () => {
  it('previewOnly 不触发任何横幅（预览是产品决策，不是预算损失）', () => {
    const process = segment(1, 'main', 'x'.repeat(400), { previewOnly: true })
    const agg = aggregate({ outputs: { textSegments: [process], finalByAgent: [], processCount: 1, files: [], totalFiles: 0 } })
    expect(selectVisibleTruncation(selectInputEntries(agg, null), selectProcessSegments(agg, null)).anyTextTruncated).toBe(false)
  })

  it('可见条目正文被 4KB 截断 → 判定为真', () => {
    const long = segment(1, 'main', 'y'.repeat(100), { textTruncated: true })
    expect(selectVisibleTruncation([], [long]).anyTextTruncated).toBe(true)
  })

  it('输入条目被截断同样触发', () => {
    const item = userItem(1, 'main', 'z'.repeat(100), { textTruncated: true })
    expect(selectVisibleTruncation([{ entryKind: 'user', item }], []).anyTextTruncated).toBe(true)
  })
})

describe('横幅两类分派（缺陷修复的核心）', () => {
  it('全部 Agent 视图：全局类横幅按 budgets 显示', () => {
    const agg = aggregate({ budgets: budgets({ inputsTruncated: true, referencesTruncated: true, outputsTruncated: true, childrenScanned: 30, childrenTotal: 32 }) })
    const keys = selectBanners(agg, null, { anyTextTruncated: false }).map(banner => banner.key)
    expect(keys).toEqual([
      'banner.truncated.inputs',
      'banner.truncated.references',
      'banner.truncated.outputs',
      'banner.truncated.children',
    ])
  })

  it('选中单个 Agent：全局类横幅**不**显示（与视图不符的提示消失）', () => {
    const agg = aggregate({ budgets: budgets({ inputsTruncated: true, referencesTruncated: true, outputsTruncated: true, childrenScanned: 30, childrenTotal: 32 }) })
    expect(selectBanners(agg, 'c1', { anyTextTruncated: false })).toEqual([])
  })

  it('可见类横幅任何视图都显示（不会因为筛选而漏掉「这条被截断了」）', () => {
    const agg = aggregate({ budgets: budgets() })
    expect(selectBanners(agg, null, { anyTextTruncated: true })).toEqual([{ key: 'banner.truncated.text' }])
    expect(selectBanners(agg, 'c1', { anyTextTruncated: true })).toEqual([{ key: 'banner.truncated.text' }])
  })

  it('筛选后可见集合无截断 → 可见类横幅不显示，即使 budgets.outputsTruncated === true', () => {
    const agg = aggregate({ budgets: budgets({ outputsTruncated: true, droppedOutputSegments: 12 }) })
    expect(selectBanners(agg, null, { anyTextTruncated: false }).map(banner => banner.key)).toEqual(['banner.truncated.outputs'])
    // 选中单 Agent 后：全局类消失，可见类也没有 → 一条横幅都没有
    expect(selectBanners(agg, 'c1', { anyTextTruncated: false })).toEqual([])
  })

  it('子会话降级横幅带 scanned/total 参数', () => {
    const agg = aggregate({ budgets: budgets({ childrenScanned: 30, childrenTotal: 32 }) })
    expect(selectBanners(agg, null, { anyTextTruncated: false })).toEqual([
      { key: 'banner.truncated.children', params: { scanned: 30, total: 32 } },
    ])
  })

  it('栏头计数与可见集合长度一致（横幅 / 计数 / 渲染三者同源）', () => {
    const agg = twoAgentAggregate()
    const all = selectInputEntries(agg, null)
    expect(all).toHaveLength(agg.inputs.totalItems)
    // 选中 c1 后，可见条目数 == 该 Agent 分组内条目数
    const onlyChild = selectInputEntries(agg, 'c1')
    expect(onlyChild).toHaveLength(selectInputGroups(agg, 'c1')[0]?.entries.length ?? -1)
    expect(onlyChild).toHaveLength(1)
  })

  it('文件树筛选与条目筛选同源：两者都按 selectedAgentKey 收敛', () => {
    const tree: FileTreeNode[] = [
      {
        name: 'src', path: 'src', type: 'dir', agents: ['main', 'c1'],
        children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', agents: ['main'] }],
      },
    ]
    const agg = twoAgentAggregate()
    agg.outputs.files = tree
    // 该断言固定「条目集合按 Agent 收敛」这一半，树的收敛由 filterTree 保证（E6 已覆盖）
    expect(selectInputEntries(agg, 'c1').every(entry => entry.item.agentKey === 'c1')).toBe(true)
    expect(selectProcessSegments(agg, 'c1').every(segment => segment.agentKey === 'c1')).toBe(true)
  })
})

// ============================================================
// 端到端：用真实 host 聚合输出驱动横幅分派
//
// 真实会话里 budgets 全为 false（28 个可用会话无一触发超限），「全局类横幅只在
// 『全部 Agent』视图显示」这条逻辑在真实数据上验证不到，故在此用超预算的
// 合成会话端到端覆盖：host 聚合 → selectors 分派 → 切换 Agent 后横幅消失。
// ============================================================

/** 构造引擎：主会话 + 若干一级子会话（事件数组已固化，seq/时间不漂移）。 */
function hostEngine(
  mainEvents: AggregatorEvent[],
  children: Record<string, AggregatorEvent[]> = {},
): AggregatorEngine {
  const childIds = Object.keys(children)
  const headerOf = (id: string): AggregatorSessionHeader => (
    id === 'main'
      ? { id: 'main', cwd: '/ws' }
      : { id, cwd: '/ws', parentSession: 'main', origin: 'subagent' }
  )
  return {
    readSession: async id => ({
      session: headerOf(id),
      events: id === 'main' ? mainEvents : (children[id] ?? []),
    }),
    traceSession: async () => ({
      target: { header: headerOf('main') },
      descendants: childIds.map(id => ({ session: { header: headerOf(id) }, descendants: [] })),
    }),
  }
}

const userMessage = (seq: number, time: number, text: string): AggregatorEvent => ({
  type: 'user/message', seq, time,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})

const say = (seq: number, time: number, turn: number, text: string): AggregatorEvent => ({
  type: 'assistant/message', seq, time,
  data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

/** 端到端取某视图下的横幅 key 列表（可见集合含过程段，模拟开关已打开）。 */
function bannerKeys(aggregate: ContextAggregate, selectedAgentKey: string | null): string[] {
  const segments = selectedAgentKey === null
    ? [...selectFinalSegments(aggregate, selectedAgentKey), ...selectProcessSegments(aggregate, selectedAgentKey)]
    : selectFinalSegments(aggregate, selectedAgentKey)
  return selectBanners(
    aggregate,
    selectedAgentKey,
    selectVisibleTruncation(selectInputEntries(aggregate, selectedAgentKey), segments),
  ).map(banner => banner.key)
}

describe('端到端 · 全局类横幅只在「全部 Agent」视图显示', () => {
  it('输入条目超 MAX_INPUT_ITEMS：inputsTruncated 置位，切到子 Agent 后横幅消失', async () => {
    const events = Array.from(
      { length: MAX_INPUT_ITEMS + 5 },
      (_, index) => userMessage(index + 1, index + 1, `q-${String(index)}`),
    )
    const engine = hostEngine(events, { c1: [userMessage(1, 1, '子 Agent 的委派')] })
    const { aggregate } = await aggregateContext(engine, 'main')

    // 前置条件：全局事实确实成立（不是拿字面量假装）
    expect(aggregate.budgets.inputsTruncated).toBe(true)
    expect(aggregate.inputs.userItems).toHaveLength(MAX_INPUT_ITEMS + 1)

    expect(bannerKeys(aggregate, null)).toContain('banner.truncated.inputs')
    // 核心断言：选中单个 Agent 后，全局类横幅不再显示
    expect(bannerKeys(aggregate, 'c1')).not.toContain('banner.truncated.inputs')
    expect(bannerKeys(aggregate, 'c1')).toEqual([])
  })

  it('输出段超 MAX_OUTPUT_SEGMENTS：outputsTruncated 与 droppedOutputSegments 置位，切到 Agent 后横幅消失', async () => {
    const events = Array.from(
      { length: MAX_OUTPUT_SEGMENTS + 5 },
      (_, index) => say(index + 1, index + 1, index + 1, `seg-${String(index)}`),
    )
    const engine = hostEngine(events, { c1: [say(1, 1, 1, '子 Agent 结论')] })
    const { aggregate } = await aggregateContext(engine, 'main')

    expect(aggregate.budgets.outputsTruncated).toBe(true)
    expect(aggregate.budgets.droppedOutputSegments).toBe(5)

    expect(bannerKeys(aggregate, null)).toContain('banner.truncated.outputs')
    // 主 Agent 视图下同样不显示全局类（筛选语义是「过滤块」，不限是不是 main）
    expect(bannerKeys(aggregate, 'main')).not.toContain('banner.truncated.outputs')
    expect(bannerKeys(aggregate, 'c1')).toEqual([])
  })

  it('子会话数超 MAX_CHILD_SESSIONS：降级横幅只在全部视图出现', async () => {
    const children = Object.fromEntries(
      Array.from({ length: MAX_CHILD_SESSIONS + 2 }, (_, index) => [
        `c${String(index).padStart(3, '0')}`,
        [say(1, 1, 1, `c${String(index)} 结论`)],
      ]),
    )
    const engine = hostEngine([], children)
    const { aggregate } = await aggregateContext(engine, 'main')

    expect(aggregate.budgets.childrenTotal).toBe(MAX_CHILD_SESSIONS + 2)
    expect(aggregate.budgets.childrenScanned).toBe(MAX_CHILD_SESSIONS)
    expect(bannerKeys(aggregate, null)).toContain('banner.truncated.children')
    expect(bannerKeys(aggregate, 'c000')).toEqual([])
  })
})

describe('端到端 · 可见类横幅跟随筛选后的集合', () => {
  it('主 Agent 输入被 4KB 截断：全部视图提示，切到子 Agent 后不提示', async () => {
    const long = 'x'.repeat(5_000)
    const engine = hostEngine(
      [userMessage(1, 1, long)],
      { c1: [userMessage(2, 2, '子 Agent 的短委派')] },
    )
    const { aggregate } = await aggregateContext(engine, 'main')

    // budgets 全为 false：可见类横幅**不能**靠 budgets 判出来，只能靠可见集合
    expect(aggregate.budgets).toMatchObject({
      inputsTruncated: false,
      outputsTruncated: false,
      droppedOutputSegments: 0,
    })
    // 但截断信号确实存在于条目自身字段上
    expect(aggregate.inputs.userItems.find(item => item.agentKey === 'main')?.textTruncated).toBe(true)

    expect(bannerKeys(aggregate, null)).toEqual(['banner.truncated.text'])
    // 切到子 Agent：可见集合里没有任何被截断的条目 → 提示消失
    expect(bannerKeys(aggregate, 'c1')).toEqual([])
    // 切到主 Agent：仍然提示（它自己的条目就是被截断的那条）
    expect(bannerKeys(aggregate, 'main')).toEqual(['banner.truncated.text'])
  })

  it('过程段被 4KB 截断：仅在「显示过程输出」打开、该段进入可见集合时才提示', async () => {
    const long = 'y'.repeat(5_000)
    const engine = hostEngine([say(1, 1, 1, long), say(2, 2, 2, '收尾结论')])
    const { aggregate } = await aggregateContext(engine, 'main')

    const process = selectProcessSegments(aggregate, null)
    expect(process).toHaveLength(1)
    expect(process[0]?.textTruncated).toBe(true)
    expect(process[0]?.previewOnly).toBe(true)

    // 过程段默认不展示 → 不在可见集合 → 不提示
    const hidden = selectVisibleTruncation(selectInputEntries(aggregate, null), selectFinalSegments(aggregate, null))
    expect(hidden.anyTextTruncated).toBe(false)
    // 开关打开后过程段进入可见集合 → 提示出现（「可见类跟随视图」的直接体现）
    const shown = selectVisibleTruncation(
      selectInputEntries(aggregate, null),
      [...selectFinalSegments(aggregate, null), ...process],
    )
    expect(shown.anyTextTruncated).toBe(true)
  })
})
