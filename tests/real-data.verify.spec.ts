/**
 * A. 真实数据实测（QA 独立验证）。
 *
 * 输入全部取自基座仓库 deepseek-harness 的真实 session.jsonl，不做任何
 * 「为了让断言好写」的裁剪：引擎形状对齐 SessionQueryEngine 的
 * readSession / traceSession 返回结构。
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggregateContext } from '../src/host/aggregator.ts'
import { dispatchCtxApi } from '../src/host/api.ts'
import { extractInjectFilePaths } from '../src/shared/extract.ts'
import { PROCESS_PREVIEW_BYTES } from '../src/shared/constants.ts'
import type { FileTreeNode } from '../src/shared/types.ts'
import {
  BASE_AVAILABLE,
  BASE_ROOT,
  loadSessionLog,
  makeRealEngine,
  PREVIEW_DIR,
  type LoadedSession,
} from './real-log.verify.helper.ts'

const SNAPSHOT_ROOT = join(BASE_ROOT, 'snapshots')
const preview = (name: string): LoadedSession => loadSessionLog(join(PREVIEW_DIR, name, 'session.jsonl'))
const snapshot = (name: string): LoadedSession => loadSessionLog(join(SNAPSHOT_ROOT, name, 'session.jsonl'))

/** 在树里按 path 找文件节点（深度优先）。 */
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

const suite = BASE_AVAILABLE ? describe : describe.skip

