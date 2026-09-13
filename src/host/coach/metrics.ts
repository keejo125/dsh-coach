/**
 * 复盘指标扫描：从会话事件流计算 v0.2a 口径的规模/信号/产物指标。
 *
 * 与聚合器（aggregator.ts）各自独立扫描——指标语义不同，不复用其内部状态。
 * 口径约定（spec/08）：
 * - 追问 followUps = max(0, userTurns - 1)：首个用户消息是初始任务，其后都算追问；
 * - 干预 interventions = 用户消息紧邻其前一个事件是 tool/result；
 * - 纠错 correctionTurns = 干预中其前的 tool/result 是失败的；
 * - 失败重试 retriedFailures = 同一轮次内同一工具名失败 ≥ 2 次的分组数；
 * - 重复读 repeatedReadFiles = 同一文件被 read ≥ 2 次的文件数（v1 不比对内容）；
 * - 压缩 compactions = compaction/start 事件数；
 * - 失败的工具结果不计入参考/产物（与聚合器 §3.7 同口径）。
 */

import { normalizeWorkspacePath, relativizeAgainstRoot } from '../../shared/path.ts'
import type { CoachArtifacts, CoachScope, CoachSignals } from '../../shared/types.ts'
import type { AggregatorEvent } from '../aggregator.ts'

/** 扫描结果：规模/信号/产物 + completion 维度所需的「最后一个非空答复」观测。 */
export interface CoachScan {
  scope: CoachScope
  signals: CoachSignals
  artifacts: CoachArtifacts
  /** 主会话最后一个非空 assistant/message 文本。 */
  lastAssistantText: string | undefined
  /** 该答复是否被中断（半截输出）。 */
  lastAssistantInterrupted: boolean
}

interface CoachCall {
  name: string
  args: Record<string, unknown> | null
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function safeParseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** 从 content 块提取拼接文本（与聚合器 extractMessageContent 的 text 部分同口径）。 */
function extractText(content: unknown): string {
  const texts: string[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') texts.push(record['text'])
    }
  }
  return texts.join('\n')
}

/** 判定 tool/result 是否失败：顶层 error 或 content 块 isError。 */
function isErrorResult(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false
  const record = data as Record<string, unknown>
  if (record['error'] !== undefined && record['error'] !== null) return true
  const content = (record['message'] as Record<string, unknown> | undefined)?.['content']
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === 'object' && (block as Record<string, unknown>)['isError'] === true) return true
    }
  }
  return false
}

/** 取 tool/result 的 callId（顶层或 message.source.callId；基座实际在 message.source.callId）。 */
function resolveCallId(data: Record<string, unknown>): string | undefined {
  const top = data['callId']
  if (typeof top === 'string' && top.length > 0) return top
  const message = data['message']
  if (message !== null && typeof message === 'object') {
    const source = (message as Record<string, unknown>)['source']
    if (source !== null && typeof source === 'object') {
      const id = (source as Record<string, unknown>)['callId']
      if (typeof id === 'string' && id.length > 0) return id
    }
  }
  return undefined
}

/** 把基座展示路径折算成规范化工作区相对路径；不可解析返回 null（静默丢弃）。 */
function toWorkspacePath(displayPath: unknown, cwd: string | undefined): string | null {
  const raw = textOf(displayPath)
  if (raw === undefined || raw.length === 0) return null
  const relative = relativizeAgainstRoot(raw, cwd)
  if (relative === null) return null
  return normalizeWorkspacePath(relative)
}

interface OutputState {
  op: 'create' | 'update'
  opCount: number
}

/**
 * 单遍扫描会话事件流。
 * @param events 会话事件流。
 * @param cwd 会话工作区根（路径相对化锚点；缺失时展示路径原样规范化）。
 */
