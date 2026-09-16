/**
 * P3 复盘建议提炼单元测试（spec/09 §P3）。
 *
 * 覆盖：偏好/规则/知识三类提炼、去重与上限、AGENTS.md 落点检测、
 * 采纳写入（追加 + 新建）与失败路径。
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCoachSuggestions, detectMemoryTargets, acceptCoachSuggestion } from '../src/host/coach/suggestions.ts'
import type { CoachMemoryTarget, CoachTimelineRound } from '../src/shared/types.ts'

const targets = (): CoachMemoryTarget[] => [
  { kind: 'global', path: '/home/u/.dsh/AGENTS.md', exists: true },
  { kind: 'workspace', path: '/ws/AGENTS.md', exists: false },
]

function round(partial: Partial<CoachTimelineRound>): CoachTimelineRound {
  return {
    userText: '',
    kind: 'followup',
    signals: { intervention: false, correction: false },
    references: [],
    actions: [],
    artifacts: [],
    assistantText: null,
    ...partial,
  }
}

describe('scanCoachSuggestions · 规则', () => {
  it('纠错轮 → 规则建议', () => {
    const items = scanCoachSuggestions([
      round({ userText: '不对，不要直接改源文件，应该先复制一份再改', signals: { intervention: true, correction: true } }),
    ], targets())
    const rule = items.find(item => item.kind === 'rule')
    expect(rule).toBeDefined()
    expect(rule?.content).toContain('纠')
  })

  it('明确禁止句式 → 规则建议', () => {
    const items = scanCoachSuggestions([round({ userText: '以后不要用 tab 缩进，统一用空格' })], targets())
    expect(items.some(item => item.kind === 'rule' && item.content.includes('tab'))).toBe(true)
  })
})

describe('scanCoachSuggestions · 偏好', () => {
  it('呈现偏好句式 → 偏好建议（优先全局落点）', () => {
    const items = scanCoachSuggestions([round({ userText: '汇报时用表格展示比较清晰' })], targets())
    const preference = items.find(item => item.kind === 'preference')
    expect(preference).toBeDefined()
    expect(preference?.target.kind).toBe('global')
  })

  it('疑问句不产出偏好（用户在提问）', () => {
    const items = scanCoachSuggestions([round({ userText: '每个会话一个Team的话，那如果我想手动设定，难道每次都要指定吗？' })], targets())
    expect(items.some(item => item.kind === 'preference')).toBe(false)
  })

  it('初始轮不产出偏好', () => {
    const items = scanCoachSuggestions([round({ kind: 'initial', userText: '用表格展示比较清晰' })], targets())
    expect(items.some(item => item.kind === 'preference')).toBe(false)
  })
})

describe('scanCoachSuggestions · 知识', () => {
  it('新建产物 → 知识建议', () => {
    const items = scanCoachSuggestions([
      round({ userText: '做', artifacts: [{ path: 'docs/guide.md', op: 'create', opCount: 1 }] }),
    ], targets())
    const knowledge = items.find(item => item.kind === 'knowledge' && item.content.includes('guide.md'))
    expect(knowledge).toBeDefined()
    expect(knowledge?.content).toContain('文档')
  })

  it('高频引用（≥3 次）→ 知识建议', () => {
    const items = scanCoachSuggestions([
      round({ userText: 'a', references: [{ path: 'src/core.ts', views: 2 }] }),
      round({ userText: 'b', references: [{ path: 'src/core.ts', views: 2 }] }),
    ], targets())
    const knowledge = items.find(item => item.kind === 'knowledge' && item.content.includes('core.ts'))
    expect(knowledge).toBeDefined()
    expect(knowledge?.content).toContain('4 次')
  })

  it('同内容去重：两条相同偏好只出一次', () => {
    const items = scanCoachSuggestions([
      round({ userText: '汇报时用表格展示比较清晰' }),
      round({ userText: '汇报时用表格展示比较清晰' }),
    ], targets())
    expect(items.filter(item => item.kind === 'preference')).toHaveLength(1)
  })

  it('总量上限 8', () => {
    const rounds = Array.from({ length: 20 }, (_, index) => round({ userText: `以后用方式${index}处理数据` }))
    const items = scanCoachSuggestions(rounds, targets())
    expect(items.length).toBeLessThanOrEqual(8)
  })

  it('无落点 → 不产出建议', () => {
    const items = scanCoachSuggestions([round({ userText: '汇报时用表格展示比较清晰' })], [])
    expect(items).toHaveLength(0)
  })
})

describe('detectMemoryTargets · 落点检测', () => {
  it('全局落点：DSH_HOME 或 ~/.dsh/AGENTS.md', async () => {
    const items = await detectMemoryTargets('/ws')
    expect(items.some(item => item.kind === 'global' && item.path.endsWith('AGENTS.md'))).toBe(true)
    expect(items.some(item => item.kind === 'workspace' && item.path.startsWith('/ws'))).toBe(true)
  })
})

describe('acceptCoachSuggestion · 采纳写入', () => {
  it('写入不存在的工作区 AGENTS.md（新建）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-coach-accept-'))
    const wsRoot = join(dir, 'ws')
    const globalAgents = join(dir, 'dsh', 'AGENTS.md')
    await mkdirRecursive(wsRoot)
    const engine = {
      readSession: async () => ({
        session: { id: 's1', cwd: wsRoot },
        events: [
          { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
          { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '帮我整理一份项目文档' }], source: { kind: 'user' } } },
          { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } },
          { type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } },
          { type: 'user/message', seq: 5, time: 5, data: { content: [{ type: 'text', text: '以后用表格汇报' }], source: { kind: 'user' } } },
          { type: 'assistant/message', seq: 6, time: 6, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } },
        ],
      }),
      traceSession: async () => ({ target: { header: { id: 's1' } }, descendants: [] }),
    }
    process.env.DSH_HOME = join(dir, 'dsh')
    const result = await acceptCoachSuggestion(engine as never, 's1', 'preference-1')
    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(result.path).toBe(globalAgents)
    const content = await readFile(globalAgents, 'utf8')
    expect(content).toContain('dsh-coach preference')
    expect(content).toContain('表格')
    delete process.env.DSH_HOME
    await rm(dir, { recursive: true, force: true })
  })

  it('建议 id 不存在 → ok=false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-coach-accept-'))
    const wsRoot = join(dir, 'ws')
    await mkdirRecursive(wsRoot)
    const engine = {
      readSession: async () => ({
        session: { id: 's1', cwd: wsRoot },
        events: [
          { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
          { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '帮我整理一份项目文档' }], source: { kind: 'user' } } },
          { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } },
          { type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } },
          { type: 'user/message', seq: 5, time: 5, data: { content: [{ type: 'text', text: '以后用表格汇报' }], source: { kind: 'user' } } },
        ],
      }),
      traceSession: async () => ({ target: { header: { id: 's1' } }, descendants: [] }),
    }
    process.env.DSH_HOME = join(dir, 'dsh')
    const result = await acceptCoachSuggestion(engine as never, 's1', 'preference-99')
    expect(result.ok).toBe(false)
    delete process.env.DSH_HOME
    await rm(dir, { recursive: true, force: true })
  })
})

async function mkdirRecursive(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}
