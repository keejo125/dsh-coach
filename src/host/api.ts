/**
 * GET /ctx/api 前缀端点：手工分发 context / file / output-text 三条路由
 * + 统一错误包络（§3.6）。
 *
 * - 注册走基座 ctx.webServer.register({kind:'prefix'})，路由前缀剥离后手工分发；
 * - dispatchCtxApi 是纯 (method, path, query) → {status, body} 的分发函数，
 *   便于脱离 node:http 做契约集成测试；registerCtxApi 只做 HTTP 粘合。
 * - 每次请求即时聚合一次，host 面不持有任何跨请求状态（§1.2「即时聚合、
 *   不落盘、无状态」）。聚合结果的复用交给 client store（带 generatedAt
 *   供手动刷新比对），host 侧不做缓存：任何跨请求缓存都会让端点返回过期快照，
 *   违背「每次 Tab 激活重新拉取，依赖 HTTP 层的即时聚合语义」的约定。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { aggregateContext, type AggregatorEngine, type AggregatorEvent, type AggregateResult } from './aggregator.ts'
import { FileAccessError, readWorkspaceFile, revealWorkspaceFile } from './file-access.ts'
import type { CtxApiEnvelope, CtxApiErrorCode, FileContentResult, OutputTextResult } from '../shared/types.ts'

const API_PREFIX = '/ctx/api'

// —— HTTP 状态码映射（§3.6：404/403/400/500） ——
const HTTP_STATUS: Record<CtxApiErrorCode, number> = {
  CTX_SESSION_NOT_FOUND: 404,
  CTX_FILE_NOT_FOUND: 404,
  CTX_FILE_FORBIDDEN: 403,
  CTX_INDEX_OUT_OF_RANGE: 400,
  CTX_SEGMENT_NOT_FOUND: 404,
  CTX_BAD_REQUEST: 400,
  CTX_INTERNAL: 500,
}

interface DispatchResponse {
  status: number
  body: CtxApiEnvelope<unknown>
}

function ok(data: unknown): DispatchResponse {
  return { status: 200, body: { ok: true, data } }
}

function fail(code: CtxApiErrorCode, message: string): DispatchResponse {
  return { status: HTTP_STATUS[code], body: { ok: false, error: { code, message } } }
}

/**
 * V8 内置的「实现缺陷」错误家族：这类失败与会话是否存在无关，
 * 若一并归为会话不可得，client 会按 CTX_SESSION_NOT_FOUND 显示空态，
 * 真实故障被静默吞掉（§7.3 要求未知异常收敛为 CTX_INTERNAL）。
 */
const PROGRAMMING_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError',
])

function isProgrammingError(error: unknown): boolean {
  return error instanceof Error && PROGRAMMING_ERROR_NAMES.has(error.name)
}

/**
 * 取会话内**最后一条** `agent-preset/selected` 事件里的 preset id。
 *
 * 会话 header 的 `agentPreset` 只是建会话时的默认值（实测多为 `standard`），用户在会话中
 * 切换过 preset 后，真正生效的是该事件。实测会话「询问AI身份与角色」：header 为 `standard`，
 * 事件流里依次选中 `software-company` → `software-company-software-architect`（架构师高见远）。
 * 故以「最后一条」为准；无该事件时回退 header。
 */
function selectedPresetId(events: readonly AggregatorEvent[]): string | undefined {
  let latest: string | undefined
  for (const event of events) {
    if (event.type !== 'agent-preset/selected') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const id = (data as Record<string, unknown>)['agentPreset']
    if (typeof id === 'string' && id.length > 0) latest = id
  }
  return latest
}

/**
 * 方案 B：把主 Agent 的 `agentPreset` id 解析为展示真名（如 `proj-…-software-architect` → 高见远）。
 *
 * preset 文件（`~/.dsh/.agent-presets/<去 proj- 前缀>/preset.yml`）的 `name` 形如
 * 「Agent · 高见远」，去掉前缀后返回「高见远」。任何读取失败（无 preset / 文件缺失 /
 * 无权限）一律回落 `undefined`——调用方据此让 client 回退到 locale「主Agent」，绝不抛错。
 *
 * preset id 取 `selectedPresetId`（最后一条 `agent-preset/selected`）优先，
 * 回退会话 header——header 只是建会话时的默认值，不能代表当前身份。
 *
 * 仅在**真实 HTTP 句柄**里调用（host 进程有 FS 权限）；纯分发函数 `dispatchCtxApi`
 * 不触发此路径，故契约集成测试不受影响。
 */
