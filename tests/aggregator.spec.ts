/**
 * 聚合器单元测试：输入分类、部分读计数口径、write 兜底、Agent 归属、
 * 预算降级（设计文档 §3.7 / §7.4 / 任务 #3）。
 */

import { describe, expect, it } from 'vitest'
import { aggregateContext, type AggregatorEngine, type AggregatorEvent, type AggregatorLineageNode, type AggregatorSessionHeader } from '../src/host/aggregator.ts'
import { TEXT_TRUNCATE_BYTES } from '../src/shared/constants.ts'

const CWD = '/ws'
const T0 = 1_700_000_000_000

/** 构造事件（seq 自动递增）。 */
function makeEvents(defs: Array<[type: string, data: unknown]>): AggregatorEvent[] {
  return defs.map(([type, data], index) => ({ type, seq: index + 1, time: T0 + index, data }))
}

/** 事件速记。 */
const turnStart = (turn: number): [string, unknown] => ['turn/start', { turn }]
const userMsg = (text: string, extra: Record<string, unknown> = {}): [string, unknown] => [
  'user/message',
  { content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra },
]
const pluginMsg = (source: Record<string, unknown>): [string, unknown] => [
  'user/message',
  { content: [{ type: 'text', text: 'injected' }], source: { kind: 'plugin', ...source } },
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
const assistantMsg = (turn: number, text: string, interrupted?: true): [string, unknown] => [
  'assistant/message',
  { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...interrupted === true ? { interrupted: true } : {} },
]

/** 构造假引擎。 */
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
    // 基座 SessionLineageTrace.target 是 SessionRecord（.header 直挂）
    traceSession: async id => ({ target: { header: sessions[id]?.header ?? { id } }, descendants: (childrenOf[id] ?? []).map(node) }),
  }
}

describe('aggregateContext · 输入分类', () => {
  it('user/message 按 source.kind 分流：user → 时间线，plugin → 注入折叠区', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          turnStart(1),
          userMsg('请总结这个项目'),
          pluginMsg({ plugin: 'p1', form: 'snapshot', sections: [{ name: 'x', text: '读取 docs/guide.md' }] }),
          pluginMsg({ plugin: 'p2', form: 'notice', summary: 'AGENTS.md 变更' }),
        ]),
      },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.inputs.userItems).toHaveLength(1)
    expect(aggregate.inputs.userItems[0]?.text).toBe('请总结这个项目')
    expect(aggregate.inputs.userItems[0]?.turn).toBe(1)
    expect(aggregate.inputs.userItems[0]?.agentKey).toBe('main')
    expect(aggregate.inputs.pluginItems).toHaveLength(2)
    expect(aggregate.inputs.pluginItems[0]?.form).toBe('snapshot')
    // snapshot 逐段提取：注入文件树收录 docs/guide.md
    expect(aggregate.inputs.pluginItems[0]?.filePaths).toEqual(['docs/guide.md'])
    expect(aggregate.inputs.pluginItems[1]?.form).toBe('notice')
    expect(aggregate.inputs.pluginItems[1]?.summary).toBe('AGENTS.md 变更')
    // injectTree 是树：docs/guide.md 挂在 docs 目录节点下，需展平后比对
    const injectPaths = [...flattenFiles(aggregate.inputs.injectTree).keys()]
    expect(injectPaths).toContain('docs/guide.md')
    expect(injectPaths).toContain('AGENTS.md')
  })

  it('附件：image 块投影为 AttachmentRef（基座附件无文件路径，仅展示名）', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          ['user/message', {
            content: [
              { type: 'text', text: '看这张图' },
              { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: 'shot.png' } },
            ],
            source: { kind: 'user' },
          }],
        ]),
      },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.inputs.userItems[0]?.attachments).toEqual([{ name: 'shot.png', mediaType: 'image/png' }])
  })
})

