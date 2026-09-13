/**
 * /ctx/api 三端点集成测试：契约形状、错误码、安全链端到端（设计文档 §3.6 / 任务 #4）。
 * dispatchCtxApi 是纯分发函数，脱离 node:http 直接驱动。
 */

import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { dispatchCtxApi } from '../src/host/api.ts'
import type { AggregatorEngine, AggregatorEvent } from '../src/host/aggregator.ts'
import type { ContextAggregate } from '../src/shared/types.ts'
import { ensureDir, ensureFile, ensureSymlink, fixtureDir } from './tmp-root.ts'

const CWD = '/ws'

function makeEvents(defs: Array<[string, unknown]>): AggregatorEvent[] {
  return defs.map(([type, data], index) => ({ type, seq: index + 1, time: 1_700_000_000_000 + index, data }))
}

function makeEngine(
  sessions: Record<string, { header: { id: string; cwd?: string }; events: AggregatorEvent[] }>,
): AggregatorEngine {
  return {
    readSession: async id => {
      const session = sessions[id]
      if (session === undefined) throw new Error('not found')
      return { session: session.header, events: session.events }
    },
    // 基座 SessionLineageTrace.target 是 SessionRecord（.header 直挂）
    traceSession: async id => ({ target: { header: sessions[id]?.header ?? { id } }, descendants: [] }),
  }
}

function engineWithCwd(cwd: string | undefined, extraEvents: Array<[string, unknown]> = []): AggregatorEngine {
  return makeEngine({
    'sess-fs': {
      header: { id: 'sess-fs', ...(cwd === undefined ? {} : { cwd }) },
      events: makeEvents([['assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }], ...extraEvents]),
    },
  })
}

const CONTEXT_ROUTE = (id: string): string => `/session/${id}/context`

describe('GET /ctx/api · 契约形状与错误码', () => {
  it('context 端点：统一包络 + ContextAggregate 形状', async () => {
    const engine = makeEngine({
      s1: {
        header: { id: 's1', cwd: CWD },
        events: makeEvents([['user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]]),
      },
    })
    const response = await dispatchCtxApi(engine, 'GET', CONTEXT_ROUTE('s1'), new URLSearchParams())
    expect(response.status).toBe(200)
    const body = response.body as { ok: true; data: ContextAggregate }
    expect(body.ok).toBe(true)
    expect(Object.keys(body.data).sort()).toEqual([
      'agents', 'budgets', 'generatedAt', 'inputs', 'outputs', 'references', 'sessionId',
    ])
    expect(body.data.sessionId).toBe('s1')
    expect(body.data.agents[0]).toMatchObject({ agentKey: 'main', role: 'main' })
    expect(body.data.budgets).toMatchObject({ childrenScanned: 0, childrenTotal: 0 })
  })

  it('会话不存在 → 404 CTX_SESSION_NOT_FOUND', async () => {
    const engine = makeEngine({})
    const response = await dispatchCtxApi(engine, 'GET', CONTEXT_ROUTE('missing'), new URLSearchParams())
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'CTX_SESSION_NOT_FOUND' } })
  })

  it('非 GET 方法 → 400 CTX_BAD_REQUEST；未知路由 → 400', async () => {
    const engine = makeEngine({})
    const post = await dispatchCtxApi(engine, 'POST', CONTEXT_ROUTE('s1'), new URLSearchParams())
    expect(post).toMatchObject({ status: 400, body: { ok: false, error: { code: 'CTX_BAD_REQUEST' } } })
    const unknown = await dispatchCtxApi(engine, 'GET', '/session/s1/whatever', new URLSearchParams())
    expect(unknown).toMatchObject({ status: 400, body: { ok: false, error: { code: 'CTX_BAD_REQUEST' } } })
  })

  it('引擎抛出未知异常 → 500 CTX_INTERNAL（message 脱敏）', async () => {
    const engine: AggregatorEngine = {
      readSession: async () => { throw new TypeError('/abs/path leaked in stack') },
      traceSession: async () => { throw new Error('boom') },
    }
    const response = await dispatchCtxApi(engine, 'GET', CONTEXT_ROUTE('s1'), new URLSearchParams())
    expect(response.status).toBe(500)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'CTX_INTERNAL', message: 'internal error' } })
  })
})

