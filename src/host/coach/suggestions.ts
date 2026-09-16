/**
 * P3 复盘建议（spec/09 §P3）：从交互过程确定性提炼 知识 / 规则 / 偏好，
 * 并检测 AGENTS.md 规约落点（~/.dsh/AGENTS.md 用户全局 + 工作区 AGENTS.md/CLAUDE.md）。
 *
 * 设计约束（用户已拍板）：
 * - 只做「提炼 + 建议」，不自动注入上下文；
 * - 采纳后把内容写入对应 AGENTS.md（DSH 每次会话自动加载 → 模型自然读到，等效「告诉大模型」）；
 * - v1 全部为确定性启发式（无 LLM 依赖，可单测、可审计），后续可升级 LLM 提炼。
 */

import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { access, appendFile, mkdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import type { AggregatorEngine } from '../aggregator.ts'
import type {
  CoachAcceptResult,
  CoachMemoryTarget,
  CoachSuggestion,
  CoachSuggestionKind,
  CoachSuggestions,
  CoachTimelineRound,
} from '../../shared/types.ts'
import { CoachSessionUnavailableError } from './report.ts'
import { scanCoachRounds } from './timeline.ts'

/** 建议总量上限（避免复盘页噪音）。 */
const MAX_ITEMS = 8
/** 每类上限：偏好 3 / 规则 3 / 知识 4。 */
const PER_KIND_LIMIT: Record<CoachSuggestionKind, number> = { preference: 3, rule: 3, knowledge: 4 }

/** 偏好句式（用户呈现/行为习惯的显式表达）。 */
const PREFERENCE_PATTERNS: Array<{ re: RegExp; title: string }> = [
  {
    re: /(用|以|按|采用)[^，。;；]{0,10}(中文|英文|双语|简体|繁体|竖版|横版|表格|流程图|markdown|md|卡片|列表|简洁|详细|正式|口语)/i,
    title: '内容呈现偏好',
  },
  {
    re: /(以后|每次|始终|尽量|优先|最好|请一定|记得|后续)[^，。;；]{0,20}/,
    title: '行为约束偏好',
  },
  {
    re: /(我|我们|本人)(喜欢|习惯|常用|偏好|倾向|希望|要求)[^，。;；]{0,30}/,
    title: '个人习惯偏好',
  },
]

/** 规则句式（明确的"不要/必须/以后"类操作约定）。 */
const RULE_PATTERNS: Array<{ re: RegExp; title: string }> = [
  {
    re: /(不要|别|避免|禁止|别再)[^，。;；]{0,24}/,
    title: '禁止性操作约定',
  },
  {
    re: /(以后|每次|始终|尽量|优先|最好|记得|必须|一定)[^，。;；]{0,20}(不要|别|避免|禁止|先|再|保持|统一)/,
    title: '操作流程约定',
  },
]

/** 产物文件 → 人类可读用途（按扩展名归口）。 */
function describeFileKind(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return '页面'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return '文档'
  if (lower.endsWith('.ts') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return '脚本'
  if (lower.endsWith('.py')) return 'Python 脚本'
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'Shell 脚本'
  if (lower.endsWith('.css')) return '样式'
  if (lower.endsWith('.json')) return '配置/数据'
  if (lower.endsWith('.csv')) return '数据表'
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx') || lower.endsWith('.vue')) return '组件'
  return '文件'
}

/** 截取用户消息首句（按。！？换行切分，去空白）。 */
function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  const match = trimmed.match(/^[^。！？!?\n]{1,80}/)
  const sentence = match ? match[0].trim() : trimmed.slice(0, 80)
  return sentence.length > 0 ? sentence : trimmed.slice(0, 80)
}

/** 规范化为写入用的单行内容（去换行、去前后空格）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 从轮次列表提炼建议（纯函数，可单测）。
 * @param rounds 交互时间线轮次。
 * @param targets 已检测的落点。
 */
export function scanCoachSuggestions(
  rounds: readonly CoachTimelineRound[],
  targets: readonly CoachMemoryTarget[],
): CoachSuggestion[] {
  const items: CoachSuggestion[] = []
  const seen = new Set<string>()
  const globalTarget = targets.find(target => target.kind === 'global')
  const workspaceTarget = targets.find(target => target.kind === 'workspace')

  const push = (kind: CoachSuggestionKind, title: string, content: string, basis: string): void => {
    if (targets.length === 0) return
    const target = kind === 'preference' && globalTarget !== undefined ? globalTarget
      : workspaceTarget !== undefined ? workspaceTarget
      : globalTarget ?? targets[0]!
    const key = `${kind}:${content}`
    if (seen.has(key)) return
    if (items.filter(item => item.kind === kind).length >= PER_KIND_LIMIT[kind]) return
    if (items.length >= MAX_ITEMS) return
    seen.add(key)
    items.push({
      id: `${kind}-${items.length + 1}`,
      kind,
      title,
      content: oneLine(content).slice(0, 140),
      basis,
      target,
    })
  }

  // —— 规则：纠错轮 + 明确"不要/必须"句式 ——
  for (let index = 0; index < rounds.length; index++) {
    const round = rounds[index]
    if (round === undefined) continue
    const text = oneLine(round.userText)
    if (text.length < 4) continue
    const basis = `${round.kind === 'initial' ? '初始任务' : `R${index + 1}`} · ${firstSentence(text)}`
    if (round.signals.correction && text.length <= 160) {
      push('rule', '纠错约定', `用户在第 ${index + 1} 轮纠正了执行（「${text.slice(0, 90)}」），后续同类任务应避免同样的错误。`, basis)
      continue
    }
    for (const pattern of RULE_PATTERNS) {
      const match = text.match(pattern.re)
      if (match && text.length <= 160) {
        push('rule', pattern.title, `在任务执行中：${text.slice(0, 120)}`, basis)
        break
      }
    }
  }

  // —— 偏好：明确的呈现/习惯句式（followup 轮优先；排除疑问句）——
  const QUESTION_RE = /[？?]|怎么|如何|能否|为什么|行不行|可不可以|难道|是不是/
  for (let index = 0; index < rounds.length; index++) {
    const round = rounds[index]
    if (round === undefined || round.kind === 'initial') continue
    const text = oneLine(round.userText)
    if (text.length < 6 || text.length > 140 || QUESTION_RE.test(text)) continue
    for (const pattern of PREFERENCE_PATTERNS) {
      const match = text.match(pattern.re)
      if (match && text.length <= 140) {
        push('preference', pattern.title, `用户偏好：${text.slice(0, 120)}`, `R${index + 1} · ${firstSentence(text)}`)
        break
      }
    }
  }

  // —— 知识：新建产物 + 高频引用（从轮次聚合）——
  const artifactSeen = new Set<string>()
  const refViews = new Map<string, number>()
  const refRounds = new Map<string, number>()
  for (const round of rounds) {
    if (round === undefined) continue
    for (const file of round.artifacts) {
      if (file.op === 'create' && !artifactSeen.has(file.path)) {
        artifactSeen.add(file.path)
        const base = file.path.split('/').pop() ?? file.path
        push(
          'knowledge',
          '会话产物',
          `会话新建了 ${file.path}（${describeFileKind(file.path)}），可复用作为后续任务的参考。`,
          `产物 · ${base}`,
        )
      }
    }
    for (const reference of round.references) {
      const views = (refViews.get(reference.path) ?? 0) + reference.views
      refViews.set(reference.path, views)
      refRounds.set(reference.path, (refRounds.get(reference.path) ?? 0) + 1)
    }
  }
  const topRefs = [...refViews.entries()]
    .filter(([, views]) => views >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
  for (const [path, views] of topRefs) {
    const roundsCount = refRounds.get(path) ?? 1
    push(
      'knowledge',
      '高频参考文件',
      `${path} 在本会话被参考 ${views} 次（跨 ${roundsCount} 轮），是项目关键文件，后续任务可直接复用。`,
      `引用 · ${path}`,
    )
  }

  return items
}

/** 检测 AGENTS.md 规约落点（用户全局 + 工作区）。 */
export async function detectMemoryTargets(cwd: string | undefined): Promise<CoachMemoryTarget[]> {
  const targets: CoachMemoryTarget[] = []
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const globalPath = join(dshHome, 'AGENTS.md')
  targets.push({ kind: 'global', path: globalPath, exists: await pathExists(globalPath) })
  if (cwd !== undefined && cwd.length > 0) {
    const workspacePath = await resolveWorkspaceAgentsPath(cwd)
    targets.push({ kind: 'workspace', path: workspacePath, exists: await pathExists(workspacePath) })
  }
  return targets
}

/** 工作区规约文件：优先 AGENTS.md，其次 CLAUDE.md。 */
async function resolveWorkspaceAgentsPath(cwd: string): Promise<string> {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const candidate = resolvePath(cwd, name)
    if (await pathExists(candidate)) return candidate
  }
  return resolvePath(cwd, 'AGENTS.md')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 端点入口：读会话 → 扫描轮次 → 检测落点 → 提炼。 */
export async function buildCoachSuggestions(engine: AggregatorEngine, sessionId: string): Promise<CoachSuggestions> {
  let log
  try {
    log = await engine.readSession(sessionId)
  } catch (error) {
    if (error instanceof Error && ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError'].includes(error.name)) {
      throw error
    }
    throw new CoachSessionUnavailableError()
  }
  const rounds = scanCoachRounds(log.events, log.session.cwd)
  const targets = await detectMemoryTargets(log.session.cwd)
  return {
    sessionId,
    generatedAt: Date.now(),
    targets,
    items: scanCoachSuggestions(rounds, targets),
  }
}

/** 采纳建议：把内容追加写入目标 AGENTS.md（不存在则创建）。 */
export async function acceptCoachSuggestion(
  engine: AggregatorEngine,
  sessionId: string,
  suggestionId: string,
): Promise<CoachAcceptResult> {
  const suggestions = await buildCoachSuggestions(engine, sessionId)
  const suggestion = suggestions.items.find(item => item.id === suggestionId)
  if (suggestion === undefined) {
    return { suggestionId, ok: false, path: '', created: false, message: `suggestion ${suggestionId} not found` }
  }
  const target = suggestions.targets.find(item => item.path === suggestion.target.path) ?? suggestion.target
  const content = `<!-- dsh-coach ${suggestion.kind}: ${suggestion.title} · ${new Date().toISOString().slice(0, 10)} -->\n${suggestion.content}\n`
  try {
    await mkdir(dirname(target.path), { recursive: true })
    const created = !(await pathExists(target.path))
    await appendFile(target.path, `\n${content}`, { encoding: 'utf8' })
    return {
      suggestionId,
      ok: true,
      path: target.path,
      created,
      message: created ? `已新建 ${target.path} 并写入` : `已追加到 ${target.path}`,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { suggestionId, ok: false, path: target.path, created: false, message: `写入失败：${detail}` }
  }
}

function dirname(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
}
