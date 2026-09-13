/**
 * 文件正文读取（复盘抽屉用）：工作区相对路径 → 正文。
 *
 * 安全链与 Context 插件的 file-access 同构（相对路径 / 拒 `..` / resolve 前缀 / realpath
 * 反 symlink 逃逸 / 大小截断），错误码映射为 COACH_*。会话工作区根缺失时 fail-closed。
 */

import { realpath, readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { CoachApiErrorCode } from '../../shared/types.ts'

/** 文件正文最大字节数（超出截断并在响应中标注）。 */
export const FILE_BODY_MAX_BYTES = 512 * 1024

/** file 端点安全链异常：code 映射 CoachApiErrorCode。 */
export class CoachFileAccessError extends Error {
  constructor(readonly code: CoachApiErrorCode, message: string) {
    super(message)
    this.name = 'CoachFileAccessError'
  }
}

/** 纯相对路径判定：拒绝绝对路径、盘符、反斜杠。 */
function isNonRelativePath(rawPath: string): boolean {
  return rawPath.startsWith('/') || rawPath.startsWith('\\')
    || /^[a-zA-Z]:/.test(rawPath)
    || rawPath.includes('\\')
}

/** 安全链第 1-3 级：相对路径、拒 `..`、resolve 前缀限定。 */
function resolveInsideRoot(root: string, rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file path is required')
  }
  if (isNonRelativePath(rawPath)) {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file path must be workspace-relative')
  }
  if (rawPath.split('/').includes('..')) {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file path must not contain ".."')
  }
  const normalized = rawPath.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
  if (normalized.length === 0) {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file path is not valid')
  }
  const resolved = resolvePath(root, normalized)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file path escapes the workspace')
  }
  return resolved
}

/** 解析工作区文件：realpath 反逃逸后返回真实路径与大小。 */
export async function resolveWorkspaceFile(root: string, rawPath: string): Promise<{ realPath: string; size: number }> {
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'session workspace root is unavailable')
  }
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'session workspace root is unavailable')
  }
  const resolved = resolveInsideRoot(realRoot, rawPath)
  let realPath: string
  try {
    realPath = await realpath(resolved)
  } catch {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file not found')
  }
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}/`)) {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file path escapes the workspace')
  }
  const info = await stat(realPath).catch(() => {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file not found')
  })
  if (!info.isFile()) {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'path is not a file')
  }
  return { realPath, size: info.size }
}

/** 读工作区文件正文（截断至 FILE_BODY_MAX_BYTES）。 */
export async function readCoachWorkspaceFile(root: string, rawPath: string): Promise<{
  path: string
  text: string
  truncated: boolean
  size: number
}> {
  const { realPath, size } = await resolveWorkspaceFile(root, rawPath)
  const buffer = await readFile(realPath).catch(() => {
    throw new CoachFileAccessError('COACH_BAD_REQUEST', 'file is not readable')
  })
  const truncated = buffer.byteLength > FILE_BODY_MAX_BYTES
  const text = truncated ? buffer.subarray(0, FILE_BODY_MAX_BYTES).toString('utf-8') : buffer.toString('utf-8')
  return { path: rawPath, text, truncated, size }
}
