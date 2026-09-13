/**
 * /ctx/api fetch 封装：类型化解包、错误归一、中止信号（§1.2 client 面）。
 * 所有失败统一抛 ContextApiError{code,message}；UI 层对 CTX_SESSION_NOT_FOUND
 * 显示空态，其余显示可重试错误条（§7.3）。
 */

import type { ContextAggregate, CtxApiErrorCode, CtxApiEnvelope, FileContentResult, OutputTextResult, RevealResult } from '../shared/types.ts'

/** 归一化的 API 错误。 */
export class ContextApiError extends Error {
  constructor(readonly code: CtxApiErrorCode, message: string) {
    super(message)
    this.name = 'ContextApiError'
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    // exactOptionalPropertyTypes 下 RequestInit.signal 不接受显式 undefined
    response = await fetch(path, signal === undefined ? {} : { signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ContextApiError('CTX_INTERNAL', 'network error')
  }
  let payload: CtxApiEnvelope<T> | undefined
  try {
    payload = await response.json() as CtxApiEnvelope<T>
  } catch {
    throw new ContextApiError('CTX_INTERNAL', `HTTP ${String(response.status)}`)
  }
  if (payload !== undefined && payload.ok === true) return payload.data
  const errorBody = payload !== undefined && payload.ok === false ? payload.error : undefined
  throw new ContextApiError(
    errorBody?.code ?? 'CTX_INTERNAL',
    errorBody?.message ?? `HTTP ${String(response.status)}`,
  )
}

const encoded = (sessionId: string): string => encodeURIComponent(sessionId)

/** 拉取三段聚合结果（GET /ctx/api/session/:id/context）。 */
export function fetchContextAggregate(sessionId: string, signal?: AbortSignal): Promise<ContextAggregate> {
  return request<ContextAggregate>(`/ctx/api/session/${encoded(sessionId)}/context`, signal)
}

/** 拉取文件正文（GET /ctx/api/session/:id/file?path=…）。 */
export function fetchFileBody(sessionId: string, path: string, signal?: AbortSignal): Promise<FileContentResult> {
  return request<FileContentResult>(`/ctx/api/session/${encoded(sessionId)}/file?path=${encodeURIComponent(path)}`, signal)
}

/**
 * 拉取文字输出全文（GET /ctx/api/session/:id/output-text?id=…）。
 *
 * 按**段 id** 取（`<sessionId>:<seq>`，跨聚合恒定）。`?index=` 已在 host 侧降级为
 * deprecated，client 不再使用它——下标会因中间新增输出而静默指向另一段。
 */
export function fetchOutputText(sessionId: string, id: string, signal?: AbortSignal): Promise<OutputTextResult> {
  return request<OutputTextResult>(`/ctx/api/session/${encoded(sessionId)}/output-text?id=${encodeURIComponent(id)}`, signal)
}

/**
 * 在系统文件管理器中打开该文件所在目录（GET /ctx/api/session/:id/reveal?path=…）。
 *
 * host 侧唤起系统文件管理器（macOS Finder）；成功仅表示「已发出唤起请求」，
 * 不保证窗口置顶。失败抛 ContextApiError，UI 做轻量提示即可，不打断阅读。
 */
export function revealFileInFolder(sessionId: string, path: string, signal?: AbortSignal): Promise<RevealResult> {
  return request<RevealResult>(`/ctx/api/session/${encoded(sessionId)}/reveal?path=${encodeURIComponent(path)}`, signal)
}