describe('aggregateContext · 参考计数口径', () => {
  it('read：meta.path（绝对展示路径）优先，回落 arguments.file_path；重复读累计 ×N', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          toolCall(1, 'c1', 'read', { file_path: 'src/a.ts' }),
          toolResult(1, 'c1', { path: `${CWD}/src/a.ts`, offset: 1, lines: [], totalLines: 10 }),
          toolCall(2, 'c2', 'read', { file_path: 'src/a.ts', offset: 3, limit: 5 }), // 部分读：仍 +1
          toolResult(2, 'c2', { path: `${CWD}/src/a.ts`, offset: 3, lines: [], totalLines: 10 }),
          toolCall(3, 'c3', 'read', { file_path: 'src/fallback.ts' }),
          toolResult(3, 'c3', undefined), // meta 缺失 → 回落 arguments
        ]),
      },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.references.totalFiles).toBe(2)
    expect(aggregate.references.totalViews).toBe(3)
    const flat = flattenFiles(aggregate.references.tree)
    expect(flat.get('src/a.ts')?.viewCount).toBe(2)
    expect(flat.get('src/fallback.ts')?.viewCount).toBe(1)
  })

  it('read_image 无 meta.path（实证）：回落 arguments.file_path 计数', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          toolCall(1, 'c1', 'read_image', { file_path: 'img/p.png' }),
          toolResult(1, 'c1', undefined),
        ]),
      },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(flattenFiles(aggregate.references.tree).get('img/p.png')?.viewCount).toBe(1)
  })

  it('str_replace_editor 仅计 view；参数名是 path', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          toolCall(1, 'c1', 'str_replace_editor', { command: 'view', path: 'src/a.ts' }),
          toolResult(1, 'c1', undefined),
          toolCall(1, 'c2', 'str_replace_editor', { command: 'str_replace', path: 'src/b.ts', old_str: 'x', new_str: 'y' }),
          toolResult(1, 'c2', undefined),
        ]),
      },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    const refs = flattenFiles(aggregate.references.tree)
    expect(refs.get('src/a.ts')?.viewCount).toBe(1)
    expect(refs.has('src/b.ts')).toBe(false) // str_replace 归输出段
    expect(flattenFiles(aggregate.outputs.files).get('src/b.ts')?.outputOp).toBe('update')
  })

  it('失败结果（isError）不计参考；未配对调用不计数', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          toolCall(1, 'c1', 'read', { file_path: 'src/bad.ts' }),
          toolResult(1, 'c1', { path: `${CWD}/src/bad.ts` }, true),
          toolCall(1, 'c2', 'read', { file_path: 'src/orphan.ts' }),
          // c2 无 result
        ]),
      },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.references.totalFiles).toBe(0)
  })
})