async function resolveMainAgentName(engine: AggregatorEngine, sessionId: string): Promise<string | undefined> {
  try {
    const log = await engine.readSession(sessionId)
    const presetId = selectedPresetId(log.events) ?? log.session.agentPreset
    if (typeof presetId !== 'string' || presetId.length === 0) return undefined
    const stripped = presetId.startsWith('proj-') ? presetId.slice('proj-'.length) : presetId
    const file = path.join(os.homedir(), '.dsh', '.agent-presets', stripped, 'preset.yml')
    const raw = await readFile(file, 'utf-8')
    const match = raw.match(/^name:\s*(.+?)\s*$/m)
    if (match === null) return undefined
    let name = (match[1] ?? '').trim()
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1)
    if (name.startsWith('Agent · ')) name = name.slice('Agent · '.length)
    return name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}

/** 即时聚合一次；会话读不到归一为 CTX_SESSION_NOT_FOUND，其余故障上抛给 CTX_INTERNAL。 */
async function loadAggregate(engine: AggregatorEngine, sessionId: string, mainAgentName?: string): Promise<AggregateResult> {
  try {
    return await aggregateContext(engine, sessionId, mainAgentName)
  } catch (error) {
    if (error instanceof FileAccessError) throw error
    // readSession/traceSession 的数据层失败（含会话不存在）→ 会话不可得；
    // 实现缺陷原样上抛，由 dispatchCtxApi 收敛并脱敏为 CTX_INTERNAL。
    if (isProgrammingError(error)) throw error
    throw new SessionUnavailableError()
  }
}

class SessionUnavailableError extends Error {
  constructor() {
    super('session is unavailable')
    this.name = 'SessionUnavailableError'
  }
}

// —— 路由处理器 ——

async function handleContext(engine: AggregatorEngine, sessionId: string, mainAgentName?: string): Promise<DispatchResponse> {
  const { aggregate } = await loadAggregate(engine, sessionId, mainAgentName)
  return ok(aggregate)
}

async function handleFile(engine: AggregatorEngine, sessionId: string, rawPath: string | null): Promise<DispatchResponse> {
  if (rawPath === null || rawPath.length === 0) {
    return fail('CTX_BAD_REQUEST', 'query parameter "path" is required')
  }
  let root: string | undefined
  try {
    const log = await engine.readSession(sessionId)
    root = log.session.cwd
  } catch {
    return fail('CTX_SESSION_NOT_FOUND', 'session is unavailable')
  }
  if (typeof root !== 'string' || root.length === 0) {
    // 待明确 #2 定案：header 缺 cwd（异常日志）→ file 端点整体拒绝，fail-closed
    return fail('CTX_FILE_FORBIDDEN', 'session workspace root is unavailable')
  }
  let content: FileContentResult
  try {
    content = await readWorkspaceFile(root, rawPath)
  } catch (error) {
    if (error instanceof FileAccessError) return fail(error.code, error.message)
    return fail('CTX_INTERNAL', 'internal error')
  }
  return ok(content)
}

/**
 * GET /ctx/api/session/<id>/reveal?path=<rel>
 *
 * 在系统文件管理器中打开该文件**所在的文件夹**（macOS：`open -R` → 开 Finder 并高亮该文件）。
 * 浏览器无法直接唤起 Finder，故由 host 代劳；路径判定与 file 端点共用同一条五级安全链，
 * **只对已确认落在工作区内的常规文件**执行。失败不影响会话本身，前端只做轻量提示。
 */
async function handleReveal(engine: AggregatorEngine, sessionId: string, rawPath: string | null): Promise<DispatchResponse> {
  if (rawPath === null || rawPath.length === 0) {
    return fail('CTX_BAD_REQUEST', 'query parameter "path" is required')
  }
  let root: string | undefined
  try {
    const log = await engine.readSession(sessionId)
    root = log.session.cwd
  } catch {
    return fail('CTX_SESSION_NOT_FOUND', 'session is unavailable')
  }
  if (typeof root !== 'string' || root.length === 0) {
    // 与 file 端点同口径：header 缺 cwd → fail-closed
    return fail('CTX_FILE_FORBIDDEN', 'session workspace root is unavailable')
  }
  try {
    await revealWorkspaceFile(root, rawPath)
  } catch (error) {
    if (error instanceof FileAccessError) return fail(error.code, error.message)
    return fail('CTX_INTERNAL', 'internal error')
  }
  return ok({ revealed: true })
}

/**
 * output-text 端点：`?id=` 为首选（段稳定 id），`?index=` 为 deprecated 兼容路径
 * （仅当未传 id 时生效；两者同时提供以 id 为准）。
 *
 * id 化的收益（增量设计 §1.3）：段 id 在两次聚合之间恒定，端点不会因中间新增
 * 输出而静默指向另一段；且解耦端点与数组结构，将来无论怎么重组 textSegments，
 * 端点契约都不动。
 */
