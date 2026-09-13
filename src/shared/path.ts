/**
 * 路径规范化与安全校验纯函数（§7.1）。
 * 统一 POSIX 风格 `/` 分隔；树构建与去重一律用规范化后路径做 key。
 */

/**
 * 规范化一条「工作区相对路径」。
 *
 * - 统一 POSIX 风格 `/` 分隔；去前导 `./`；折叠连续 `/`；空段剔除。
 * - `..` 段：解析后仍在工作区内的保留其规范化结果（弹出上一段）；
 *   逃逸出工作区的整条丢弃，返回 `null`（不向上截断重写）。
 * - 绝对路径（`/` 或盘符开头）不属于工作区相对路径，返回 `null`；
 *   host 侧需要先把基座 meta.path 的绝对展示路径相对化（对会话 header.cwd
 *   求前缀）后再传入本函数。
 *
 * @returns 规范化相对路径；空串、绝对路径或逃逸出工作区时返回 `null`。
 */
export function normalizeWorkspacePath(input: string): string | null {
  if (input.length === 0) return null
  const posix = input.replaceAll('\\', '/')
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null
  const out: string[] = []
  for (const seg of posix.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      const parent = out.pop()
      if (parent === undefined) return null // 逃逸出工作区
      continue
    }
    out.push(seg)
  }
  return out.length === 0 ? null : out.join('/')
}

/**
 * 是否属于「非相对路径」：绝对路径、盘符、反斜杠分隔符。
 *
 * file 端点安全链**第 1 级**的拒因，也是 `isSafeRelativePath` 的组成项之一。
 * 判定放在这里做单一实现：host 的安全链与测试复用的谓词共用同一套规则，
 * 避免两处逻辑各自演进后漂移。
 */
export function isNonRelativePath(input: string): boolean {
  return input.startsWith('/') || input.includes('\\') || /^[a-zA-Z]:/.test(input)
}

/**
 * 是否含 `..` 段。
 *
 * file 端点安全链**第 2 级**的拒因：规范化之前即拒，不做回卷（fail-closed）。
 * 与第 1 级分开是为了让「拒绝发生在哪一级」可被精确定位与断言。
 */
export function hasDotDotSegment(input: string): boolean {
  return input.split('/').includes('..')
}

/**
 * 安全校验纯函数：是否是一条可直接信任的相对路径。
 *
 * 由 `isNonRelativePath` 与 `hasDotDotSegment` 合成，再排除空段与 `.` 段。
 * 调用方仍须完成 restrictPath 前缀与 realpath 复查（本函数只是纯函数层的第一道闸）。
 */
export function isSafeRelativePath(input: string): boolean {
  if (input.length === 0) return false
  if (isNonRelativePath(input)) return false
  if (hasDotDotSegment(input)) return false
  return input.split('/').every(seg => seg !== '' && seg !== '.')
}

/**
 * 把基座持久化 meta.path 的展示路径相对化（对会话 header.cwd 求前缀）。
 *
 * 依据真实日志样本（deepseek-harness 仓库 snapshots/web 各场景 session.jsonl 首行）：
 * read 工具的 `tool/result.meta.path` 是「后端解析后的绝对展示路径」
 * （如 `<cwd>/notes.txt`）。聚合器必须先相对化再做树 key。
 *
 * @returns 相对路径（未规范化，交给 normalizeWorkspacePath 收尾）；
 *          非绝对路径原样返回；绝对但不在 cwd 之下时返回 `null`（宁缺勿错，整条丢弃）。
 */
export function relativizeAgainstRoot(displayPath: string, root: string | undefined): string | null {
  if (displayPath.length === 0) return null
  const posix = displayPath.replaceAll('\\', '/')
  if (!posix.startsWith('/') && !/^[a-zA-Z]:/.test(posix)) return displayPath
  if (root === undefined || root.length === 0) return null
  const posixRoot = root.replaceAll('\\', '/').replace(/\/+$/, '')
  if (posix === posixRoot) return null
  if (posix.startsWith(`${posixRoot}/`)) return posix.slice(posixRoot.length + 1)
  return null
}
