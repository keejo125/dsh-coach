/**
 * 复盘交互时间线单元测试（v0.2b，spec/09 §3 时间线区块）。
 *
 * 覆盖：轮次分界（initial/followup）、干预/纠错信号、失败/重试标记、
 * 产物路径归轮、答复文本归轮、无用户消息不产生轮次。
 */

import { describe, expect, it } from 'vitest'
import { scanCoachRounds } from '../src/host/coach/timeline.ts'
import type { AggregatorEvent } from '../src/host/aggregator.ts'

const CWD = '/ws'
const T0 = 1_700_000_000_000

function makeEvents(defs: Array<[type: string, data: unknown]>): AggregatorEvent[] {
  return defs.map(([type, data], index) => ({ type, seq: index + 1, time: T0 + index, data }))
}

const turnStart = (turn: number): [string, unknown] => ['turn/start', { turn }]
const userMsg = (text: string, kind: 'user' | 'plugin' = 'user'): [string, unknown] => [
  'user/message',
  { content: [{ type: 'text', text }], source: { kind } },
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
const assistantMsg = (turn: number, text: string): [string, unknown] => [
  'assistant/message',
  { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
]

const rounds = (events: AggregatorEvent[]) => scanCoachRounds(events, CWD)

describe('scanCoachRounds · 轮次分界与信号', () => {
  it('初始任务轮：read → write 产物；kind=initial，产物归轮', () => {
    const events = makeEvents([
      turnStart(1),
      userMsg('重构 checkout 模块'),
      toolCall(1, 'c1', 'read', { file_path: '/ws/engine.ts' }),
      toolResult(1, 'c1', { path: '/ws/engine.ts' }),
      toolCall(1, 'c2', 'write', { file_path: '/ws/engine.ts' }),
      toolResult(1, 'c2', { diffs: [{ path: '/ws/engine.ts' }] }),
      assistantMsg(1, '已完成重构'),
    ])
    const result = rounds(events)
    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe('initial')
    expect(result[0]?.signals).toEqual({ intervention: false, correction: false })
    expect(result[0]?.references).toEqual([{ path: 'engine.ts', views: 1 }])
    expect(result[0]?.artifacts).toEqual([{ path: 'engine.ts', op: 'update', opCount: 1 }])
    expect(result[0]?.actions.map(a => a.name)).toEqual(['read', 'write'])
    expect(result[0]?.assistantText).toBe('已完成重构')
  })

  it('追问轮：用户消息后跟失败 bash 两次 → retried 标记', () => {
    const events = makeEvents([
      turnStart(1),
      userMsg('初始任务'),
      assistantMsg(1, '第一轮答复'),
      turnStart(2),
      userMsg('把失败重试加上'),
      toolCall(2, 'c1', 'bash', { command: 'npm test' }),
      toolResult(2, 'c1', undefined, true),
      toolCall(2, 'c2', 'bash', { command: 'npm test' }),
      toolResult(2, 'c2', undefined, true),
    ])
    const result = rounds(events)
    expect(result).toHaveLength(2)
    expect(result[1]?.kind).toBe('followup')
    expect(result[1]?.signals.intervention).toBe(false)
    const bashActions = result[1]?.actions.filter(a => a.name === 'bash') ?? []
    expect(bashActions).toHaveLength(2)
    expect(bashActions.every(a => a.failed)).toBe(true)
    expect(bashActions.map(a => a.retried)).toEqual([false, true])
  })

  it('干预+纠错轮：用户消息紧邻失败工具结果 → 两信号都置位', () => {
    const events = makeEvents([
      turnStart(1),
      userMsg('初始任务'),
      toolCall(1, 'c1', 'edit', { file_path: '/ws/a.ts' }),
      toolResult(1, 'c1', { diffs: [{ path: '/ws/a.ts' }] }, true),
      // 用户介入：紧邻其前是失败的 tool/result
      userMsg('这里有个 bug，price 字段丢了'),
      toolCall(2, 'c2', 'edit', { file_path: '/ws/a.ts' }),
      toolResult(2, 'c2', { diffs: [{ path: '/ws/a.ts' }] }),
      assistantMsg(2, '已修复'),
    ])
    const result = rounds(events)
    expect(result).toHaveLength(2)
    expect(result[1]?.signals).toEqual({ intervention: true, correction: true })
    expect(result[1]?.artifacts).toEqual([{ path: 'a.ts', op: 'update', opCount: 1 }])
  })

  it('plugin 注入消息不产生轮次', () => {
    const events = makeEvents([
      userMsg('系统注入文档', 'plugin'),
      userMsg('真正的问题'),
      assistantMsg(1, '答复'),
    ])
    const result = rounds(events)
    expect(result).toHaveLength(1)
    expect(result[0]?.userText).toBe('真正的问题')
  })

  it('无用户消息：不产生轮次', () => {
    const events = makeEvents([
      toolCall(1, 'c1', 'read', { file_path: '/ws/a.ts' }),
      toolResult(1, 'c1', { path: '/ws/a.ts' }),
      assistantMsg(1, '无用户输入直接答复'),
    ])
    expect(rounds(events)).toHaveLength(0)
  })

  it('用户文本超长截断至 400 字符', () => {
    const long = 'x'.repeat(500)
    const events = makeEvents([userMsg(long)])
    const result = rounds(events)
    expect(result[0]?.userText.length).toBe(401)
    expect(result[0]?.userText.endsWith('…')).toBe(true)
  })
})