/** 构造一个带 N 段输出的引擎（main 会话，seq 从 1 起）。 */
function engineWithSegments(texts: string[]): AggregatorEngine {
  return makeEngine({
    s1: {
      header: { id: 's1', cwd: CWD },
      events: makeEvents(texts.map((text, index) => [
        'assistant/message',
        { turn: index + 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
      ])),
    },
  })
}

describe('GET /ctx/api · output-text 端点（?id= 为首选路径）', () => {
  it('返回完整正文（聚合载荷里是 4KB 截断副本，端点给全文）', async () => {
    const longText = 'x'.repeat(5000)
    const engine = engineWithSegments([longText])
    const context = await dispatchCtxApi(engine, 'GET', CONTEXT_ROUTE('s1'), new URLSearchParams())
    const aggregate = (context.body as { ok: true; data: ContextAggregate }).data
    expect(aggregate.outputs.textSegments[0]?.textTruncated).toBe(true)
    expect(aggregate.outputs.textSegments[0]?.text).toHaveLength(4096)

    const segmentId = aggregate.outputs.textSegments[0]?.id ?? ''
    const response = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', new URLSearchParams(`id=${encodeURIComponent(segmentId)}`))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: { id: segmentId, index: 0, agentKey: 'main', turn: 1, step: 1, kind: 'final', text: longText },
    })
  })

  it('?id= 命中过程段时同样返回未裁剪全文（不受 320B 预览影响）', async () => {
    const longText = 'y'.repeat(900)
    const engine = engineWithSegments([longText, '最后一段'])
    const context = await dispatchCtxApi(engine, 'GET', CONTEXT_ROUTE('s1'), new URLSearchParams())
    const aggregate = (context.body as { ok: true; data: ContextAggregate }).data
    const processSegment = aggregate.outputs.textSegments[0]
    expect(processSegment?.kind).toBe('process')
    expect(processSegment?.previewOnly).toBe(true)
    expect((processSegment?.text ?? '').length).toBeLessThan(longText.length)

    const response = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', new URLSearchParams(`id=${encodeURIComponent(processSegment?.id ?? '')}`))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, data: { kind: 'process', text: longText } })
  })

  it('?id= 未命中 → 404 CTX_SEGMENT_NOT_FOUND', async () => {
    const engine = engineWithSegments(['只有一段'])
    const missing = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', new URLSearchParams('id=s1:9999'))
    expect(missing).toMatchObject({ status: 404, body: { ok: false, error: { code: 'CTX_SEGMENT_NOT_FOUND' } } })
    const otherSession = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', new URLSearchParams('id=s2:1'))
    expect(otherSession).toMatchObject({ status: 404, body: { ok: false, error: { code: 'CTX_SEGMENT_NOT_FOUND' } } })
  })

  it('?id= 与 ?index= 同时提供 → 以 id 为准', async () => {
    const engine = engineWithSegments(['第一段', '第二段'])
    const context = await dispatchCtxApi(engine, 'GET', CONTEXT_ROUTE('s1'), new URLSearchParams())
    const aggregate = (context.body as { ok: true; data: ContextAggregate }).data
    const secondId = aggregate.outputs.textSegments[1]?.id ?? ''
    const response = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', new URLSearchParams(`id=${encodeURIComponent(secondId)}&index=0`))
    expect(response).toMatchObject({ status: 200, body: { ok: true, data: { id: secondId, index: 1, text: '第二段' } } })
  })

  it('段 id 在两次聚合之间恒定：中间追加新输出后 ?id= 仍取回同一段（v1.0 已知缺陷的回归）', async () => {
    // v1.0 用下标取全文：下标会因中间新增输出而静默指向另一段。
    const base = engineWithSegments(['A-first'])
    const first = await dispatchCtxApi(base, 'GET', CONTEXT_ROUTE('s1'), new URLSearchParams())
    const firstAggregate = (first.body as { ok: true; data: ContextAggregate }).data
    const id = firstAggregate.outputs.textSegments[0]?.id ?? ''
    expect(id).toBe('s1:1')

    // 中间追加一段更早时间的输出（子会话插在主会话之前）
    const grown = makeEngine({
      s1: {
        header: { id: 's1', cwd: CWD },
        events: makeEvents([
          ['assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'B-inserted-later' }] } }],
        ]),
      },
    })
    const response = await dispatchCtxApi(grown, 'GET', '/session/s1/output-text', new URLSearchParams(`id=${encodeURIComponent(id)}`))
    expect(response).toMatchObject({ status: 200, body: { ok: true, data: { id, text: 'B-inserted-later' } } })
  })

  it('deprecated 的 ?index= 仍可用；越界 / 非整数 / 缺参保持原错误码', async () => {
    const engine = engineWithSegments([])
    const missingParam = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', new URLSearchParams())
    expect(missingParam).toMatchObject({ status: 400, body: { ok: false, error: { code: 'CTX_BAD_REQUEST' } } })
    const outOfRange = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', new URLSearchParams('index=5'))
    expect(outOfRange).toMatchObject({ status: 400, body: { ok: false, error: { code: 'CTX_INDEX_OUT_OF_RANGE' } } })
    const notNumber = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', new URLSearchParams('index=abc'))
    expect(notNumber).toMatchObject({ status: 400, body: { ok: false, error: { code: 'CTX_INDEX_OUT_OF_RANGE' } } })
    // 有段时 ?index= 仍然工作（v1.1 才移除）
    const withSegment = engineWithSegments(['only'])
    const byIndex = await dispatchCtxApi(withSegment, 'GET', '/session/s1/output-text', new URLSearchParams('index=0'))
    expect(byIndex).toMatchObject({ status: 200, body: { ok: true, data: { index: 0, text: 'only' } } })
  })
})

