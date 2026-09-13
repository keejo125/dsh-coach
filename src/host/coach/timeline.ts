/**
 * 复盘交互时间线：从会话事件流重建「逐轮交互明细」（spec/09 §3 时间线区块）。
 *
 * 轮次分界：用户主动消息（source.kind === 'user'）。首轮为 initial，其后为 followup。
 * 每轮收集：用户输入文本、工具动作序列（含失败/重试标记）、该轮产物路径、最终答复文本、
 * 干预/纠错信号（语义与 metrics.ts 一致：用户消息紧邻其前一个实质事件是 tool/result）。
 *
 * 复用 metrics.ts 的纯工具（textOf/safeParseArgs/extractText/isErrorResult/resolveCallId/
 * toWorkspacePath/resolveOutputPath），口径与 v0.2a 扫描保持一致。
 */

import type { CoachTimeline, CoachTimelineAction, CoachTimelineRound } from '../../shared/types.ts'
import type { AggregatorEngine, AggregatorEvent } from '../aggregator.ts'
import {
  extractText,
  isErrorResult,
  resolveCallId,
  resolveOutputPath,
  safeParseArgs,
  textOf,
  toWorkspacePath,
} from './metrics.ts'
import { CoachSessionUnavailableError } from './report.ts'

/** 用户输入/答复文本截断上限（字符）。 */
const TEXT_LIMIT = 400

interface CoachCall {
  name: string
  args: Record<string, unknown> | null
}

function truncate(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text
}

/** 从 user/message 提取正文（顶层 content 块拼接；缺省返回 undefined）。 */
function userMessageText(data: Record<string, unknown> | null): string | undefined {
  const text = extractText(data?.['content']).trim()
  return text.length > 0 ? text : undefined
}

/**
 * 重建逐轮明细（端点入口：读会话 → 扫描）。
 * @param engine 会话查询引擎。
 * @param sessionId 目标会话 id。
 */
export async function buildCoachTimeline(engine: AggregatorEngine, sessionId: string): Promise<CoachTimeline> {
  let log
  try {
    log = await engine.readSession(sessionId)
  } catch (error) {
    if (error instanceof Error && ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError'].includes(error.name)) {
      throw error
    }
    throw new CoachSessionUnavailableError()
  }
  return {
    sessionId,
    generatedAt: Date.now(),
    rounds: scanCoachRounds(log.events, log.session.cwd),
  }
}

/**
 * 重建逐轮明细。
 * @param events 会话事件流。
 * @param cwd 会话工作区根（路径相对化锚点）。
 */
export function scanCoachRounds(events: readonly AggregatorEvent[], cwd: string | undefined): CoachTimelineRound[] {
  const rounds: CoachTimelineRound[] = []
  const calls = new Map<string, CoachCall>()
  /** 同轮同工具失败计数（turn:name → 次数），重试标记用。 */
  const failedByTurnTool = new Map<string, number>()

  let currentTurn: number | undefined
  let lastSubstantiveType: string | undefined
  let lastToolResultError = false

  /** 当前轮次（以最近一个用户消息为界；无用户消息时不产生轮次）。 */
  let current: CoachTimelineRound | null = null

  const nextRound = (userText: string, intervention: boolean, correction: boolean): CoachTimelineRound => {
    const round: CoachTimelineRound = {
      userText: truncate(userText),
      kind: rounds.length === 0 ? 'initial' : 'followup',
      signals: { intervention, correction },
      actions: [],
      artifacts: [],
      assistantText: null,
    }
    rounds.push(round)
    return round
  }

  for (const event of events) {
    const type = event.type
    const data = (event.data !== null && typeof event.data === 'object') ? event.data as Record<string, unknown> : null

    if (type === 'turn/start') {
      const turn = data?.['turn']
      if (typeof turn === 'number') currentTurn = turn
    } else if (type === 'user/message') {
      const source = data?.['source']
      const sourceKind = (source !== null && typeof source === 'object')
        ? (source as Record<string, unknown>)['kind']
        : undefined
      if (sourceKind === 'user') {
        const intervention = lastSubstantiveType === 'tool/result'
        current = nextRound(
          userMessageText(data) ?? '(空输入)',
          intervention,
          intervention && lastToolResultError,
        )
      }
    } else if (type === 'assistant/message') {
      const message = data?.['message']
      const content = message !== null && typeof message === 'object' ? (message as Record<string, unknown>)['content'] : undefined
      const text = extractText(content).trim()
      if (text.length > 0 && current !== null) {
        current.assistantText = truncate(text)
      }
    } else if (type === 'tool/call') {
      const callId = data?.['callId']
      const name = data?.['name']
      if (typeof callId === 'string' && typeof name === 'string') {
        const args = typeof data?.['arguments'] === 'string' ? safeParseArgs(data['arguments'] as string) : null
        calls.set(callId, { name, args })
      }
    } else if (type === 'tool/result') {
      const callId = data === null ? undefined : resolveCallId(data)
      const call = callId === undefined ? undefined : calls.get(callId)
      const failed = data !== null && isErrorResult(data)
      lastToolResultError = failed
      if (call !== undefined && current !== null) {
        calls.delete(callId as string)
        const resultData = data ?? {}
        let retried = false
        if (failed) {
          const turn = typeof data?.['turn'] === 'number' ? data['turn'] as number : (currentTurn ?? 0)
          const key = `${turn}:${call.name}`
          const count = (failedByTurnTool.get(key) ?? 0) + 1
          failedByTurnTool.set(key, count)
          retried = count >= 2
        }
        const action: CoachTimelineAction = {
          name: call.name,
          path: actionPath(call, resultData, cwd),
          failed,
          retried,
        }
        current.actions.push(action)
        if (!failed) {
          const outputPath = resolveOutputPath(call, resultData, cwd)
          if (outputPath !== null && !current.artifacts.includes(outputPath)) {
            current.artifacts.push(outputPath)
          }
        }
      }
    }

    if (type === 'user/message' || type === 'assistant/message' || type === 'tool/call' || type === 'tool/result') {
      lastSubstantiveType = type
    }
  }

  return rounds
}

/** 动作的参考/产物路径（read/write/edit/str_replace_editor 才有；其余为 null）。 */
function actionPath(call: CoachCall, data: Record<string, unknown>, cwd: string | undefined): string | null {
  const args = call.args
  if (call.name === 'read') {
    const meta = (data['meta'] !== null && typeof data['meta'] === 'object' && !Array.isArray(data['meta']))
      ? data['meta'] as Record<string, unknown>
      : undefined
    return toWorkspacePath(meta?.['path'] ?? args?.['file_path'], cwd)
  }
  if (call.name === 'read_image') {
    return toWorkspacePath(args?.['file_path'], cwd)
  }
  if (call.name === 'str_replace_editor') {
    const command = args === null ? undefined : textOf(args['command'])
    if (command === 'view') return toWorkspacePath(args?.['path'], cwd)
    return resolveOutputPath(call, data, cwd)
  }
  if (call.name === 'write' || call.name === 'edit') {
    return resolveOutputPath(call, data, cwd)
  }
  return null
}
