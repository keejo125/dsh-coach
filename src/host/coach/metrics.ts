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

import { extractInjectFilePaths } from '../../shared/extract.ts'
import { normalizeWorkspacePath, relativizeAgainstRoot } from '../../shared/path.ts'
import type { CoachArtifacts, CoachContextProfile, CoachScope, CoachSignals, CoachSkillStats, CoachTokenStats } from '../../shared/types.ts'
import type { AggregatorEvent } from '../aggregator.ts'

/** Token 分布小标题：单行截断 32 字符。 */
const TURN_TEXT_LIMIT = 32
/** 抽屉下钻明细的摘要长度（比轮次标签长得多，避免「展示不全」）。 */
const DETAIL_TEXT_LIMIT = 240

function clipTokenTurnText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > TURN_TEXT_LIMIT ? `${oneLine.slice(0, TURN_TEXT_LIMIT - 1)}…` : oneLine
}

/** 抽屉明细摘要：压平换行 + 240 字符截断。 */
function clipDetailText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > DETAIL_TEXT_LIMIT ? `${oneLine.slice(0, DETAIL_TEXT_LIMIT - 1)}…` : oneLine
}

/** 扫描结果：规模/信号/产物 + completion 维度所需的「最后一个非空答复」观测。 */
export interface CoachOutputInfo {
  /** 规范化工作区相对路径。 */
  path: string
  /** 最终操作态：create=新建（write 无 diffs 或 str_replace_editor create）；update=更新。 */
  op: 'create' | 'update'
  /** 对该文件执行产物操作的次数。 */
  opCount: number
}

/** 扫描结果：规模/信号/产物 + completion 维度所需的「最后一个非空答复」观测。 */
export interface CoachScan {
  scope: CoachScope
  signals: CoachSignals
  artifacts: CoachArtifacts
  /** 主会话最后一个非空 assistant/message 文本。 */
  lastAssistantText: string | undefined
  /** 该答复是否被中断（半截输出）。 */
  lastAssistantInterrupted: boolean
  // ===== v0.2b 扩展（spec/09 §4）=====
  /** 文件 → 查看次数（read 族成功结果；失败不计入）。 */
  refCounts: ReadonlyMap<string, number>
  /** 产物路径（成功 write/edit 目标，去重，规范化相对路径）。 */
  outputPaths: readonly string[]
  /** 产物明细：路径 + 最终操作态（create|update）+ 操作次数（v0.2b 产物树）。 */
  outputs: readonly CoachOutputInfo[]
  /** Token 投影（assistant/message.data.usage 扫描；无 usage 为 null）。 */
  token: CoachTokenStats | null
  /** Skill 调用统计（tool/call name='skill' 聚合）。 */
  skills: CoachSkillStats[]
  /** 上下文构成计数 + v0.2c 下钻明细（轻量投影，不做预算截断判定）。 */
  context: Pick<CoachContextProfile, 'userItems' | 'pluginItems' | 'injectFiles' | 'finalSegments' | 'processSegments' | 'userTexts' | 'pluginSummaries' | 'delegationTexts' | 'injectPaths'>
}

interface CoachCall {
  name: string
  args: Record<string, unknown> | null
}