describe('aggregateContext · 输出段', () => {
  it('write 新建文件：meta.diffs === []（架构师修正口径）→ create，路径从 arguments 兜底', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          toolCall(1, 'c1', 'write', { file_path: 'out/new.txt', content: 'hi' }),
          toolResult(1, 'c1', { diffs: [] }), // 新建：diffs 空
          toolCall(2, 'c2', 'write', { file_path: 'out/new.txt', content: 'hi2' }),
          toolResult(2, 'c2', { diffs: [{ path: 'out/new.txt', oldText: 'hi', newText: 'hi2' }] }), // 更新：diffs 非空
        ]),
      },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    const flat = flattenFiles(aggregate.outputs.files)
    expect(flat.size).toBe(1)
    // 同文件多次操作合并取最终态：create → update
    expect(flat.get('out/new.txt')?.outputOp).toBe('update')
  })

  it('edit 标 update；assistant/message 文字段轮次去重编号（round）', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          toolCall(1, 'c1', 'edit', { file_path: 'out/e.txt', old_string: 'a', new_string: 'b' }),
          toolResult(1, 'c1', { diffs: [{ path: 'out/e.txt', oldText: 'a', newText: 'b' }] }),
          assistantMsg(1, '第一轮答复'),
          assistantMsg(1, '第一轮步骤2'),
          assistantMsg(2, '第二轮答复', true),
        ]),
      },
    })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(flattenFiles(aggregate.outputs.files).get('out/e.txt')?.outputOp).toBe('update')
    expect(aggregate.outputs.textSegments).toHaveLength(3)
    expect(aggregate.outputs.textSegments.map(segment => segment.round)).toEqual([1, 1, 2])
    expect(aggregate.outputs.textSegments[2]?.interrupted).toBe(true)
  })

  it('单条文本按 UTF-8 字节截断：中文不膨胀、不切断代理对', async () => {
    // 阈值是 4KB **字节**。'中' 占 3 字节但只有 1 个 UTF-16 代码单元，
    // 若按 .length 截断，中文载荷会实际膨胀到约 3 倍且可能切在代理对中间。
    const LIMIT = TEXT_TRUNCATE_BYTES
    const chinese = '中'.repeat(2000) // 6000 字节 > 4096，但 length 2000 < 4096
    // 边界正好落在代理对中间：4094 个 'x' + 一个 emoji（4 字节）
    const emoji = `${'x'.repeat(LIMIT - 2)}😀`

    // 两段长文本分属主会话与子会话：这样两段都是各自 Agent 的**最终答复**，
    // 不会落到过程段上被 320B 预览裁剪（过程段裁剪另有专门用例覆盖）。
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([assistantMsg(1, chinese)]),
      },
      child1: {
        header: { id: 'child1', parentSession: 's1', origin: 'subagent' },
        events: makeEvents([assistantMsg(2, emoji)]),
      },
    }, { s1: ['child1'] })
    const { aggregate, outputFullTexts } = await aggregateContext(engine, 's1')

    expect(aggregate.outputs.textSegments.every(segment => segment.kind === 'final')).toBe(true)
    expect(aggregate.outputs.processCount).toBe(0)

    const zh = aggregate.outputs.textSegments[0]
    expect(zh?.textTruncated).toBe(true)
    // 截断副本按字节不超阈值（旧实现这里根本不会截断：length 2000 < 4096）
    expect(Buffer.byteLength(zh?.text ?? '', 'utf-8')).toBeLessThanOrEqual(LIMIT)
    expect(Buffer.byteLength(zh?.text ?? '', 'utf-8')).toBeGreaterThan(LIMIT - 8) // 贴近阈值，不是象征性切一刀
    // 全文侧信道按 **id** 索引（§1.3），不再是下标对齐数组
    expect(outputFullTexts.get(zh?.id ?? '')).toBe(chinese)

    const em = aggregate.outputs.textSegments[1]
    expect(em?.textTruncated).toBe(true)
    // emoji 放不下就整对丢弃：不能留下半个代理对，也不能变成替换字符
    expect(em?.text).toBe('x'.repeat(LIMIT - 2))
    expect(em?.text).not.toMatch(/[\uD800-\uDFFF]/)
    expect(em?.text).not.toContain('�')
  })

  it('多 Agent 交错时间线：outputFullTexts 按 id 取到的永远是该段自己的全文', async () => {
    // 回归：子 Agent 的输出落在主会话两条输出之间——最常见的多 Agent 形态。
    // 合并序是「主全部段 → 子全部段」= [MAIN-FIRST, MAIN-SECOND, CHILD-MIDDLE]，
    // 展示序按时间重排后是 [MAIN-FIRST, CHILD-MIDDLE, MAIN-SECOND]。
    // v1.0 的「segments 与 segmentFullTexts 配对排序」就是在守这条约束（下标耦合），
    // id 化之后该约束从代码里消失，端点不可能再取错段。
    //
    // 正文刻意超过 4KB：这样「段内截断副本」与「全文」内容不同，
    // 一旦取错段就会被断言抓住，而不是两者恰好相等而漏过。
    const long = (marker: string): string => `${marker}\n${'x'.repeat(5000)}`
    const ev = (seq: number, time: number, turn: number, text: string): AggregatorEvent => ({
      type: 'assistant/message',
      seq,
      time,
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: [ev(1, 1000, 1, long('MAIN-FIRST')), ev(3, 3000, 2, long('MAIN-SECOND'))],
      },
      child1: {
        header: { id: 'child1', parentSession: 's1', origin: 'subagent' },
        events: [ev(2, 2000, 1, long('CHILD-MIDDLE'))],
      },
    }, { s1: ['child1'] })

    const { aggregate, outputFullTexts } = await aggregateContext(engine, 's1')

    // 展示序按时间：子会话输出插在主会话两条之间
    const markers = aggregate.outputs.textSegments.map(segment => segment.text.split('\n')[0])
    expect(markers).toEqual(['MAIN-FIRST', 'CHILD-MIDDLE', 'MAIN-SECOND'])

    // 全文侧信道与段一一对应：Map 的 key 集合 == 全部段 id，且每个 id 取到的
    // 全文就是该段自己的（用例意图「端点不会取错段」保留并加强）
    expect(outputFullTexts.size).toBe(aggregate.outputs.textSegments.length)
    expect([...outputFullTexts.keys()].sort()).toEqual(aggregate.outputs.textSegments.map(segment => segment.id).sort())
    for (const segment of aggregate.outputs.textSegments) {
      const full = outputFullTexts.get(segment.id) ?? ''
      expect(full.startsWith(segment.text.split('\n')[0] ?? '')).toBe(true)
      // 全文必须是未截断版本：比段内 4KB 副本长
      expect(full.length).toBeGreaterThan(segment.text.length)
    }
    // 关键断言：时间序第 2 段是子会话那段，按它的 id 取到的也是它的正文
    const middle = aggregate.outputs.textSegments[1]
    expect(middle?.text.split('\n')[0]).toBe('CHILD-MIDDLE')
    expect(outputFullTexts.get(middle?.id ?? '')?.startsWith('CHILD-MIDDLE')).toBe(true)
    expect(aggregate.outputs.textSegments[1]?.textTruncated).toBe(true)
  })
})

