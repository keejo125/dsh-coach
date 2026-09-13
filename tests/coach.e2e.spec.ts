/**
 * 复盘数据层 · 端到端冒烟（真实 HTTP 链路）。
 *
 * 与单元/对拍测试的差异：这里把 registerCoachApi 注册出的 handler 挂到真实
 * node:http 服务上，用 fetch 走完整链路——URL 解析 → 路由分发 → 真实日志
 * engine → CoachReport JSON 响应。验证「实际功能」而非仅函数级行为。
 *
 * 边界说明：数据源是真实 V3 日志构造的引擎（本地无 DSH host 运行环境，
 * 无法 `dsh plugin add` 后在真实 host 内加载）；HTTP 层是真实的。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { BASE_ROOT, BASE_AVAILABLE, loadSessionLog, makeRealEngine } from './real-log.verify.helper.ts'
import { registerCoachApi } from '../src/host/coach/api.ts'
import type { AggregatorEngine } from '../src/host/aggregator.ts'

const SNAPSHOT_ROOT = join(BASE_ROOT, 'snapshots')
const SAMPLES = ['session/fs-delete-recreate', 'sdk/text-turn', 'sdk/inline-image-prompt'] as const

describe.skipIf(!BASE_AVAILABLE)('coach · 端到端冒烟（真实 HTTP）', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const logs = SAMPLES.map(name => loadSessionLog(join(SNAPSHOT_ROOT, name, 'session.jsonl')))
    const engine: AggregatorEngine = makeRealEngine(logs)

    // 模拟基座 webServer：捕获插件注册的 handler（真实基座按 path 前缀路由，
    // 这里把 /coach/api 前缀的请求全部交给该 handler，handler 内部自行分发）
    let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
    const mockCtx = {
      webServer: {
        register: (route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) => {
          handler = route.handler
        },
      },
    }
    registerCoachApi(mockCtx as never, engine)
    if (handler === undefined) throw new Error('registerCoachApi did not register a handler')

    server = createServer((req, res) => handler?.(req, res))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('GET /coach/api/session/:id/report → 200 + 完整 CoachReport', async () => {
    for (const name of SAMPLES) {
      const id = loadSessionLog(join(SNAPSHOT_ROOT, name, 'session.jsonl')).header.id
      const response = await fetch(`${baseUrl}/coach/api/session/${encodeURIComponent(id)}/report`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = (await response.json()) as { ok: boolean; data?: Record<string, unknown>; error?: unknown }
      expect(body.ok).toBe(true)
      const data = body.data as Record<string, unknown>
      expect(data['sessionId']).toBe(id)
      const score = data['score'] as { total: number; dimensions: unknown[] }
      expect(score.total).toBeGreaterThanOrEqual(0)
      expect(score.total).toBeLessThanOrEqual(100)
      expect(score.dimensions).toHaveLength(6)
      expect(typeof data['generatedAt']).toBe('number')
      expect(data['scope']).toBeTruthy()
      expect(data['signals']).toBeTruthy()
      expect(data['artifacts']).toBeTruthy()
    }
  })

  it('未知会话 → 404 + COACH_SESSION_NOT_FOUND', async () => {
    const response = await fetch(`${baseUrl}/coach/api/session/definitely-not-a-session/report`)
    expect(response.status).toBe(404)
    const body = (await response.json()) as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('COACH_SESSION_NOT_FOUND')
  })

  it('非 GET → 400 + COACH_BAD_REQUEST', async () => {
    const response = await fetch(`${baseUrl}/coach/api/session/x/report`, { method: 'POST' })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('COACH_BAD_REQUEST')
  })

  it('未知路由 → 400', async () => {
    const response = await fetch(`${baseUrl}/coach/api/session/x/nope`)
    expect(response.status).toBe(400)
  })
})