export function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function safeParseArgs(raw: string): Record<string, unknown> | null {
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
export function extractText(content: unknown): string {
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
export function isErrorResult(data: unknown): boolean {
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
export function resolveCallId(data: Record<string, unknown>): string | undefined {
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
export function toWorkspacePath(displayPath: unknown, cwd: string | undefined): string | null {
  const raw = textOf(displayPath)
  if (raw === undefined || raw.length === 0) return null
  const relative = relativizeAgainstRoot(raw, cwd)
  if (relative === null) return null
  return normalizeWorkspacePath(relative)
}

/**
 * 解析工具调用的产物路径（write/edit/str_replace_editor 的 create|str_replace|insert）。
 * 仅做路径解析，不判定成败；失败结果由调用方负责不入产物。
 */
export function resolveOutputPath(call: CoachCall, data: Record<string, unknown>, cwd: string | undefined): string | null {
  const meta = (data['meta'] !== null && typeof data['meta'] === 'object' && !Array.isArray(data['meta']))
    ? data['meta'] as Record<string, unknown>
    : undefined
  const args = call.args
  const argPath = (key: string): string | undefined => (args === null ? undefined : textOf(args[key]))

  if (call.name === 'write' || call.name === 'edit') {
    const diffs = Array.isArray(meta?.['diffs']) ? meta['diffs'] as unknown[] : []
    return toWorkspacePath(argPath('file_path') ?? textOf((diffs[0] as Record<string, unknown> | undefined)?.['path']), cwd)
  }
  if (call.name === 'str_replace_editor') {
    const command = args === null ? undefined : textOf(args['command'])
    if (command === 'create' || command === 'str_replace' || command === 'insert') {
      return toWorkspacePath(argPath('path'), cwd)
    }
  }
  return null
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

  // ===== v0.2b 收集器 =====
  /** 各轮次 token 增量（turn → {input, output, cache}；cache 为该轮最后一次 usage 的快照）。 */
  const tokenByTurn = new Map<number, { input: number; output: number; cache: number }>()
  /** 各轮次首个用户主动消息文本（turn → 摘要，Token 分布小标题用）。 */
  const turnTextByTurn = new Map<number, string>()
  /** 输入构成估算（字符量）：system/user/tools/plugin。 */
  const profileChars = { system: 0, user: 0, tools: 0, plugin: 0 }
  /** Skill 调用（name → {calls, failed}）。 */
  const skillByCall = new Map<string, { calls: number; failed: number }>()
  /** 待配对的 skill 调用（callId → skill 名），result 判定成败。 */
  const skillCalls = new Map<string, string>()
  /** 最后一条 usage 快照（total/cache 取末条）。 */
  let lastUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number } | undefined
  let contextUserItems = 0
  let contextPluginItems = 0
  let injectFiles = 0
  let nonEmptyTexts = 0
  // v0.2c 下钻明细收集
  const userTexts: string[] = []
  const pluginSummaries: string[] = []
  const delegationTexts: string[] = []
  const injectPaths = new Set<string>()

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
    const outputPath = resolveOutputPath(call, data, cwd)
    if (outputPath !== null) {
      const meta = (data['meta'] !== null && typeof data['meta'] === 'object' && !Array.isArray(data['meta']))
        ? data['meta'] as Record<string, unknown>
        : undefined
      const diffs = Array.isArray(meta?.['diffs']) ? meta['diffs'] as unknown[] : []
      const isCreate = (call.name === 'write' && diffs.length === 0)
        || (call.name === 'str_replace_editor' && args?.['command'] === 'create')
      recordOutput(outputPath, isCreate ? 'create' : 'update')
    }
  }

  for (const event of events) {
    const type = event.type
    const data = (event.data !== null && typeof event.data === 'object') ? event.data as Record<string, unknown> : null

    if (type === 'turn/start') {      const turn = data?.['turn']
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
          contextUserItems += 1
          if (lastSubstantiveType === 'tool/result') {
            interventions += 1
            if (lastToolResultError) correctionTurns += 1
          }
          const text = extractText(data?.['content']).trim()
          profileChars.user += text.length
          const turn = currentTurn ?? 0
          if (text.length > 0 && !turnTextByTurn.has(turn)) {
            turnTextByTurn.set(turn, clipTokenTurnText(text))
          }
          if (text.length > 0) userTexts.push(clipDetailText(text))
        } else if (sourceKind === 'plugin') {
          contextPluginItems += 1
          // 注入文件计数：复用聚合器的注入路径提取口径（snapshot/notice 摘要）
          const text = textOf(data?.['message'])
          const sourceObj = source as Record<string, unknown>
          const form = textOf(sourceObj['form'])
          const sections = sourceObj['sections']
          let texts: string[]
          if (form === 'snapshot' && Array.isArray(sections)) {
            texts = (sections as unknown[])
              .map(section => (section !== null && typeof section === 'object' ? textOf((section as Record<string, unknown>)['text']) : undefined))
              .filter((value): value is string => value !== undefined)
          } else {
            const summary = form === 'notice' ? textOf(sourceObj['summary']) : undefined
            texts = summary !== undefined && text !== undefined ? [summary, text] : [text ?? '']
          }
          profileChars.plugin += texts.reduce((sum, item) => sum + item.length, 0)
          const paths = extractInjectFilePaths(form, texts)
          if (paths.length > 0) {
            injectFiles += new Set(paths).size
            paths.forEach(path => injectPaths.add(path))
          }
          pluginSummaries.push(clipDetailText(texts.filter(t => t.length > 0).join(' ') || form || ''))
        } else if (sourceKind === 'agent-instructions' || sourceKind === 'team-message') {
          // C02：委派文本同时采 agent-instructions 与 team-message（团队消息同为系统委派）
          const text = extractText(data?.['content']).trim()
          profileChars.system += text.length
          if (text.length > 0) delegationTexts.push(clipDetailText(text))
        }
      }
    } else if (type === 'request/header') {
      const header = data?.['header']
      const system = (header !== null && typeof header === 'object')
        ? textOf((header as Record<string, unknown>)['system'])
        : undefined
      if (system !== undefined) profileChars.system += system.length
    } else if (type === 'assistant/message') {
      assistantSteps += 1
      const message = data?.['message']
      const content = message !== null && typeof message === 'object' ? (message as Record<string, unknown>)['content'] : undefined
      const text = extractText(content)
      if (text.trim().length > 0) {
        lastAssistantText = text
        lastAssistantInterrupted = data?.['interrupted'] === true
        nonEmptyTexts += 1
      }
      // —— Token 投影：官方 usage（token-meter 写入事件流）——
      const usage = data?.['usage']
      if (usage !== null && typeof usage === 'object') {
        const u = usage as Record<string, unknown>
        const input = typeof u['inputTokens'] === 'number' ? u['inputTokens'] as number : undefined
        const output = typeof u['outputTokens'] === 'number' ? u['outputTokens'] as number : undefined
        const cache = typeof u['cacheReadTokens'] === 'number' ? u['cacheReadTokens'] as number : undefined
        const total = typeof u['totalTokens'] === 'number' ? u['totalTokens'] as number : undefined
        if (input !== undefined || output !== undefined || cache !== undefined || total !== undefined) {
          lastUsage = {
            inputTokens: input ?? 0,
            outputTokens: output ?? 0,
            cacheReadTokens: cache ?? 0,
            totalTokens: total ?? 0,
          }
          const turn = typeof data?.['turn'] === 'number' ? data['turn'] as number : (currentTurn ?? 0)
          const bucket = tokenByTurn.get(turn) ?? { input: 0, output: 0, cache: 0 }
          bucket.input += input ?? 0
          bucket.output += output ?? 0
          bucket.cache = cache ?? 0
          tokenByTurn.set(turn, bucket)
        }
      }
      const turn = data?.['turn']
      if (typeof turn === 'number') turns.add(turn)
    } else if (type === 'tool/call') {
      const callId = data?.['callId']
      const name = data?.['name']
      if (typeof callId === 'string' && typeof name === 'string') {
        const args = typeof data?.['arguments'] === 'string' ? safeParseArgs(data['arguments'] as string) : null
        calls.set(callId, { name, args })
        if (typeof data?.['arguments'] === 'string') {
          profileChars.tools += (data['arguments'] as string).length
        }
        // Skill 调用：tool name='skill'，arguments.name 为 skill 名
        if (name === 'skill') {
          const skillName = textOf(args?.['name'])
          if (skillName !== undefined && skillName.length > 0) skillCalls.set(callId, skillName)
        }
      }
      const turn = data?.['turn']
      if (typeof turn === 'number') turns.add(turn)
    } else if (type === 'tool/result') {
      const callId = data === null ? undefined : resolveCallId(data)
      const call = callId === undefined ? undefined : calls.get(callId)
      const failed = data !== null && isErrorResult(data)
      // Skill 结果配对：计入调用统计
      const skillName = callId === undefined ? undefined : skillCalls.get(callId)
      if (skillName !== undefined && call !== undefined) {
        skillCalls.delete(callId as string)
        const entry = skillByCall.get(skillName) ?? { calls: 0, failed: 0 }
        entry.calls += 1
        if (failed) entry.failed += 1
        skillByCall.set(skillName, entry)
      }
      if (call !== undefined) {
        calls.delete(callId as string)
        toolCalls += 1
        // 输入构成：工具结果文本（message.content）计入 tools
        const resultText = (() => {
          const message = data?.['message']
          if (message !== null && typeof message === 'object') {
            return extractText((message as Record<string, unknown>)['content']).length
          }
          return 0
        })()
        profileChars.tools += resultText
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

  // —— Token 投影（无 usage 数据 → null，UI 降级显示「未启用」）——
  let token: CoachTokenStats | null = null
  if (lastUsage !== undefined) {
    const perTurn = [...tokenByTurn.entries()]
      .sort(([a], [b]) => a - b)
      .map(([turn, bucket]) => ({
        turn,
        input: bucket.input,
        output: bucket.output,
        total: bucket.input + bucket.output + bucket.cache,
        text: turnTextByTurn.get(turn) ?? '',
      }))
    // 总量优先取末条 usage.totalTokens；旧日志缺该字段时为 0/undefined，降级为按轮总量最大值
    const lastTotal = typeof lastUsage.totalTokens === 'number' ? lastUsage.totalTokens : 0
    token = {
      total: lastTotal > 0 ? lastTotal : Math.max(0, ...perTurn.map(p => p.total)),
      input: [...tokenByTurn.values()].reduce((sum, bucket) => sum + bucket.input, 0),
      output: [...tokenByTurn.values()].reduce((sum, bucket) => sum + bucket.output, 0),
      cache: lastUsage.cacheReadTokens,
      perTurn,
      profile: {
        system: profileChars.system,
        user: profileChars.user,
        tools: profileChars.tools,
        plugin: profileChars.plugin,
      },
    }
  }

  const finalSegments = nonEmptyTexts > 0 ? 1 : 0

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
    files: [...outputs.entries()]
      .map(([path, state]) => ({ path, op: state.op, opCount: state.opCount }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  }

  return {
    scope,
    signals,
    artifacts,
    lastAssistantText,
    lastAssistantInterrupted,
    // v0.2b
    refCounts,
    outputPaths: [...outputs.keys()],
    outputs: [...outputs.entries()].map(([path, state]) => ({
      path,
      op: state.op,
      opCount: state.opCount,
    })),
    token,
    skills: [...skillByCall.entries()]
      .map(([name, entry]) => ({ name, calls: entry.calls, failed: entry.failed }))
      .sort((a, b) => b.calls - a.calls),
    context: {
      userItems: contextUserItems,
      pluginItems: contextPluginItems,
      injectFiles,
      finalSegments,
      processSegments: Math.max(0, nonEmptyTexts - finalSegments),
      userTexts,
      pluginSummaries,
      delegationTexts,
      injectPaths: [...injectPaths],
    },
  }
}
