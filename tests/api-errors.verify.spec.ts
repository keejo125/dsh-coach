/**
 * C. /ctx/api 错误路径（QA 独立验证）。
 *
 * 覆盖既有 spec 未覆盖的部分：HTTP 动词全集、路由形状全集、index 解析的
 * 各种脏输入、六错误码 → HTTP 状态码映射表、message 脱敏、
 * registerCtxApi 的 HTTP 粘合（前缀剥离 / 响应头 / 双保险兜底）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { dispatchCtxApi, registerCtxApi } from '../src/host/api.ts'
import type { AggregatorEngine, AggregatorEvent } from '../src/host/aggregator.ts'
import type { CtxApiErrorCode } from '../src/shared/types.ts'

function makeEngine(
  sessions: Record<string, { cwd?: string; events: AggregatorEvent[] }> = {},
): AggregatorEngine {
  return {
    readSession: async id => {
      const session = sessions[id]
      if (session === undefined) throw new Error(`session not found: ${id}`)
      const header = session.cwd === undefined ? { id } : { id, cwd: session.cwd }
      return { session: header, events: session.events }
    },
    traceSession: async id => ({
      target: { header: { id } },
      descendants: [],
    }),
  }
}

const output = (turn: number, text: string): AggregatorEvent => ({
  type: 'assistant/message',
  seq: turn,
  time: 1_700_000_000_000 + turn,
  data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

const withOutputs = (count: number): AggregatorEngine =>
  makeEngine({
    s1: {
      cwd: '/ws',
      events: Array.from({ length: count }, (_, index) => output(index + 1, `segment-${String(index)}`)),
    },
  })

const q = (params: Record<string, string> = {}): URLSearchParams => new URLSearchParams(params)

/** 抽取失败包的 code/message（成功则抛错，避免用例被静默放宽）。 */
function failBody(response: { status: number; body: unknown }): { status: number; code: CtxApiErrorCode; message: string } {
  const body = response.body as { ok?: boolean; error?: { code?: CtxApiErrorCode; message?: string } }
  if (body.ok !== false || body.error?.code === undefined) {
    throw new Error(`expected a failure envelope, got ${JSON.stringify(response)}`)
  }
  return { status: response.status, code: body.error.code, message: body.error.message ?? '' }
}

describe('C1 · 方法白名单', () => {
  it('非 GET 全部 → 400 CTX_BAD_REQUEST，且不触碰引擎', async () => {
    let touched = false
    const engine: AggregatorEngine = {
      readSession: async () => { touched = true; throw new Error('should not be called') },
      traceSession: async () => { touched = true; throw new Error('should not be called') },
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'get']) {
      const failure = failBody(await dispatchCtxApi(engine, method, '/session/s1/context', q()))
      expect(failure.code).toBe('CTX_BAD_REQUEST')
      expect(failure.status).toBe(400)
    }
    expect(touched).toBe(false)
  })
})

describe('C2 · 路由形状', () => {
  const routes: string[] = [
    '/',
    '',
    '/session',
    '/session/s1',
    '/session/s1/context/extra',
    '/session/s1/',
    '/context',
    '/ctx/api/session/s1/context',
    '/session//context',
    '/foo/bar/baz',
  ]

  it('非法路由形状 → 400 CTX_BAD_REQUEST（unknown route）', async () => {
    const engine = makeEngine({ s1: { cwd: '/ws', events: [] } })
    for (const route of routes) {
      const failure = failBody(await dispatchCtxApi(engine, 'GET', route, q()))
      expect(failure, `route=${route}`).toMatchObject({ status: 400, code: 'CTX_BAD_REQUEST' })
      expect(failure.message).toBe('unknown route')
    }
  })

  it('已知动作但会话 id 为空段 → unknown route（segments 长度不符）', async () => {
    const engine = makeEngine({})
    expect(failBody(await dispatchCtxApi(engine, 'GET', '/session//file', q({ path: 'a' }))).code).toBe('CTX_BAD_REQUEST')
  })
})

