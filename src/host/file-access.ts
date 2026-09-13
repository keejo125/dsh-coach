/**
 * 文件正文读取：五级安全校验链 + 512KB 截断（§3.6 file 端点）。
 *
 * 链条逐级执行、任一不过即 CTX_FILE_FORBIDDEN（ENOENT 例外为 CTX_FILE_NOT_FOUND）：
 * 1. 仅接受相对路径（拒绝绝对路径与盘符）；
 * 2. 拒绝含 `..` 段的路径（fail-closed：原始输入含 `..` 即拒，不做规范化回卷）；
 * 3. 以会话工作区根 restrictPath 限定（path.resolve 后必须仍以 root+sep 为前缀）；
 * 4. fs.realpath 解析真实路径后再次前缀校验（反 symlink 逃逸）；
 * 5. stat 必须是常规文件（拒绝目录/设备）。
 */

import { execFile } from 'node:child_process'
import { realpath, stat, readFile } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'
import { FILE_BODY_MAX_BYTES } from '../shared/constants.ts'
import { hasDotDotSegment, isNonRelativePath, normalizeWorkspacePath } from '../shared/path.ts'
import type { FileContentResult } from '../shared/types.ts'
import type { CtxApiErrorCode } from '../shared/types.ts'

/** file 端点安全链异常：code 直接映射统一包络错误码。 */
export class FileAccessError extends Error {
  constructor(readonly code: CtxApiErrorCode, message: string) {
    super(message)
    this.name = 'FileAccessError'
  }
}

/** 安全链第 1-3 级：相对路径、拒 `..`、restrictPath 前缀限定。 */
function resolveInsideRoot(root: string, rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new FileAccessError('CTX_BAD_REQUEST', 'file path is required')
  }
  // 第 1 级：仅相对路径（拒绝绝对路径、盘符、反斜杠分隔符）
  // 判定复用 shared/path.ts 的纯函数，与安全链外的使用者共用一套规则
  if (isNonRelativePath(rawPath)) {
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file path must be workspace-relative')
  }
  // 第 2 级：拒绝含 `..` 段的路径（规范化后复查口径从紧：原始段里出现 `..` 即拒）
  if (hasDotDotSegment(rawPath)) {
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file path must not contain ".."')
  }
  const normalized = normalizeWorkspacePath(rawPath)
  if (normalized === null) {
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file path is not a valid workspace-relative path')
  }
  // 第 3 级：restrictPath——resolve 后必须仍落在 root 之内
  const resolved = resolvePath(root, normalized)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file path escapes the session workspace')
  }
  return resolved
}

/** 安全链（第 1-5 级）求到的文件引用：真实路径 + 字节数。 */
export interface WorkspaceFileRef {
  realPath: string
  size: number
}

/**
 * 安全链第 1-5 级（不含读取内容）：求工作区内一个**常规文件**的真实路径。
 *
 * file 端点与 reveal 端点**共用同一条链**——两者对「路径是否安全」的判定必须完全一致，
 * 否则会出现「正文读不到但能在 Finder 里定位」这类口径不一致的旁路。
 *
 * @param root 会话工作区根（会话 header.cwd；缺失时调用方应直接拒绝）。
 * @param rawPath 工作区相对路径（URL 解码后的原始值）。
 */
export async function resolveWorkspaceFile(root: string, rawPath: string): Promise<WorkspaceFileRef> {
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) {
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'session workspace root is unavailable')
  }
  // 工作区根自身也要 realpath 规范化：macOS 上 /var → /private/var，
  // 会话 cwd 常落在符号链接路径下。若只规范化文件侧而根侧保持原样，
  // 第 3/4 级的前缀比较必然失配，工作区内所有读取都会被误判为逃逸。
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'session workspace root is unavailable')
  }
  const resolved = resolveInsideRoot(realRoot, rawPath)
  // 第 4 级：realpath 反 symlink 逃逸（两侧同为真实路径，前缀比较才有意义）
  let real: string
  try {
    real = await realpath(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') throw new FileAccessError('CTX_FILE_NOT_FOUND', 'file not found')
    if (code === 'EACCES' || code === 'EPERM') throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file path is not readable')
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file path resolution failed')
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file path escapes the session workspace')
  }
  // 第 5 级：仅常规文件
  const info = await stat(real).catch((error: NodeJS.ErrnoException | null) => {
    if (error?.code === 'ENOENT') throw new FileAccessError('CTX_FILE_NOT_FOUND', 'file not found')
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file path is not a readable file')
  })
  if (!info.isFile()) {
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'path is not a regular file')
  }
  return { realPath: real, size: info.size }
}

/**
 * 读取工作区内一个文件的正文（五级安全链 + 512KB 截断）。
 * @param root 会话工作区根（会话 header.cwd；缺失时调用方应直接拒绝）。
 * @param rawPath 工作区相对路径（URL 解码后的原始值）。
 */
export async function readWorkspaceFile(root: string, rawPath: string): Promise<FileContentResult> {
  const { realPath, size } = await resolveWorkspaceFile(root, rawPath)
  const buffer = await readFile(realPath).catch((error: NodeJS.ErrnoException | null) => {
    if (error?.code === 'ENOENT') throw new FileAccessError('CTX_FILE_NOT_FOUND', 'file not found')
    throw new FileAccessError('CTX_FILE_FORBIDDEN', 'file is not readable')
  })
  const truncated = buffer.byteLength > FILE_BODY_MAX_BYTES
  const content = truncated ? buffer.subarray(0, FILE_BODY_MAX_BYTES).toString('utf-8') : buffer.toString('utf-8')
  // realpath 可能给出大小写不同的既有路径；size 取 stat 值
  const normalizedPath = normalizeWorkspacePath(rawPath) as string
  return {
    path: normalizedPath,
    realPath,
    size,
    content,
    truncated,
    encoding: 'utf-8',
  }
}

/**
 * 在系统文件管理器中定位该文件（macOS：`open -R` → 打开所在文件夹并高亮该文件）。
 *
 * 浏览器无法直接唤起 Finder，故由 host 侧代劳；路径判定复用 `resolveWorkspaceFile`
 * 的完整五级安全链，**只对已确认落在工作区内的常规文件**执行。
 * 子进程失败一律收敛为 `CTX_INTERNAL`（message 已脱敏，不含绝对路径）。
 */
export async function revealWorkspaceFile(root: string, rawPath: string): Promise<void> {
  const { realPath } = await resolveWorkspaceFile(root, rawPath)
  if (process.platform !== 'darwin') {
    throw new FileAccessError('CTX_INTERNAL', 'reveal is only supported on macOS')
  }
  await new Promise<void>((resolve, reject) => {
    // `-R` = reveal（开 Finder 并选中该文件），不传 `--` 以免被当作选项
    execFile('open', ['-R', realPath], error => {
      if (error === null) resolve()
      else reject(new FileAccessError('CTX_INTERNAL', 'failed to open the containing folder'))
    })
  })
}
