/**
 * 真实日志装载辅助（QA 独立验证用；非 spec，不参与 vitest 收集）。
 *
 * 数据来源：基座仓库 deepseek-harness 的真实 session 日志（只读引用，不复制）。
 * 基座 0.1.5（Session Log V3）起快照文件名为 `session.v3.jsonl`（与
 * `session.v2.jsonl` 并存），`resolveSessionLogFile` 按 原名 → v3 → v2 探测。
 * - `preview-*` 三份是带 seq/time 的运行时形态日志；
 * - `snapshots/**` 是脱敏快照：事件里没有 seq/time（全部 4565 条都缺），
 *   故由本装载器按行序补齐 seq/time；`data` 载荷原样保留，不做任何改写，
 *   仅把 `{{cwd}}` / `{{session:N}}` 占位符替换为可用值。
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type {
  AggregatorEngine,
  AggregatorEvent,
  AggregatorLineageNode,
  AggregatorSessionHeader,
  AggregatorSessionLog,
} from '../src/host/aggregator.ts'

/** 基座仓库根（相对本文件：dsh-coach/tests/ → harness/deepseek-harness/）。 */
export const BASE_ROOT = fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))

/** 是否挂载了基座仓库（未挂载时相关用例整体跳过，便于脱离基座单独跑）。 */
export const BASE_AVAILABLE = existsSync(join(BASE_ROOT, 'package.json'))

/** preview 真实会话目录（运行时形态，带 seq/time）。 */
export const PREVIEW_DIR = join(
  BASE_ROOT,
  'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--',
)

export interface LoadedSession {
  header: AggregatorSessionHeader & { createdAt?: number }
  events: AggregatorEvent[]
}

/** 把脱敏占位符替换为可用值（cwd 必须是绝对路径，否则 relativizeAgainstRoot 判定不同）。 */
function detokenize(raw: string, cwd: string): string {
  return raw
    .replaceAll('{{cwd}}', cwd)
    .replaceAll('{{session:1}}', 'snap-session-1')
    .replaceAll('{{session:2}}', 'snap-session-2')
    .replaceAll('{{session:3}}', 'snap-session-3')
}

/**
 * 基座 0.1.5（Session Log V3）把快照文件从 `session.jsonl` 改名为
 * `session.v3.jsonl`（v2/v3 并存；`session/text-turn` 仍保留旧名）。
 * 探测顺序：传入原名 → `.v3.jsonl` → `.v2.jsonl`，找不到时返回原路径
 * 让 readFileSync 抛原始 ENOENT（测试名面不变，新旧基座均可用）。
 */
function resolveSessionLogFile(file: string): string {
  if (existsSync(file)) return file
  const withoutExt = file.replace(/\.jsonl$/, '')
  for (const suffix of ['.v3.jsonl', '.v2.jsonl']) {
    const candidate = `${withoutExt}${suffix}`
    if (existsSync(candidate)) return candidate
  }
  return file
}

/**
 * 装载一份 session.jsonl。
 * @param file 绝对路径。
 * @param cwd 替换 `{{cwd}}` 的绝对路径；缺省用 `/snapshots/ws`。
 */
export function loadSessionLog(file: string, cwd = '/snapshots/ws'): LoadedSession {
  const text = readFileSync(resolveSessionLogFile(file), 'utf-8')
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const first = lines[0]
  if (first === undefined) throw new Error(`empty session log: ${file}`)
  const header = JSON.parse(detokenize(first, cwd)) as AggregatorSessionHeader
  const events: AggregatorEvent[] = []
  lines.slice(1).forEach((line, index) => {
    const parsed = JSON.parse(detokenize(line, cwd)) as Record<string, unknown>
    const type = parsed['type']
    if (typeof type !== 'string') return
    const data = parsed['data'] ?? {}
    // 快照缺 seq/time（4565/4565），按行序补齐，保证排序与 round 编号可判定
    const seq = typeof parsed['seq'] === 'number' ? parsed['seq'] : index
    const time = typeof parsed['time'] === 'number' ? parsed['time'] : 1_700_000_000_000 + index
    events.push({ type, seq, time, data })
  })
  return { header, events }
}

/**
 * 用若干真实会话构造一个结构对齐 SessionQueryEngine 的引擎。
 * - readSession → SessionLogSnapshot{session: header, events}
 * - traceSession → SessionLineageTrace{target:{header}, descendants: 由 header.parentSession 递归还原}
 */
export function makeRealEngine(sessions: readonly LoadedSession[]): AggregatorEngine {
  const byId = new Map<string, LoadedSession>()
  for (const session of sessions) byId.set(session.header.id, session)

  const childrenOf = (id: string): AggregatorLineageNode[] => {
    const kids = sessions.filter(session => session.header.parentSession === id)
    // 稳定序：createdAt 升序、id 升序（与基座 listSessions 的确定性序同向）
    kids.sort((a, b) => (a.header.createdAt ?? 0) - (b.header.createdAt ?? 0) || a.header.id.localeCompare(b.header.id))
    return kids.map(kid => ({ session: { header: kid.header }, descendants: childrenOf(kid.header.id) }))
  }

  return {
    readSession: async(id: string): Promise<AggregatorSessionLog> => {
      const session = byId.get(id)
      if (session === undefined) throw new Error(`session not found: ${id}`)
      return { session: session.header, events: session.events }
    },
    traceSession: async(id: string) => {
      const target = byId.get(id)
      if (target === undefined) throw new Error(`session not found: ${id}`)
      return { target: { header: target.header }, descendants: childrenOf(id) }
    },
  }
}