suite('A1 · 真实主会话 + 两个子 Agent 会话（preview-showcase 谱系）', () => {
  it('输入分类：29 条真人提示归 userItems，pluginItems 为空，子会话条目并入', async () => {
    const main = preview('preview-showcase')
    const followUp = preview('preview-follow-up-builder')
    const review = preview('preview-architecture-review')
    const engine = makeRealEngine([main, followUp, review])

    const { aggregate } = await aggregateContext(engine, 'preview-showcase')

    // 主 29 + 子 29 + 子 1 = 59 条真人提示；这份日志里没有 source.kind='plugin' 的注入
    expect(aggregate.inputs.userItems).toHaveLength(59)
    expect(aggregate.inputs.pluginItems).toHaveLength(0)
    // 主会话与 architecture-review 各 28 条「History checkpoint NN」+ 1 条收尾提问；
    // follow-up-builder 是独立的一句
    expect(aggregate.inputs.userItems.filter(item => item.text.startsWith('History checkpoint'))).toHaveLength(56)
    expect(aggregate.inputs.userItems.some(item => item.text.startsWith('Show the seeded workspace'))).toBe(true)
    expect(aggregate.inputs.userItems.some(item => item.text.startsWith('Review whether the preview fixture'))).toBe(true)
    expect(aggregate.inputs.userItems.some(item => item.text.startsWith('Check that the Preview workspace'))).toBe(true)
    // 归属：主 29 条 agentKey='main'
    expect(aggregate.inputs.userItems.filter(item => item.agentKey === 'main')).toHaveLength(29)
    expect(aggregate.inputs.userItems.filter(item => item.agentKey === 'preview-architecture-review')).toHaveLength(29)
    expect(aggregate.inputs.userItems.filter(item => item.agentKey === 'preview-follow-up-builder')).toHaveLength(1)
    // 跨会话合并后按时间升序（主会话时间线在前）
    const times = aggregate.inputs.userItems.map(item => item.time)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('参考段：PREVIEW.md 计 1 次；失败 read（missing.txt，isError）不计入', async () => {
    const engine = makeRealEngine([preview('preview-showcase')])
    const { aggregate } = await aggregateContext(engine, 'preview-showcase')

    expect(aggregate.references.totalFiles).toBe(1)
    expect(aggregate.references.totalViews).toBe(1)
    const node = findFile(aggregate.references.tree, 'PREVIEW.md')
    expect(node).toMatchObject({ name: 'PREVIEW.md', type: 'file', viewCount: 1, agents: ['main'] })
    expect(findFile(aggregate.references.tree, 'missing.txt')).toBeUndefined()
    // bash / glob / grep / web_search / todo_write 都不是参考操作
    expect(aggregate.references.tree.map(n => n.path)).toEqual(['PREVIEW.md'])
  })

  it('输出段：write 覆盖已有文件（meta.diffs 非空）→ update；bash 等工具不进输出树', async () => {
    const engine = makeRealEngine([preview('preview-showcase')])
    const { aggregate } = await aggregateContext(engine, 'preview-showcase')

    expect(aggregate.outputs.totalFiles).toBe(1)
    const node = findFile(aggregate.outputs.files, 'src/preview.ts')
    expect(node).toMatchObject({ path: 'src/preview.ts', type: 'file', outputOp: 'update' })
    // 原始日志 30 段 assistant/message（29 轮 + turn 29 step 2），其中 1 段正文为空
    // （纯工具调用产生的空 assistant/message）→ 按规则 F1 扫描期即剔除，故为 29 段。
    expect(aggregate.outputs.textSegments).toHaveLength(29)
    expect(aggregate.outputs.textSegments.at(-1)?.text).toContain('Preview tour complete')
    // round 按 turn 首现编号：末段与 turn 29 同轮
    expect(aggregate.outputs.textSegments.at(-1)?.round).toBe(29)
    expect(aggregate.outputs.textSegments[0]?.round).toBe(1)
  })

  it('最终答复投影：main 的最终答复 = 时间序最后一段非空文本；过程段数与数组自洽', async () => {
    const base = preview('preview-showcase')
    // 真实日志里每段都很短（不足 320B），补一段长输出用于覆盖「过程段预览裁剪」：
    // 长段之后再来一段短的，长段就落到过程段上，短段成为最终答复。
    const longText = 'L'.repeat(2_000)
    // 追加事件必须排在真实日志**之后**（seq 与时间都取真实最大值 +1），
    // 否则合并排序会把它插到真实输出中间，末尾结论就不是它了
    const maxSeq = base.events.reduce((max, event) => Math.max(max, event.seq), 0)
    const maxTime = base.events.reduce((max, event) => Math.max(max, event.time), 0)
    const tail = [
      { type: 'assistant/message', seq: maxSeq + 1, time: maxTime + 1, data: { turn: 90, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] } } },
      { type: 'assistant/message', seq: maxSeq + 2, time: maxTime + 2, data: { turn: 91, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '补一条收尾结论' }] } } },
    ]
    const engine = makeRealEngine([{ header: base.header, events: [...base.events, ...tail] }])
    const { aggregate, outputFullTexts } = await aggregateContext(engine, 'preview-showcase')

    // 单 Agent：1 段 final + 29 段 process（29 段真实非空 + 补的长段 = 30 段，末段为 final）
    const finals = aggregate.outputs.finalByAgent
    expect(finals).toHaveLength(1)
    expect(finals[0]?.agentKey).toBe('main')
    expect(finals[0]?.processCount).toBe(30)
    expect(finals[0]?.segment?.text).toBe('补一条收尾结论')
    expect(finals[0]?.segment?.kind).toBe('final')
    expect(finals[0]?.segment?.previewOnly).toBe(false)
    expect(aggregate.outputs.processCount).toBe(30)

    // kind 标记与数组自洽：final 数 + process 数 == 总段数
    const processSegments = aggregate.outputs.textSegments.filter(segment => segment.kind === 'process')
    expect(processSegments).toHaveLength(aggregate.outputs.processCount)
    // 过程段正文一律不超过 PROCESS_PREVIEW_BYTES 预览阈值
    expect(processSegments.every(segment => Buffer.byteLength(segment.text, 'utf-8') <= PROCESS_PREVIEW_BYTES)).toBe(true)
    // 被标记为预览的段，其预览必然短于全文（全文经端点按 id 取回）
    const previewed = processSegments.filter(segment => segment.previewOnly)
    expect(previewed).toHaveLength(1)
    expect(outputFullTexts.get(previewed[0]?.id ?? '')).toBe(longText)
    // 正文本就不足阈值的段不做裁剪，也不置 previewOnly
    expect(processSegments.filter(segment => !segment.previewOnly)
      .every(segment => outputFullTexts.get(segment.id) === segment.text)).toBe(true)
    // 空文本段不产出段（规则 F1）
    expect(aggregate.outputs.textSegments.every(segment => segment.text.trim().length > 0)).toBe(true)
    // id 稳定且唯一
    expect(new Set(aggregate.outputs.textSegments.map(segment => segment.id)).size).toBe(31)
    expect(aggregate.outputs.textSegments[0]?.id).toBe(`preview-showcase:${String(aggregate.outputs.textSegments[0]?.seq ?? '')}`)
  })

  it('Agent 徽标：非 Team 子 Agent 展示名=子Agent·短码，descriptor.label 只作 hover；delegationDepth 透传', async () => {
    const engine = makeRealEngine([
      preview('preview-showcase'),
      preview('preview-follow-up-builder'),
      preview('preview-architecture-review'),
    ])
    const { aggregate } = await aggregateContext(engine, 'preview-showcase')

    expect(aggregate.agents).toHaveLength(3)
    expect(aggregate.agents[0]).toMatchObject({ agentKey: 'main', sessionId: 'preview-showcase', label: 'main', role: 'main' })
    const byKey = new Map(aggregate.agents.map(badge => [badge.agentKey, badge]))
    // 两个子会话的 agentPreset 都是 'standard'，descriptor.label 是任务描述文本 → 只作 hover。
    // 两者 sessionId 前 8 位同为 'preview-'，短码自动放宽到 9 位以区分。
    expect(byKey.get('preview-follow-up-builder')).toMatchObject({
      label: '子Agent · preview-f',
      title: 'Continue preview verification',
      role: 'subagent',
      delegationDepth: 1,
    })
    expect(byKey.get('preview-follow-up-builder')?.degraded).toBeUndefined()
    expect(byKey.get('preview-architecture-review')).toMatchObject({
      label: '子Agent · preview-a',
      title: 'Review preview architecture',
      role: 'subagent',
      delegationDepth: 1,
    })
    expect(aggregate.budgets).toMatchObject({ childrenScanned: 2, childrenTotal: 2 })
  })
})