export function scanCoachEvents(events: readonly AggregatorEvent[], cwd: string | undefined): CoachScan {
  const calls = new Map<string, CoachCall>()
  const refCounts = new Map<string, number>()
  const outputs = new Map<string, OutputState>()
  const failedByTurnTool = new Map<string, number>()
  const turns = new Set<number>()

  let currentTurn: number | undefined
  let userTurns = 0
  let assistantSteps = 0
  let toolCalls = 0
  let failedToolCalls = 0
  let compactions = 0
  let interventions = 0
  let correctionTurns = 0
  /**
   * 最后一个「实质事件」类型：只随 user/message、assistant/message、tool/call、
   * tool/result 更新。turn/start 等结构性事件不更新——干预判定的语义是
   * 「用户看到上一个实质动作（工具结果）后介入」，中间隔几个结构性事件不影响。
   */
  let lastSubstantiveType: string | undefined
  let lastToolResultError = false
  let lastAssistantText: string | undefined
  let lastAssistantInterrupted = false

  /** 把一次成功的工具结果归入参考（read 族）或产物（write/edit 族）。 */
  const classify = (call: CoachCall, data: Record<string, unknown>): void => {
    const meta = (data['meta'] !== null && typeof data['meta'] === 'object' && !Array.isArray(data['meta']))
      ? data['meta'] as Record<string, unknown>
      : undefined
    const args = call.args
    const argPath = (key: string): string | undefined => (args === null ? undefined : textOf(args[key]))

    // —— 参考计数：read / read_image / str_replace_editor view ——
    let refPath: string | undefined
    if (call.name === 'read') {
      refPath = textOf(meta?.['path']) ?? argPath('file_path')
    } else if (call.name === 'read_image') {
      refPath = argPath('file_path')
    } else if (call.name === 'str_replace_editor') {
      if (args !== null && args['command'] === 'view') refPath = argPath('path')
    }
    if (refPath !== undefined) {
      const normalized = toWorkspacePath(refPath, cwd)
      if (normalized !== null) refCounts.set(normalized, (refCounts.get(normalized) ?? 0) + 1)
      return
    }

    // —— 产物操作：write / edit / str_replace_editor(create|str_replace|insert) ——
    const recordOutput = (path: string, op: 'create' | 'update'): void => {
      const existing = outputs.get(path)
      if (existing === undefined) {
        outputs.set(path, { op, opCount: 1 })
      } else {
        existing.op = op
        existing.opCount += 1
      }
    }
    if (call.name === 'write') {
      const diffs = Array.isArray(meta?.['diffs']) ? meta['diffs'] as unknown[] : []
      const path = toWorkspacePath(argPath('file_path') ?? textOf((diffs[0] as Record<string, unknown> | undefined)?.['path']), cwd)
      if (path !== null) recordOutput(path, diffs.length > 0 ? 'update' : 'create')
    } else if (call.name === 'edit') {
      const diffs = Array.isArray(meta?.['diffs']) ? meta['diffs'] as unknown[] : []
      const path = toWorkspacePath(argPath('file_path') ?? textOf((diffs[0] as Record<string, unknown> | undefined)?.['path']), cwd)
      if (path !== null) recordOutput(path, 'update')
    } else if (call.name === 'str_replace_editor') {
      const command = args === null ? undefined : textOf(args['command'])
      if (command === 'create' || command === 'str_replace' || command === 'insert') {
        const path = toWorkspacePath(argPath('path'), cwd)
        if (path !== null) recordOutput(path, command === 'create' ? 'create' : 'update')
      }
    }
  }

  for (const event of events) {
    const type = event.type
    const data = (event.data !== null && typeof event.data === 'object') ? event.data as Record<string, unknown> : null

    if (type === 'turn/start') {
      const turn = data?.['turn']
      if (typeof turn === 'number') {
        turns.add(turn)
        currentTurn = turn
      }
    } else if (type === 'user/message') {
      const source = data?.['source']
      if (source !== null && typeof source === 'object') {
        const sourceKind = (source as Record<string, unknown>)['kind']
        if (sourceKind === 'user') {
          userTurns += 1
          if (lastSubstantiveType === 'tool/result') {
            interventions += 1
            if (lastToolResultError) correctionTurns += 1
          }
        }
      }
    } else if (type === 'assistant/message') {
      assistantSteps += 1
      const message = data?.['message']
      const content = message !== null && typeof message === 'object' ? (message as Record<string, unknown>)['content'] : undefined
      const text = extractText(content)
      if (text.trim().length > 0) {
        lastAssistantText = text
        lastAssistantInterrupted = data?.['interrupted'] === true
      }
      const turn = data?.['turn']
      if (typeof turn === 'number') turns.add(turn)
    } else if (type === 'tool/call') {
      const callId = data?.['callId']
      const name = data?.['name']
      if (typeof callId === 'string' && typeof name === 'string') {
        const args = typeof data?.['arguments'] === 'string' ? safeParseArgs(data['arguments'] as string) : null
        calls.set(callId, { name, args })
      }
      const turn = data?.['turn']
      if (typeof turn === 'number') turns.add(turn)
    } else if (type === 'tool/result') {
      const callId = data === null ? undefined : resolveCallId(data)
      const call = callId === undefined ? undefined : calls.get(callId)
      const failed = data !== null && isErrorResult(data)
      if (call !== undefined) {
        calls.delete(callId as string)
        toolCalls += 1
        if (failed) {
          failedToolCalls += 1
          const turn = typeof data?.['turn'] === 'number' ? data['turn'] as number : (currentTurn ?? 0)
          const key = `${turn}:${call.name}`
          failedByTurnTool.set(key, (failedByTurnTool.get(key) ?? 0) + 1)
        } else {
          // 成功结果才计入参考/产物（失败读/写不算「查看/产出」）
          classify(call, data as Record<string, unknown>)
        }
      }
      lastToolResultError = failed
      const turn = data?.['turn']
      if (typeof turn === 'number') turns.add(turn)
    } else if (type === 'compaction/start') {
      compactions += 1
    }
    // 其余事件零成本跳过；结构性事件（turn/start、system/message 等）不更新「最后一个实质事件」
    if (type === 'user/message' || type === 'assistant/message' || type === 'tool/call' || type === 'tool/result') {
      lastSubstantiveType = type
    }
  }

  const repeatedReadFiles = [...refCounts.values()].filter(count => count >= 2).length
  const retriedFailures = [...failedByTurnTool.values()].filter(count => count >= 2).length

  const scope: CoachScope = {
    turns: turns.size,
    userTurns,
    assistantSteps,
    toolCalls,
    failedToolCalls,
    // 委派数由 report 层从 traceSession 谱系填写（扫描只对单会话事件负责）
    delegations: 0,
  }
  const signals: CoachSignals = {
    followUps: Math.max(0, userTurns - 1),
    interventions,
    correctionTurns,
    repeatedReadFiles,
    retriedFailures,
    compactions,
  }
  const artifacts: CoachArtifacts = {
    writtenFiles: outputs.size,
    createdFiles: [...outputs.values()].filter(state => state.op === 'create').length,
    updatedFiles: [...outputs.values()].filter(state => state.opCount >= 2).length,
  }

  return { scope, signals, artifacts, lastAssistantText, lastAssistantInterrupted }
}
