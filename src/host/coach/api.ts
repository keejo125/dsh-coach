/**
 * GET /coach/api 前缀端点：复盘报告路由 + 统一错误包络。
 *
 * 与 /ctx/api 同构（见 api.ts）：
 * - 注册走基座 ctx.webServer.register({kind:'prefix'})，路由前缀剥离后手工分发；
 * - dispatchCoachApi 是纯 (engine, method, path, query) → {status, body} 的分发函数，
 *   便于脱离 node:http 做契约集成测试；registerCoachApi 只做 HTTP 粘合。
 * - 每次请求即时计算一次，host 面不持有任何跨请求状态（与聚合同约定）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import type { CoachApiEnvelope, CoachApiErrorCode } from '../../shared/types.ts'
import type { AggregatorEngine } from '../aggregator.ts'
import { buildCoachReport, CoachSessionUnavailableError } from './report.ts'

const COACH_API_PREFIX = '/coach/api'

/** HTTP 状态码映射（404/400/500）。 */
const COACH_HTTP_STATUS: Record<CoachApiErrorCode, number> = {
  COACH_SESSION_NOT_FOUND: 404,
  COACH_BAD_REQUEST: 400,
  COACH_INTERNAL: 500,
}

interface DispatchResponse {
  status: number
  body: CoachApiEnvelope<unknown>
}

function ok(data: unknown): DispatchResponse {
  return { status: 200, body: { ok: true, data } }
}

function fail(code: CoachApiErrorCode, message: string): DispatchResponse {
  return { status: COACH_HTTP_STATUS[code] ?? 500, body: { ok: false, error: { code, message } } }
}

/**
 * 分发函数：处理剥去 `/coach/api` 前缀后的请求。
 * @param pathname 剥前缀后的路径（如 `/session/<id>/report`）。
 */
export async function dispatchCoachApi(
  engine: AggregatorEngine,
  method: string,
  pathname: string,
): Promise<DispatchResponse> {
  try {
    if (method !== 'GET') return fail('COACH_BAD_REQUEST', `method ${method} is not supported`)
    const segments = pathname.split('/').filter(segment => segment.length > 0)
    if (segments[0] !== 'session' || segments.length !== 3 || segments[2] !== 'report') {
      return fail('COACH_BAD_REQUEST', 'unknown route')
    }
    const sessionId = segments[1] as string
    const report = await buildCoachReport(engine, sessionId)
    return ok(report)
  } catch (error) {
    if (error instanceof CoachSessionUnavailableError) {
      return fail('COACH_SESSION_NOT_FOUND', 'session is unavailable')
    }
    // 未知异常收敛为 COACH_INTERNAL 且 message 脱敏
    return fail('COACH_INTERNAL', 'internal error')
  }
}

/** 注册 /coach/api 前缀端点（host 插件入口调用一次）。 */
export function registerCoachApi(ctx: Context, engine: AggregatorEngine): void {
  ctx.webServer.register({
    kind: 'prefix',
    path: COACH_API_PREFIX,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void (async(): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://dsh-coach.local')
        const subPath = url.pathname.startsWith(COACH_API_PREFIX)
          ? url.pathname.slice(COACH_API_PREFIX.length)
          : url.pathname
        const response = await dispatchCoachApi(engine, req.method ?? 'GET', subPath)
        res.statusCode = response.status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(response.body))
      })().catch(() => {
        if (!res.headersSent) {
          res.statusCode = COACH_HTTP_STATUS.COACH_INTERNAL ?? 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
        }
        const fallback: CoachApiEnvelope<never> = { ok: false, error: { code: 'COACH_INTERNAL', message: 'internal error' } }
        res.end(JSON.stringify(fallback))
      })
    },
  })
}