suite('A2 · 真实系统注入（snapshot form + sections）与真人提示的二分', () => {
  it('source.kind=plugin 的快照注入归 pluginItems，并从 sections[].text 提取路径', async () => {
    const session = snapshot('sdk/text-turn')
    const engine = makeRealEngine([session])
    const { aggregate } = await aggregateContext(engine, 'snap-session-1')

    expect(aggregate.inputs.userItems).toHaveLength(1)
    expect(aggregate.inputs.userItems[0]).toMatchObject({ agentKey: 'main', text: 'Reply with exactly: SDK snapshot OK' })

    expect(aggregate.inputs.pluginItems).toHaveLength(1)
    const item = aggregate.inputs.pluginItems[0]
    expect(item).toMatchObject({
      agentKey: 'main',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
    })
    // snapshot form：text = 各 sections[].text 用空行拼接
    expect(item?.text).toContain('Current DSH file policy')
    expect(item?.text).toContain('Approval policy: ask')
    expect(item?.textTruncated).toBe(false)
  })

  it('注入路径提取不含噪声：URL / 纯数字 / 命令行 flag 被排除（纯函数级复核）', () => {
    // 真实注入正文里带 http URL 与版本号，确认不误收
    const paths = extractInjectFilePaths('snapshot', [
      'See https://example.com/docs/a/b.md and run --flag v1.2.3 then read `src/main.ts`',
    ])
    expect(paths).toEqual(['src/main.ts'])
  })

  it('注入路径提取不含噪声：真实 system-prompt 快照本体零路径（收紧前为 policy: 与 sandbox）', () => {
    // 上一条用例断言的正文即出自本条输入。收紧前这段真实快照会提取出
    // ['policy:', 'sandbox'] 两条假阳性（「file policy:」「file sandbox」被动词模式误捕），
    // 收紧后必须为空——§3.5 宁缺勿错：宁可漏，也不把非文件塞进注入文件树。
    const session = snapshot('sdk/text-turn')
    const injected = session.events
      .filter(event => event.type === 'user/message')
      .map(event => event.data)
      .filter(data => isPluginMessage(data))
    expect(injected.length).toBeGreaterThan(0) // 快照未漂移：确有一段 plugin 注入
    for (const data of injected) {
      const source = (data as { source?: { form?: string } }).source
      const content = (data as { content?: ReadonlyArray<{ text?: unknown }> }).content ?? []
      const texts = content
        .map(part => (typeof part.text === 'string' ? part.text : ''))
        .filter(text => text.length > 0)
      expect(extractInjectFilePaths(source?.form, texts)).toEqual([])
    }
  })
})

