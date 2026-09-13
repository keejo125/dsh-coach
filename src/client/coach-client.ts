/**
 * /coach/api fetch 封装：类型化解包、错误归一、中止信号（spec/09 §4）。
 * 所有失败统一抛 CoachApiError{code,message}；UI 层对 COACH_SESSION_NOT_FOUND
 * 显示空态，其余显示可重试错误条。
 */

import type { CoachApiEnvelope, CoachApiErrorCode, CoachReport, CoachTimeline } from '../shared/types.ts'

/** 归一化的 API 错误。 */
export class CoachApiError extends Error {
  constructor(readonly code: CoachApiErrorCode, message: string) {
    super(message)
    this.name = 'CoachApiError'
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    // exactOptionalPropertyTypes 下 RequestInit.signal 不接受显式 undefined
    response = await fetch(path, signal === undefined ? {} : { signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new CoachApiError('COACH_INTERNAL', 'network error')
  }
  let payload: CoachApiEnvelope<T> | undefined
  try {
    payload = await response.json() as CoachApiEnvelope<T>
  } catch {
    throw new CoachApiError('COACH_INTERNAL', `HTTP ${String(response.status)}`)
  }
  if (payload !== undefined && payload.ok === true) return payload.data
  const errorBody = payload !== undefined && payload.ok === false ? payload.error : undefined
  throw new CoachApiError(
    errorBody?.code ?? 'COACH_INTERNAL',
    errorBody?.message ?? `HTTP ${String(response.status)}`,
  )
}

const encoded = (sessionId: string): string => encodeURIComponent(sessionId)

/** 拉取复盘报告（GET /coach/api/session/:id/report）。 */
export function fetchCoachReport(sessionId: string, signal?: AbortSignal): Promise<CoachReport> {
  return request<CoachReport>(`/coach/api/session/${encoded(sessionId)}/report`, signal)
}

/** 拉取交互时间线（GET /coach/api/session/:id/timeline）。 */
export function fetchCoachTimeline(sessionId: string, signal?: AbortSignal): Promise<CoachTimeline> {
  return request<CoachTimeline>(`/coach/api/session/${encoded(sessionId)}/timeline`, signal)
}