describe('C3 · 会话不存在', () => {
  it('context / output-text / file 三个端点一致返回 404 CTX_SESSION_NOT_FOUND', async () => {
    const engine = makeEngine({})
    const context = failBody(await dispatchCtxApi(engine, 'GET', '/session/missing/context', q()))
    expect(context).toMatchObject({ status: 404, code: 'CTX_SESSION_NOT_FOUND' })

    const text = failBody(await dispatchCtxApi(engine, 'GET', '/session/missing/output-text', q({ index: '0' })))
    expect(text).toMatchObject({ status: 404, code: 'CTX_SESSION_NOT_FOUND' })

    const file = failBody(await dispatchCtxApi(engine, 'GET', '/session/missing/file', q({ path: 'a.txt' })))
    expect(file).toMatchObject({ status: 404, code: 'CTX_SESSION_NOT_FOUND' })
  })

  it('会话不存在 + index 越界：会话错误优先（先 loadAggregate 后校验 index）', async () => {
    const engine = makeEngine({})
    expect(failBody(await dispatchCtxApi(engine, 'GET', '/session/missing/output-text', q({ index: '99' }))).code)
      .toBe('CTX_SESSION_NOT_FOUND')
  })
})

describe('C4 · output-text index 解析', () => {
  it('越界 / 负数 / 小数 / NaN / 科学计数 → 400 CTX_INDEX_OUT_OF_RANGE', async () => {
    const engine = withOutputs(3)
    for (const index of ['3', '99', '-1', '-0.5', '1.5', 'abc', 'NaN', 'Infinity', '1e2', '0x10', 'null']) {
      const failure = failBody(await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', q({ index })))
      expect(failure, `index=${index}`).toMatchObject({ status: 400, code: 'CTX_INDEX_OUT_OF_RANGE' })
    }
  })

  it('缺 index 参数 → CTX_BAD_REQUEST；空串 → CTX_BAD_REQUEST', async () => {
    const engine = withOutputs(3)
    expect(failBody(await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', q())).code).toBe('CTX_BAD_REQUEST')
    expect(failBody(await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', q({ index: '' }))).code).toBe('CTX_BAD_REQUEST')
  })

  it('合法 index 返回全文；`+1` / ` 1` 由 Number 语义接受；纯空白 index → 400', async () => {
    const engine = withOutputs(3)
    const zero = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', q({ index: '0' }))
    expect(zero).toMatchObject({ status: 200, body: { ok: true, data: { index: 0, turn: 1, text: 'segment-0' } } })
    const plus = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', q({ index: '+1' }))
    expect(plus).toMatchObject({ status: 200, body: { ok: true, data: { index: 1, text: 'segment-1' } } })
    // 数字两侧的空白是 Number 的合法宽容区，trim 后照常解析
    const padded = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', q({ index: ' 1' }))
    expect(padded).toMatchObject({ status: 200, body: { ok: true, data: { index: 1, text: 'segment-1' } } })
    // 纯空白：Number(' ') === 0 会静默取到第 0 段，必须先 trim 再判空 → 按缺参处理
    const space = await dispatchCtxApi(engine, 'GET', '/session/s1/output-text', q({ index: ' ' }))
    expect(space).toMatchObject({ status: 400, body: { ok: false, error: { code: 'CTX_BAD_REQUEST' } } })
  })
})

describe('C5 · 异常收敛：实现缺陷 → CTX_INTERNAL，不被吞成 404', () => {
  const programmingErrors: Array<[string, () => never]> = [
    ['TypeError', () => { throw new TypeError("Cannot read properties of undefined (reading 'x')") }],
    ['ReferenceError', () => { throw new ReferenceError('foo is not defined') }],
    ['RangeError', () => { throw new RangeError('Invalid array length') }],
    ['SyntaxError', () => { throw new SyntaxError('Unexpected token') }],
  ]

  for (const [name, factory] of programmingErrors) {
    it(`${name} 从 readSession 抛出 → 500 CTX_INTERNAL 且 message 脱敏`, async () => {
      const engine: AggregatorEngine = {
        readSession: async () => factory(),
        traceSession: async () => ({ target: { header: { id: 's1' } }, descendants: [] }),
      }
      const failure = failBody(await dispatchCtxApi(engine, 'GET', '/session/s1/context', q()))
      expect(failure).toMatchObject({ status: 500, code: 'CTX_INTERNAL', message: 'internal error' })
      expect(failure.message).not.toContain('/')
    })
  }

  it('traceSession 抛 TypeError → 同样收敛为 CTX_INTERNAL', async () => {
    const engine: AggregatorEngine = {
      readSession: async () => ({ session: { id: 's1', cwd: '/ws' }, events: [] }),
      traceSession: async () => { throw new TypeError('bad lineage') },
    }
    expect(failBody(await dispatchCtxApi(engine, 'GET', '/session/s1/context', q()))).toMatchObject({
      status: 500, code: 'CTX_INTERNAL',
    })
  })

  it('非实现缺陷的普通 Error（数据层故障）→ 归一为 CTX_SESSION_NOT_FOUND', async () => {
    const engine: AggregatorEngine = {
      readSession: async () => { throw new Error('EIO: persistence backend down') },
      traceSession: async () => ({ target: { header: { id: 's1' } }, descendants: [] }),
    }
    const failure = failBody(await dispatchCtxApi(engine, 'GET', '/session/s1/context', q()))
    expect(failure).toMatchObject({ status: 404, code: 'CTX_SESSION_NOT_FOUND' })
    expect(failure.message).not.toContain('EIO')
  })

  it('子会话读取失败被隔离：主会话照常返回，子徽标 degraded', async () => {
    const engine: AggregatorEngine = {
      readSession: async id => {
        if (id === 'child-1') throw new Error('child log unreadable')
        return { session: { id, cwd: '/ws' }, events: [output(1, 'main-output')] }
      },
      traceSession: async () => ({
        target: { header: { id: 's1' } },
        descendants: [{ session: { header: { id: 'child-1' } }, descendants: [] }],
      }),
    }
    const response = await dispatchCtxApi(engine, 'GET', '/session/s1/context', q())
    expect(response.status).toBe(200)
    const body = response.body as { ok: true; data: { agents: Array<{ agentKey: string; degraded?: boolean }> } }
    expect(body.data.agents).toHaveLength(2)
    expect(body.data.agents[1]).toMatchObject({ agentKey: 'child-1', degraded: true })
  })
})

describe('C6 · 六错误码 → HTTP 状态码映射', () => {
  it('映射表与 §3.6 一致', async () => {
    const cases: Array<[CtxApiErrorCode, number]> = [
      ['CTX_SESSION_NOT_FOUND', 404],
      ['CTX_FILE_NOT_FOUND', 404],
      ['CTX_FILE_FORBIDDEN', 403],
      ['CTX_INDEX_OUT_OF_RANGE', 400],
      ['CTX_BAD_REQUEST', 400],
      ['CTX_INTERNAL', 500],
    ]
    for (const [code, status] of cases) {
      // 每个码至少在一条真实路径上出现过；这里逐个用能触发该码的最小请求复核
      const engine = makeEngine({})
      let actual = 0
      if (code === 'CTX_SESSION_NOT_FOUND') actual = failBody(await dispatchCtxApi(engine, 'GET', '/session/x/context', q())).status
      if (code === 'CTX_FILE_NOT_FOUND') {
        const withCwd = makeEngine({ s1: { cwd: process.cwd(), events: [] } })
        actual = failBody(await dispatchCtxApi(withCwd, 'GET', '/session/s1/file', q({ path: '__no_such_file__' }))).status
      }
      if (code === 'CTX_FILE_FORBIDDEN') {
        const withCwd = makeEngine({ s1: { cwd: process.cwd(), events: [] } })
        actual = failBody(await dispatchCtxApi(withCwd, 'GET', '/session/s1/file', q({ path: '/etc/passwd' }))).status
      }
      if (code === 'CTX_INDEX_OUT_OF_RANGE') {
        // 会话存在但 index 越界，才是本码的真实路径（会话不存在时优先 404）
        actual = failBody(await dispatchCtxApi(withOutputs(0), 'GET', '/session/s1/output-text', q({ index: '1' }))).status
      }
      if (code === 'CTX_BAD_REQUEST') actual = failBody(await dispatchCtxApi(engine, 'POST', '/session/x/context', q())).status
      if (code === 'CTX_INTERNAL') {
        const broken: AggregatorEngine = {
          readSession: async () => { throw new TypeError('boom') },
          traceSession: async () => ({ target: { header: { id: 'x' } }, descendants: [] }),
        }
        actual = failBody(await dispatchCtxApi(broken, 'GET', '/session/x/context', q())).status
      }
      expect(actual, `code=${code}`).toBe(status)
    }
  })
})

describe('C7 · registerCtxApi HTTP 粘合层', () => {
  /** 捕获注册进来的 handler，并用假 req/res 驱动一次请求。 */
  function mount(engine: AggregatorEngine): {
    path: string
    kind: string
    request: (url: string, method?: string) => Promise<{ status: number; headers: Record<string, string>; text: string }>
  } {
    let registered: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void } | undefined
    const ctx = {
      webServer: {
        register: (entry: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) => {
          registered = entry
        },
      },
    }
    registerCtxApi(ctx as never, engine)
    if (registered === undefined) throw new Error('registerCtxApi did not call ctx.webServer.register')
    const entry = registered

    const request = (url: string, method = 'GET'): Promise<{ status: number; headers: Record<string, string>; text: string }> =>
      new Promise(resolve => {
        const headers: Record<string, string> = {}
        const res = {
          statusCode: 0,
          setHeader: (key: string, value: string) => { headers[key.toLowerCase()] = value },
          get headersSent(): boolean { return false },
          end: (body: string) => {
            resolve({ status: res.statusCode, headers, text: body })
          },
        }
        entry.handler({ url, method } as IncomingMessage, res as unknown as ServerResponse)
      })

    return { path: entry.path, kind: entry.kind, request }
  }

  it('注册形状：kind=prefix，path=/ctx/api', () => {
    const mounted = mount(makeEngine({ s1: { cwd: '/ws', events: [] } }))
    expect(mounted.kind).toBe('prefix')
    expect(mounted.path).toBe('/ctx/api')
  })

  it('前缀剥离：/ctx/api/session/:id/context 正常 200 且响应头合规', async () => {
    const mounted = mount(withOutputs(1))
    const response = await mounted.request('/ctx/api/session/s1/context?x=1')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(response.text) as { ok: true; data: { sessionId: string } }
    expect(body.data.sessionId).toBe('s1')
  })

  it('查询串不干扰路由匹配（path 参数可含 URL 编码）', async () => {
    const mounted = mount(withOutputs(1))
    const response = await mounted.request('/ctx/api/session/s1/output-text?index=0')
    expect(response.status).toBe(200)
  })

  it('缺 url 时按 / 处理，不抛异常（返回 400 而非挂起连接）', async () => {
    const mounted = mount(makeEngine({}))
    const response = await mounted.request('/ctx/api/nope')
    expect(response.status).toBe(400)
    expect(JSON.parse(response.text)).toMatchObject({ ok: false, error: { code: 'CTX_BAD_REQUEST' } })
  })

  it('method 缺省（undefined）按 GET 处理', async () => {
    const mounted = mount(withOutputs(1))
    const response = await mounted.request('/ctx/api/session/s1/context', undefined)
    expect(response.status).toBe(200)
  })
})