/** 事件 data 是否为 source.kind==='plugin' 的注入消息。 */
function isPluginMessage(data: unknown): boolean {
  const source = (data as { source?: { kind?: unknown } } | undefined)?.source
  return source?.kind === 'plugin'
}

suite('A3 · 真实 read_image（无 meta）与图片附件块', () => {
  it('read_image 走 arguments.file_path 兜底，计入参考树', async () => {
    const session = loadSessionLog(join(SNAPSHOT_ROOT, 'session/read-image/session.jsonl'), '/snapshots/ws')
    const engine = makeRealEngine([session])
    const { aggregate } = await aggregateContext(engine, 'snap-session-1')

    // meta.path 为绝对展示路径 {{cwd}}/red.png → 相对化后归并到同一条目
    expect(aggregate.references.totalFiles).toBe(1)
    const node = findFile(aggregate.references.tree, 'red.png')
    expect(node).toMatchObject({ path: 'red.png', viewCount: 1, agents: ['main'] })
  })

  it('图片附件块解析为 AttachmentRef（无 name 时回落 mediaType）', async () => {
    const session = snapshot('sdk/inline-image-prompt')
    const engine = makeRealEngine([session])
    const { aggregate } = await aggregateContext(engine, 'snap-session-1')

    const item = aggregate.inputs.userItems[0]
    expect(item?.attachments).toHaveLength(1)
    expect(item?.attachments[0]).toMatchObject({ name: 'image/png', mediaType: 'image/png' })
    // 两个 text 块按换行拼接
    expect(item?.text).toBe('Inspect this image, then reply with exactly \nthe single word DONE.')
  })
})

suite('A4 · 真实 str_replace_editor：view 计参考，create/str_replace 计输出', () => {
  it('create → create；view → 参考 +1；str_replace → update', async () => {
    const session = snapshot('sdk/persistent-tools')
    const engine = makeRealEngine([session])
    const { aggregate } = await aggregateContext(engine, 'snap-session-1')

    const node = findFile(aggregate.outputs.files, 'note.txt')
    expect(node).toMatchObject({ path: 'note.txt', outputOp: 'update' })
    // str_replace_editor 的 view 命令计入参考（参数名是 path 不是 file_path）
    expect(findFile(aggregate.references.tree, 'note.txt')).toMatchObject({ viewCount: 1 })
  })
})

suite('A5 · 部分读口径：同一文件每次调用 +1，失败调用不计数；write 新建标 create', () => {
  it('deleted.txt 成功 read ×1 + 失败 read（isError）+ write 空 diffs → create', async () => {
    const session = snapshot('session/fs-delete-recreate')
    const engine = makeRealEngine([session])
    const { aggregate } = await aggregateContext(engine, 'snap-session-1')

    // 两次 read 调用，其中一次 isError → 只计 1 次（不是 2 次，也不是按行加权）
    expect(findFile(aggregate.references.tree, 'deleted.txt')).toMatchObject({ viewCount: 1 })
    expect(aggregate.references.totalViews).toBe(1)
    // write 新建：meta.diffs === [] → create
    expect(findFile(aggregate.outputs.files, 'deleted.txt')).toMatchObject({ outputOp: 'create' })
  })

  it('同一文件连续 read 三次 → ×3（构造补齐：真实日志无 3 次同文件样本）', async () => {
    const base = snapshot('session/text-turn')
    const cwd = base.header.cwd ?? '/snapshots/ws'
    const calls = ['c1', 'c2', 'c3'].map((callId, index) => ({
      type: 'tool/call', seq: 900 + index * 2, time: 1_700_000_000_000 + index * 2,
      data: { callId, name: 'read', arguments: JSON.stringify({ file_path: `${cwd}/notes.txt` }) },
    }))
    const results = ['c1', 'c2', 'c3'].map((callId, index) => ({
      type: 'tool/result', seq: 901 + index * 2, time: 1_700_000_000_001 + index * 2,
      data: {
        message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', isError: false, content: [] }] },
        meta: { path: `${cwd}/notes.txt` },
      },
    }))
    const engine = makeRealEngine([{ header: base.header, events: [...base.events, ...calls, ...results] }])
    const { aggregate } = await aggregateContext(engine, 'snap-session-1')

    expect(findFile(aggregate.references.tree, 'notes.txt')).toMatchObject({ viewCount: 3 })
    expect(aggregate.references.totalViews).toBeGreaterThanOrEqual(3)
  })
})