async function handleOutputText(
  engine: AggregatorEngine,
  sessionId: string,
  rawId: string | null,
  rawIndex: string | null,
): Promise<DispatchResponse> {
  // 先 trim：Number(' ') === 0，纯空白的 index 会被静默当成第 0 段
  const id = rawId?.trim() ?? ''
  const trimmed = rawIndex?.trim() ?? ''
  if (id.length === 0 && trimmed.length === 0) {
    return fail('CTX_BAD_REQUEST', 'query parameter "id" is required')
  }
  const { aggregate, outputFullTexts } = await loadAggregate(engine, sessionId)
  const segments = aggregate.outputs.textSegments
  if (id.length > 0) {
    const index = segments.findIndex(segment => segment.id === id)
    const segment = segments[index]
    if (index < 0 || segment === undefined) {
      return fail('CTX_SEGMENT_NOT_FOUND', `output text segment ${id} was not found`)
    }
    const data: OutputTextResult = {
      id: segment.id,
      index,
      agentKey: segment.agentKey,
      turn: segment.turn,
      step: segment.step,
      kind: segment.kind,
      text: outputFullTexts.get(segment.id) ?? segment.text,
    }
    return ok(data)
  }
  // —— deprecated：?index= 按下标取，v1.1 随 index 一并移除 ——
  const index = Number(trimmed)
  if (!Number.isInteger(index) || index < 0 || index >= segments.length) {
    return fail('CTX_INDEX_OUT_OF_RANGE', `output text index ${rawIndex} is out of range`)
  }
  const segment = segments[index]
  if (segment === undefined) return fail('CTX_INDEX_OUT_OF_RANGE', `output text index ${rawIndex} is out of range`)
  const data: OutputTextResult = {
    id: segment.id,
    index,
    agentKey: segment.agentKey,
    turn: segment.turn,
    step: segment.step,
    kind: segment.kind,
    text: outputFullTexts.get(segment.id) ?? segment.text,
  }
  return ok(data)
}

/**
 * 分发函数：处理剥去 `/ctx/api` 前缀后的请求。
 * @param pathname 剥前缀后的路径（以 `/` 开头，如 `/session/<id>/context`）。
 * @param query URL 查询参数。
 */
export async function dispatchCtxApi(
  engine: AggregatorEngine,
  method: string,
  pathname: string,
  query: URLSearchParams,
  mainAgentName?: string,
): Promise<DispatchResponse> {
  try {
    if (method !== 'GET') return fail('CTX_BAD_REQUEST', `method ${method} is not supported`)
    const segments = pathname.split('/').filter(segment => segment.length > 0)
    if (segments[0] !== 'session' || segments.length !== 3) {
      return fail('CTX_BAD_REQUEST', 'unknown route')
    }
    const sessionId = segments[1] as string
    const action = segments[2]
    if (action === 'context') return await handleContext(engine, sessionId, mainAgentName)
    if (action === 'file') return await handleFile(engine, sessionId, query.get('path'))
    if (action === 'reveal') return await handleReveal(engine, sessionId, query.get('path'))
    if (action === 'output-text') return await handleOutputText(engine, sessionId, query.get('id'), query.get('index'))
    return fail('CTX_BAD_REQUEST', 'unknown route')
  } catch (error) {
    if (error instanceof SessionUnavailableError) {
      return fail('CTX_SESSION_NOT_FOUND', 'session is unavailable')
    }
    // 未知异常收敛为 CTX_INTERNAL 且 message 脱敏（§7.3）
    return fail('CTX_INTERNAL', 'internal error')
  }
}

/** 注册 /ctx/api 前缀端点（host 插件入口调用一次）。 */
export function registerCtxApi(ctx: Context, engine: AggregatorEngine): void {
  ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void (async(): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://dsh-coach.local')
        // prefix 模式下 req.url 保留完整路径，分发前剥离前缀
        const subPath = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length)
          : url.pathname
        // 方案 B：解析主 Agent 真名（读 preset 文件）；失败静默回落 undefined（client 显示「主Agent」）
        const routeSegments = subPath.split('/').filter(segment => segment.length > 0)
        const routeSessionId = routeSegments[0] === 'session' ? routeSegments[1] : undefined
        const mainAgentName = routeSessionId !== undefined
          ? await resolveMainAgentName(engine, routeSessionId).catch(() => undefined)
          : undefined
        const response = await dispatchCtxApi(engine, req.method ?? 'GET', subPath, url.searchParams, mainAgentName)
        res.statusCode = response.status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(response.body))
      })().catch(() => {
        // 双保险：任何粘合层异常都不至于挂起连接
        if (!res.headersSent) {
          res.statusCode = HTTP_STATUS.CTX_INTERNAL
          res.setHeader('content-type', 'application/json; charset=utf-8')
        }
        const fallback: CtxApiEnvelope<never> = { ok: false, error: { code: 'CTX_INTERNAL', message: 'internal error' } }
        res.end(JSON.stringify(fallback))
      })
    },
  })
}