describe('aggregateContext · Agent 归属与预算', () => {
  it('子会话：descriptor.label 推导链 + 工具计数跨 Agent 合并（主在前）', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1', agentPreset: 'standard' },
        events: makeEvents([
          toolCall(1, 'c1', 'read', { file_path: 'src/a.ts' }),
          toolResult(1, 'c1', { path: `${CWD}/src/a.ts` }),
        ]),
      },
      child1: {
        header: { id: 'child1', parentSession: 's1', origin: 'subagent', delegationDepth: 1, agentPreset: 'reviewer' },
        events: makeEvents([
          ['subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'p', label: '评审员' }],
          toolCall(1, 'd1', 'read', { file_path: 'src/a.ts' }),
          toolResult(1, 'd1', { path: `${CWD}/src/a.ts` }),
          toolCall(1, 'd2', 'read', { file_path: 'src/child-only.ts' }),
          toolResult(1, 'd2', { path: `${CWD}/src/child-only.ts` }),
        ]),
      },
    }, { s1: ['child1'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.agents).toHaveLength(2)
    expect(aggregate.agents[0]).toMatchObject({ agentKey: 'main', role: 'main' })
    // 非 Team：descriptor.label「评审员」是任务描述 → 只作 hover，展示名为「子Agent · child1」
    expect(aggregate.agents[1]).toMatchObject({ agentKey: 'child1', label: '子Agent · child1', title: '评审员', role: 'subagent', delegationDepth: 1 })
    const flat = flattenFiles(aggregate.references.tree)
    expect(flat.get('src/a.ts')?.viewCount).toBe(2)
    expect(flat.get('src/a.ts')?.agents).toEqual(['main', 'child1'])
    expect(flat.get('src/child-only.ts')?.agents).toEqual(['child1'])
    expect(aggregate.budgets.childrenScanned).toBe(1)
    expect(aggregate.budgets.childrenTotal).toBe(1)
  })

  it('label 推导链：非 Team 无短名（非降级）→ 统一「子Agent · sessionId 短码」', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: [] },
      'child-aaaa-bbbb': { header: { id: 'child-aaaa-bbbb', origin: 'subagent', agentPreset: 'coder' }, events: makeEvents([]) },
      'child-cccc-dddd': { header: { id: 'child-cccc-dddd', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['child-aaaa-bbbb', 'child-cccc-dddd'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    const badges = aggregate.agents.filter(badge => badge.role === 'subagent')
    expect(badges[0]?.label).toBe('子Agent · child-aa')
    expect(badges[1]?.label).toBe('子Agent · child-cc')
  })

  it('标签冲突消解：同名子 Agent 追加 sessionId 短码，唯一的不动', async () => {
    // 真实 12-Agent 会话的实测形态：5 个子 Agent 都是 agentPreset='standard'
    // 且没有 descriptor.label → 下拉里 5 条一模一样，无从分辨。
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: [] },
      a17c3f2b: { header: { id: 'a17c3f2b', parentSession: 's1', origin: 'subagent', agentPreset: 'standard' }, events: makeEvents([]) },
      b28d4e6c: { header: { id: 'b28d4e6c', parentSession: 's1', origin: 'subagent', agentPreset: 'standard' }, events: makeEvents([]) },
      c39e5f7d: { header: { id: 'c39e5f7d', parentSession: 's1', origin: 'subagent', agentPreset: 'standard' }, events: makeEvents([]) },
      reviewer9: { header: { id: 'reviewer9', parentSession: 's1', origin: 'subagent', agentPreset: 'reviewer' }, events: makeEvents([]) },
    }, { s1: ['a17c3f2b', 'b28d4e6c', 'c39e5f7d', 'reviewer9'] })
    const { aggregate } = await aggregateContext(engine, 's1')

    const byKey = new Map(aggregate.agents.map(badge => [badge.agentKey, badge.label]))
    // 主 Agent 不参与消解（全局唯一，展示名由 client locale 化）
    expect(byKey.get('main')).toBe('main')
    // 无短名的非 Team 子 Agent：无条件挂各自 sessionId 短码
    expect(byKey.get('a17c3f2b')).toBe('子Agent · a17c3f2b')
    expect(byKey.get('b28d4e6c')).toBe('子Agent · b28d4e6c')
    expect(byKey.get('c39e5f7d')).toBe('子Agent · c39e5f7d')
    // 即便 agentPreset 存在，无短名也统一回落「子Agent · sessionId」
    expect(byKey.get('reviewer9')).toBe('子Agent · reviewer')
    // 消解后无重名
    const labels = aggregate.agents.map(badge => badge.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('标签冲突消解：非 Team 子 Agent 一律「子Agent · 短码」；前 8 位相同则放宽位数', async () => {
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: [] },
      // 两条 descriptor.label 都是「评审员」（= 任务描述，只作 hover，不进展示名）
      aaaaaaaa: { header: { id: 'aaaaaaaa', parentSession: 's1', origin: 'subagent' }, events: makeEvents([['subagent/descriptor', { label: '评审员' }]]) },
      bbbbbbbb: { header: { id: 'bbbbbbbb', parentSession: 's1', origin: 'subagent' }, events: makeEvents([['subagent/descriptor', { label: '评审员' }]]) },
      // 无 descriptor/agentPreset
      'child-030': { header: { id: 'child-030', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
      'child-031': { header: { id: 'child-031', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
      'child-033': { header: { id: 'child-033', parentSession: 's1', origin: 'subagent' }, events: makeEvents([]) },
    }, { s1: ['aaaaaaaa', 'bbbbbbbb', 'child-030', 'child-031', 'child-033'] })
    const { aggregate } = await aggregateContext(engine, 's1')

    const byKey = new Map(aggregate.agents.map(badge => [badge.agentKey, badge.label]))
    // 非 Team 一律「子Agent · sessionId 短码」
    expect(byKey.get('aaaaaaaa')).toBe('子Agent · aaaaaaaa')
    expect(byKey.get('bbbbbbbb')).toBe('子Agent · bbbbbbbb')
    // 前 8 位 'child-03' 三者相同 → 自动放宽到能区分开的最短前缀
    expect(byKey.get('child-030')).toBe('子Agent · child-030')
    expect(byKey.get('child-031')).toBe('子Agent · child-031')
    expect(byKey.get('child-033')).toBe('子Agent · child-033')
    // 同名任务描述只留在 hover，不参与展示名（故两条 label 不冲突）
    const byBadge = new Map(aggregate.agents.map(badge => [badge.agentKey, badge]))
    expect(byBadge.get('aaaaaaaa')?.title).toBe('评审员')
    expect(byBadge.get('bbbbbbbb')?.title).toBe('评审员')
    expect(new Set(aggregate.agents.map(badge => badge.label)).size).toBe(aggregate.agents.length)
  })

  it('单子会话事件超 20k：该子会话 degraded（仅徽标，无明细）', async () => {
    const flood: Array<[string, unknown]> = Array.from({ length: 20_001 }, (_, index) => ['step/start', { turn: index, step: 1 }]) as Array<[string, unknown]>
    const engine = makeEngine({
      s1: { header: { id: 's1' }, events: makeEvents([]) },
      big: {
        header: { id: 'big', origin: 'subagent', agentPreset: 'worker' },
        events: makeEvents([...flood, toolCall(1, 'x1', 'read', { file_path: 'src/never.ts' }), toolResult(1, 'x1', { path: `${CWD}/src/never.ts` })]),
      },
    }, { s1: ['big'] })
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.agents[1]).toMatchObject({ agentKey: 'big', degraded: true })
    expect(aggregate.references.totalFiles).toBe(0) // 明细被丢弃
    expect(aggregate.budgets.childrenScanned).toBe(0) // degraded 不计为已扫描
  })

  it('子会话数超 32：只扫前 32 个，其余仅徽标 degraded；childrenTotal 照实', async () => {
    const children = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`c${String(index).padStart(2, '0')}`, { header: { id: `c${String(index).padStart(2, '0')}`, origin: 'subagent' }, events: makeEvents([]) }]),
    )
    const engine = makeEngine(
      { s1: { header: { id: 's1' }, events: [] }, ...children },
      { s1: Object.keys(children) },
    )
    const { aggregate } = await aggregateContext(engine, 's1')
    expect(aggregate.agents).toHaveLength(41)
    expect(aggregate.budgets.childrenScanned).toBe(32)
    expect(aggregate.budgets.childrenTotal).toBe(40)
    const degradedCount = aggregate.agents.filter(badge => badge.degraded === true).length
    expect(degradedCount).toBe(8)
  })

  it('三棵文件树都带 agents（§3.3 共用字段）：按 Agent 筛选不会清空注入树/输出树', async () => {
    // clients 的 filterTree 按 node.agents 过滤；任一棵树缺 agents 就会被整棵清空。
    const injectMsg = (text: string, plugin: string): [string, unknown] => [
      'user/message',
      { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } },
    ]
    const engine = makeEngine({
      s1: {
        header: { id: 's1' },
        events: makeEvents([
          injectMsg('读取 docs/guide.md', 'p-main'),
          toolCall(1, 'w1', 'write', { file_path: 'out/shared.txt', content: 'a' }),
          toolResult(1, 'w1', { diffs: [] }),
          toolCall(1, 'w2', 'write', { file_path: 'out/main-only.txt', content: 'a' }),
          toolResult(1, 'w2', { diffs: [] }),
        ]),
      },
      child1: {
        header: { id: 'child1', parentSession: 's1', origin: 'subagent' },
        events: makeEvents([
          injectMsg('读取 src/b.md', 'p-child'),
          toolCall(1, 'w3', 'write', { file_path: 'out/shared.txt', content: 'b' }),
          toolResult(1, 'w3', { diffs: [] }),
        ]),
      },
    }, { s1: ['child1'] })

    const { aggregate } = await aggregateContext(engine, 's1')
    const injectTree = flattenFiles(aggregate.inputs.injectTree)
    expect(injectTree.get('docs/guide.md')?.agents).toEqual(['main'])
    expect(injectTree.get('src/b.md')?.agents).toEqual(['child1'])

    const outTree = flattenFiles(aggregate.outputs.files)
    expect(outTree.get('out/main-only.txt')?.agents).toEqual(['main'])
    // 同一文件主与子都写过：最终态取后写，贡献者归集全部且主在前
    expect(outTree.get('out/shared.txt')?.agents).toEqual(['main', 'child1'])
  })
})

/** 展平文件树为 path → node 映射。 */
function flattenFiles(nodes: readonly import('../src/shared/types.ts').FileTreeNode[]): Map<string, import('../src/shared/types.ts').FileTreeNode> {
  const map = new Map<string, import('../src/shared/types.ts').FileTreeNode>()
  const walk = (list: readonly import('../src/shared/types.ts').FileTreeNode[]): void => {
    for (const node of list) {
      if (node.type === 'file') map.set(node.path, node)
      else walk(node.children ?? [])
    }
  }
  walk(nodes)
  return map
}