suite('A6 · 契约序列化与输出最终态', () => {
  it('真实聚合结果可无损 JSON 往返（端点就是 JSON.stringify 出去的）', async () => {
    const engine = makeRealEngine([
      preview('preview-showcase'),
      preview('preview-follow-up-builder'),
      preview('preview-architecture-review'),
    ])
    const { aggregate } = await aggregateContext(engine, 'preview-showcase')
    const roundTrip = JSON.parse(JSON.stringify(aggregate)) as unknown
    expect(roundTrip).toEqual(aggregate)
    // 不得出现 undefined / Map / NaN 之类无法序列化的残余
    const serialized = JSON.stringify(aggregate)
    expect(serialized).not.toContain('undefined')
    expect(typeof aggregate.generatedAt).toBe('number')

    // 端点返回的包络也是同一份 JSON
    const response = await dispatchCtxApi(engine, 'GET', '/session/preview-showcase/context', new URLSearchParams())
    expect(response.status).toBe(200)
    expect(JSON.parse(JSON.stringify(response.body))).toEqual(response.body)
  })

  it('同文件多次编辑合并取最终态：write(create) 之后 edit → update', async () => {
    const base = preview('preview-showcase')
    const cwd = base.header.cwd ?? '/dsh/workspace'
    const events = [
      ...base.events,
      { type: 'tool/call', seq: 9001, time: 1_700_000_000_001, data: { callId: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'out.txt', content: 'a' }) } },
      { type: 'tool/result', seq: 9002, time: 1_700_000_000_002, data: { message: { source: { kind: 'tool', callId: 'w1' }, content: [{ type: 'tool-result', isError: false, content: [] }] }, meta: { diffs: [] } } },
      { type: 'tool/call', seq: 9003, time: 1_700_000_000_003, data: { callId: 'e1', name: 'edit', arguments: JSON.stringify({ file_path: 'out.txt' }) } },
      { type: 'tool/result', seq: 9004, time: 1_700_000_000_004, data: { message: { source: { kind: 'tool', callId: 'e1' }, content: [{ type: 'tool-result', isError: false, content: [] }] }, meta: { diffs: [{ path: 'out.txt' }] } } },
    ]
    const engine = makeRealEngine([{ header: base.header, events }])
    const { aggregate } = await aggregateContext(engine, 'preview-showcase')
    expect(findFile(aggregate.outputs.files, 'out.txt')).toMatchObject({ outputOp: 'update' })
    // 绝对路径的 meta.path 也能相对化到同一条目
    const absEvents = [
      { type: 'tool/call', seq: 9011, time: 1_700_000_000_011, data: { callId: 'w2', name: 'write', arguments: JSON.stringify({ file_path: `${cwd}/deep/new.txt`, content: 'b' }) } },
      { type: 'tool/result', seq: 9012, time: 1_700_000_000_012, data: { message: { source: { kind: 'tool', callId: 'w2' }, content: [{ type: 'tool-result', isError: false, content: [] }] }, meta: { diffs: [] } } },
    ]
    const engine2 = makeRealEngine([{ header: base.header, events: [...base.events, ...absEvents] }])
    const { aggregate: agg2 } = await aggregateContext(engine2, 'preview-showcase')
    expect(findFile(agg2.outputs.files, 'deep/new.txt')).toMatchObject({ outputOp: 'create' })
  })
})