describe('GET /ctx/api · file 端点（安全链端到端）', () => {
  // 夹具固定复用、幂等建、收尾不删除（见 tests/tmp-root.ts 顶部说明）
  const base = fixtureDir('api-host')
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')

  beforeAll(() => {
    ensureDir(root)
    ensureDir(outside)
    ensureFile(join(root, 'a.txt'), 'hello-from-workspace')
    ensureFile(join(outside, 'secret.txt'), 'top-secret')
    ensureSymlink(join(outside, 'secret.txt'), join(root, 'link-out'))
    ensureDir(join(root, 'sub'))
  })

  it('正常读取', async () => {
    const response = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/file', new URLSearchParams('path=a.txt'))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, data: { path: 'a.txt', truncated: false, content: 'hello-from-workspace' } })
  })

  it('path 缺参 → 400', async () => {
    const response = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/file', new URLSearchParams())
    expect(response).toMatchObject({ status: 400, body: { ok: false, error: { code: 'CTX_BAD_REQUEST' } } })
  })

  it('绝对路径 / .. / symlink 逃逸 → 403 CTX_FILE_FORBIDDEN', async () => {
    const cases = ['/etc/passwd', '../outside/secret.txt', 'link-out']
    for (const path of cases) {
      const response = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/file', new URLSearchParams(`path=${encodeURIComponent(path)}`))
      expect(response).toMatchObject({ status: 403, body: { ok: false, error: { code: 'CTX_FILE_FORBIDDEN' } } })
    }
  })

  it('目录 → 403；不存在的文件 → 404 CTX_FILE_NOT_FOUND', async () => {
    const dir = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/file', new URLSearchParams('path=sub'))
    expect(dir).toMatchObject({ status: 403, body: { ok: false, error: { code: 'CTX_FILE_FORBIDDEN' } } })
    const missing = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/file', new URLSearchParams('path=nope.txt'))
    expect(missing).toMatchObject({ status: 404, body: { ok: false, error: { code: 'CTX_FILE_NOT_FOUND' } } })
  })

  it('会话 header 缺 cwd → 403（待明确 #2 定案：fail-closed）', async () => {
    const response = await dispatchCtxApi(engineWithCwd(undefined), 'GET', '/session/sess-fs/file', new URLSearchParams('path=a.txt'))
    expect(response).toMatchObject({ status: 403, body: { ok: false, error: { code: 'CTX_FILE_FORBIDDEN' } } })
  })
})

describe('GET /ctx/api · reveal 端点（打开所在文件夹）', () => {
  const base = fixtureDir('api-host')
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')

  beforeAll(() => {
    ensureDir(root)
    ensureDir(outside)
    ensureFile(join(root, 'a.txt'), 'hello-from-workspace')
    ensureFile(join(outside, 'secret.txt'), 'top-secret')
    ensureSymlink(join(outside, 'secret.txt'), join(root, 'link-out'))
    ensureDir(join(root, 'sub'))
  })

  // 只覆盖「安全链就拒绝」的分支：这些全部在 execFile 之前返回，
  // 绝不会真的唤起系统文件管理器——测试环境里不该弹 Finder 窗口。
  it('path 缺参 → 400', async () => {
    const response = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/reveal', new URLSearchParams())
    expect(response).toMatchObject({ status: 400, body: { ok: false, error: { code: 'CTX_BAD_REQUEST' } } })
  })

  it('绝对路径 / .. / symlink 逃逸 → 403（与 file 端点同口径，共用同一条安全链）', async () => {
    const cases = ['/etc/passwd', '../outside/secret.txt', 'link-out']
    for (const path of cases) {
      const response = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/reveal', new URLSearchParams(`path=${encodeURIComponent(path)}`))
      expect(response).toMatchObject({ status: 403, body: { ok: false, error: { code: 'CTX_FILE_FORBIDDEN' } } })
    }
  })

  it('目录 → 403；不存在的文件 → 404', async () => {
    const dir = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/reveal', new URLSearchParams('path=sub'))
    expect(dir).toMatchObject({ status: 403, body: { ok: false, error: { code: 'CTX_FILE_FORBIDDEN' } } })
    const missing = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/sess-fs/reveal', new URLSearchParams('path=nope.txt'))
    expect(missing).toMatchObject({ status: 404, body: { ok: false, error: { code: 'CTX_FILE_NOT_FOUND' } } })
  })

  it('会话 header 缺 cwd → 403；会话不存在 → 404 CTX_SESSION_NOT_FOUND', async () => {
    const noCwd = await dispatchCtxApi(engineWithCwd(undefined), 'GET', '/session/sess-fs/reveal', new URLSearchParams('path=a.txt'))
    expect(noCwd).toMatchObject({ status: 403, body: { ok: false, error: { code: 'CTX_FILE_FORBIDDEN' } } })
    const missing = await dispatchCtxApi(engineWithCwd(root), 'GET', '/session/no-such-session/reveal', new URLSearchParams('path=a.txt'))
    expect(missing).toMatchObject({ status: 404, body: { ok: false, error: { code: 'CTX_SESSION_NOT_FOUND' } } })
  })
})
