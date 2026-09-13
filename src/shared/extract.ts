/**
 * 注入消息文件路径提取纯函数（设计文档 §3.5 六步规则）。
 *
 * 输入：注入条目的 form 与若干段文本（snapshot form 逐 sections[].text
 * 独立传入后合并；notice 的 summary 也作为候选文本传入）。
 * 输出：规范化相对路径数组（去重保序）。
 *
 * 兜底策略（宁缺勿错）：全文无任何候选路径时返回空数组，该注入条目仅留在
 * 折叠区不出现在注入文件树；疑似但不合法的 token 不猜测补全。
 */

import { EXCLUDED_PATH_PREFIXES, KNOWN_EXTENSIONLESS_FILENAMES, KNOWN_INJECT_DOC_NAMES } from './constants.ts'
import { normalizeWorkspacePath } from './path.ts'

/** 显式动词模式：读取/Read/加载/文件：等动词后紧跟的路径 token。 */
const EXPLICIT_VERB_RE =
  /(?:读取|读一下|查看|加载|参考|阅读|[Rr]ead|[Ll]oad|[Ff]ile|文件)[：:\s]+([^\s，。；、""''`()\[\]<>]+)/g

/** markdown 链接 `[x](path)` 中的路径目标。 */
const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g

/** 行内代码 `` `...` ``（整段取出后按空白拆词再筛）。 */
const INLINE_CODE_RE = /`([^`\n]+)`/g

/**
 * 通用路径模式：含 `/` 的相对路径 token（§3.5 规则 3）。
 * 形如 `(^\.{0,2}/)?[\w.@-]+(/[\w.@-]+)+`，两侧以边界定界。
 */
const GENERIC_PATH_RE = /(?:^|[\s(`"'[>，。；：!?,.;:）」])(\.{0,2}\/?[\w.@-]+(?:\/[\w.@-]+)+)(?=$|[\s)`"'\\\]<>，。；：!?,.;）」])/g

/** 已知注入文档名（无斜杠文件名）：AGENTS.md / CLAUDE.md / README.md / SKILL.md。 */
// 必须带 'g'：matchAll 要求全局正则（曾因缺 'g' 抛 TypeError）。
// matchAll 内部以 species 构造副本迭代，不会污染本正则的 lastIndex。
const DOC_NAME_RE = new RegExp(
  String.raw`(?:^|[\s\`"'(\[>，。；：])((?:[\w.@-]+\/)*)(AGENTS\.md|CLAUDE\.md|README\.md|SKILL\.md)(?=$|[\s\`"')\]\]<，。；：,.;])`,
  'g',
)

const URL_RE = /^https?:\/\//i
const FLAG_RE = /^-/
const PURE_NUMBER_OR_VERSION_RE = /^[\w.@-]*\d[\d.]*$/

/** `file:line` 行号后缀（`docs/spec.md:12`、`docs/spec.md:12-20`）。 */
const LINE_SUFFIX_RE = /:\d+(?:-\d+)?$/

/** 末段是否「带扩展名」：有点且点后还有字符——`.env` 算，`src/foo.` 不算。 */
const HAS_EXTENSION_RE = /\.[^./]+$/

/**
 * 末段是否可信为文件名。
 *
 * 这是剔除假阳性的核心判据。设计口径是「宁缺勿错」——宁可漏，也不把非文件塞进
 * 注入文件树。真实 12-agent 会话上它一次性挡掉四类噪声（均无扩展名）：
 * 裸词 `sandbox`/`guards`、工具类别名 `Bash/formatters`、npm 包名
 * `@deepseek-ai/dsh-session-persistence-jsonl`、目录 `src/components`。
 *
 * 代价：合法但无扩展名的文件会被漏掉，故用 `KNOWN_EXTENSIONLESS_FILENAMES`
 * 白名单补回（KNOWN_INJECT_DOC_NAMES 里的名字本身都带 `.md`，无需额外放行）。
 *
 * 关于「是否改用文件系统 stat 判目录」的取舍：不采用。src/shared 按 §2 是
 * 无 IO 纯逻辑层且被 client 侧共用，引入 stat 会破坏分层；且日志是历史快照，
 * 文件可能已被删除或改动，stat 失败反而会把真阳性误杀——比漏提噪声更糟。
 */
function looksLikeFileName(segment: string): boolean {
  return HAS_EXTENSION_RE.test(segment) || KNOWN_EXTENSIONLESS_FILENAMES.includes(segment)
}

/** 单个原始 token 的过滤与规范化：命中排除项返回 null。 */
function acceptCandidate(raw: string): string | null {
  let token = raw.trim()
  if (token.length === 0) return null
  // 剥掉成对包裹符
  const wrapPairs: ReadonlyArray<readonly [string, string]> = [['(', ')'], ['[', ']'], ['<', '>'], ['"', '"'], ['\'', '\'']]
  for (const [open, close] of wrapPairs) {
    if (token.startsWith(open) && token.endsWith(close) && token.length >= 2) {
      token = token.slice(1, -1).trim()
    }
  }
  if (token.length === 0) return null
  if (URL_RE.test(token)) return null // http(s):// URL
  if (FLAG_RE.test(token)) return null // 命令行 flag
  if (PURE_NUMBER_OR_VERSION_RE.test(token)) return null // 纯数字/版本号
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (token.startsWith(prefix)) return null // 基座内部前缀
  }
  // 先剥 file:line 行号后缀再判冒号：`docs/spec.md:12` 仍是真阳性，应当保留文件部分。
  // 其余含冒号的一律拒——`policy:` 正是从「DSH file policy: workspace-write」里
  // 被动词模式连同结尾冒号一起捕获的字段名/策略名，不是路径。
  token = token.replace(LINE_SUFFIX_RE, '')
  if (token.includes(':')) return null
  // 末段必须是文件名形态：挡掉裸词、工具类别名、npm 包名与目录条目（见 looksLikeFileName）
  const lastSegment = token.split('/').at(-1) ?? ''
  if (!looksLikeFileName(lastSegment)) return null
  // 规范化：去 ./ 、折叠多斜杠、解析 ..（逃逸出工作区即丢弃）
  return normalizeWorkspacePath(token)
}

/** URL 模式：连同其后 token 整体剥离（§3.5 规则 4：排除 http(s):// URL）。 */
const URL_STRIP_RE = /https?:\/\/\S+/gi

/** 收集一段文本里的全部原始候选 token（按规则 1-3 的来源合并）。 */
function collectTokens(text: string): string[] {
  const cleaned = text.replace(URL_STRIP_RE, ' ')
  const tokens: string[] = []
  for (const match of cleaned.matchAll(EXPLICIT_VERB_RE)) {
    const value = match[1]
    if (value !== undefined) tokens.push(value)
  }
  for (const match of cleaned.matchAll(MARKDOWN_LINK_RE)) {
    const value = match[1]
    if (value !== undefined) tokens.push(value)
  }
  for (const match of cleaned.matchAll(INLINE_CODE_RE)) {
    const value = match[1]
    if (value === undefined) continue
    for (const word of value.split(/\s+/)) {
      if (word.includes('/') || KNOWN_INJECT_DOC_NAMES.includes(word)) tokens.push(word)
    }
  }
  for (const match of cleaned.matchAll(GENERIC_PATH_RE)) {
    const value = match[1]
    if (value !== undefined) tokens.push(value)
  }
  for (const match of cleaned.matchAll(DOC_NAME_RE)) {
    const dir = match[1] ?? ''
    const name = match[2] ?? ''
    if (name !== '') tokens.push(`${dir}${name}`)
  }
  return tokens
}

/**
 * 从注入条目文本提取工作区相对路径（§3.5）。
 *
 * @param form 注入语义小类；`'snapshot'` 时 texts 应为逐 sections[].text
 *        独立传入的数组（每段独立提取后合并）。
 * @param texts 候选文本段（notice 的 summary 亦应传入）。
 * @returns 规范化相对路径数组（去重保序）；无候选返回空数组。
 */
export function extractInjectFilePaths(form: string | undefined, texts: readonly string[]): string[] {
  void form // form 当前不改变提取规则，仅约定 snapshot 的 texts 切分方式；保留参数位以对齐契约
  const result: string[] = []
  const seen = new Set<string>()
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue
    for (const raw of collectTokens(text)) {
      const normalized = acceptCandidate(raw)
      if (normalized === null) continue
      if (seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}
