/**
 * B. file 端点五级安全链攻防（QA 独立验证）。
 *
 * 与既有 api.host.spec.ts 的差别：
 * - 逐条断言「拒绝发生在哪一级」（错误 message 精确匹配），而不是只看 403；
 * - 覆盖 macOS /var → /private/var 这类 realpath 陷阱（工作区根自身在 symlink 下）；
 * - 覆盖 symlink 目录、工作区内 symlink（合法，应放行）、大文件截断、边界编码。
 *
 * 固定夹具目录放在 node_modules/.dsh-coach-verify 下（已被 .gitignore 覆盖）
 * 且 setup 幂等、不做清理：既有 spec 用 os.tmpdir() 在 macOS 落在 /var/folders，
 * 递归清理会被环境的批量删除保护拦下，导致用例集直接失败。
 */

import { mkdirSync, writeFileSync, symlinkSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { readWorkspaceFile, FileAccessError } from '../src/host/file-access.ts'
import { FILE_BODY_MAX_BYTES } from '../src/shared/constants.ts'

const base = join(process.cwd(), 'node_modules', '.dsh-coach-verify', 'security')
/** 会话工作区根（真实目录）。 */
const ws = join(base, 'ws')
/** 工作区外目录。 */
const outside = join(base, 'outside')
/** 指向 ws 的 symlink（复刻 macOS /var → /private/var 形态）。 */
const linkRoot = join(base, 'linkws')

/**
 * 幂等建链：目标一致就跳过。
 * 不删除旧链——夹具目录固定复用，删除会在受限环境里被拦截。
 */
function ensureSymlink(target: string, path: string): void {
  try {
    if (readlinkSync(path) === target) return
  } catch {
    // 不存在或不可读，落到下面重建
  }
  symlinkSync(target, path)
}

beforeAll(() => {
  mkdirSync(join(ws, 'sub'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(ws, 'a.txt'), 'hello-from-workspace')
  writeFileSync(join(ws, 'sub', 'b.txt'), 'nested')
  writeFileSync(join(outside, 'secret.txt'), 'top-secret')
  // 工作区内的合法 symlink（指向工作区内另一个文件）→ 应放行
  ensureSymlink(join(ws, 'a.txt'), join(ws, 'link-in'))
  // 工作区内的 symlink 指向工作区外 → 应拒绝
  ensureSymlink(join(outside, 'secret.txt'), join(ws, 'link-out'))
  // 工作区内的 symlink 目录指向工作区外 → 应拒绝（且不能借目录名绕过）
  ensureSymlink(outside, join(ws, 'link-dir'))
  // 多级 symlink 链：link-chain → link-out → 工作区外
  ensureSymlink(join(ws, 'link-out'), join(ws, 'link-chain'))
  // 悬空 symlink
  ensureSymlink(join(ws, 'ghost.txt'), join(ws, 'link-dangling'))
  // 大文件：600KB
  writeFileSync(join(ws, 'big.txt'), 'x'.repeat(600 * 1024))
  writeFileSync(join(ws, 'edge.txt'), 'y'.repeat(FILE_BODY_MAX_BYTES))
  ensureSymlink(ws, linkRoot)
})

/** 期望被拒绝：返回 FileAccessError 的 code 与 message。 */
async function expectReject(root: string, rawPath: string): Promise<{ code: string; message: string }> {
  try {
    await readWorkspaceFile(root, rawPath)
  } catch (error) {
    expect(error).toBeInstanceOf(FileAccessError)
    const failure = error as FileAccessError
    return { code: failure.code, message: failure.message }
  }
  throw new Error(`expected rejection but the read succeeded: path=${rawPath}`)
}

describe('B1 · 第 1 级：仅接受相对路径', () => {
  it('绝对路径 → CTX_FILE_FORBIDDEN', async () => {
    expect(await expectReject(ws, '/etc/passwd')).toEqual({
      code: 'CTX_FILE_FORBIDDEN',
      message: 'file path must be workspace-relative',
    })
  })

  it('盘符路径（Windows 形态）→ FORBIDDEN', async () => {
    expect((await expectReject(ws, 'C:/Windows/win.ini')).code).toBe('CTX_FILE_FORBIDDEN')
  })

  it('反斜杠分隔符 → FORBIDDEN（不做分隔符兼容，fail-closed）', async () => {
    expect((await expectReject(ws, 'sub\\b.txt')).code).toBe('CTX_FILE_FORBIDDEN')
  })
})

describe('B2 · 第 2 级：拒 `..`（规范化前即拒，不回卷）', () => {
  it('顶层逃逸 → FORBIDDEN', async () => {
    expect(await expectReject(ws, '../outside/secret.txt')).toEqual({
      code: 'CTX_FILE_FORBIDDEN',
      message: 'file path must not contain ".."',
    })
  })

  it('先进入子目录再回卷（解析后其实合法）也拒绝：fail-closed 口径', async () => {
    expect((await expectReject(ws, 'sub/../a.txt')).code).toBe('CTX_FILE_FORBIDDEN')
  })

  it('目录名只含 ".." 子串（a..b）不误杀', async () => {
    mkdirSync(join(ws, 'a..b'), { recursive: true })
    writeFileSync(join(ws, 'a..b', 'c.txt'), 'dotted-name')
    const result = await readWorkspaceFile(ws, 'a..b/c.txt')
    expect(result.content).toBe('dotted-name')
    expect(result.path).toBe('a..b/c.txt')
  })
})

describe('B3 · 第 3/4 级：restrictPath + realpath 反 symlink 逃逸', () => {
  it('工作区内 symlink 指向工作区外 → FORBIDDEN', async () => {
    expect(await expectReject(ws, 'link-out')).toEqual({
      code: 'CTX_FILE_FORBIDDEN',
      message: 'file path escapes the session workspace',
    })
  })

  it('多级 symlink 链指向工作区外 → FORBIDDEN', async () => {
    expect((await expectReject(ws, 'link-chain')).code).toBe('CTX_FILE_FORBIDDEN')
  })

  it('symlink 目录逃逸（借目录名访问外部文件）→ FORBIDDEN', async () => {
    expect((await expectReject(ws, 'link-dir/secret.txt')).code).toBe('CTX_FILE_FORBIDDEN')
  })

  it('工作区内 symlink 指向工作区内文件 → 放行（realpath 仍在根内）', async () => {
    const result = await readWorkspaceFile(ws, 'link-in')
    expect(result.content).toBe('hello-from-workspace')
    expect(result.path).toBe('link-in')
    expect(result.realPath).toBe(await realpath(join(ws, 'a.txt')))
  })

  it('macOS /var → /private/var 陷阱：工作区根自身位于 symlink 下时合法读取不被误杀', async () => {
    // 复刻 /var 是 /private/var 的 symlink 这一真实形态：root 用 symlink 路径给出
    const realRoot = await realpath(linkRoot)
    // 前提校验：两者确实不同（否则本用例失去意义）
    expect(realRoot).not.toBe(linkRoot)
    expect(realRoot).toBe(await realpath(ws))

    const result = await readWorkspaceFile(linkRoot, 'a.txt')
    expect(result.content).toBe('hello-from-workspace')
    // 同一 root 下的逃逸仍然被拦
    expect((await expectReject(linkRoot, 'link-out')).code).toBe('CTX_FILE_FORBIDDEN')
  })
})

describe('B4 · 第 5 级：仅常规文件 + 不存在处理', () => {
  it('传目录 → FORBIDDEN', async () => {
    expect(await expectReject(ws, 'sub')).toEqual({
      code: 'CTX_FILE_FORBIDDEN',
      message: 'path is not a regular file',
    })
  })

  it('传工作区根自身（"."）→ FORBIDDEN', async () => {
    expect((await expectReject(ws, '.')).code).toBe('CTX_FILE_FORBIDDEN')
  })

  it('不存在的文件 → CTX_FILE_NOT_FOUND', async () => {
    expect(await expectReject(ws, 'nope.txt')).toEqual({
      code: 'CTX_FILE_NOT_FOUND',
      message: 'file not found',
    })
  })

  it('symlink 悬空（指向不存在目标）→ NOT_FOUND', async () => {
    expect((await expectReject(ws, 'link-dangling')).code).toBe('CTX_FILE_NOT_FOUND')
  })
})

describe('B5 · 合法读取与截断', () => {
  it('合法文件：返回规范化 path / realPath / size / 未截断正文', async () => {
    const result = await readWorkspaceFile(ws, 'sub/b.txt')
    expect(result).toMatchObject({
      path: 'sub/b.txt',
      realPath: resolve(ws, 'sub/b.txt'),
      size: 6,
      content: 'nested',
      truncated: false,
      encoding: 'utf-8',
    })
  })

  it('`./` 前缀与重复分隔符被规范化', async () => {
    const result = await readWorkspaceFile(ws, './sub//b.txt')
    expect(result.path).toBe('sub/b.txt')
    expect(result.content).toBe('nested')
  })

  it('>512KB 文件被截断：content 长度 = 512KB，size 为真实大小，truncated=true', async () => {
    const result = await readWorkspaceFile(ws, 'big.txt')
    expect(result.truncated).toBe(true)
    expect(result.size).toBe(600 * 1024)
    expect(Buffer.byteLength(result.content, 'utf-8')).toBe(FILE_BODY_MAX_BYTES)
  })

  it('恰好 512KB 不截断（边界等号）', async () => {
    const result = await readWorkspaceFile(ws, 'edge.txt')
    expect(result.truncated).toBe(false)
    expect(result.content).toHaveLength(FILE_BODY_MAX_BYTES)
  })
})

describe('B6 · 根与入参的 fail-closed', () => {
  it('root 非绝对路径 → FORBIDDEN', async () => {
    expect((await expectReject('relative/root', 'a.txt')).code).toBe('CTX_FILE_FORBIDDEN')
  })

  it('root 不存在 → FORBIDDEN', async () => {
    expect((await expectReject(join(base, 'no-such-root'), 'a.txt')).code).toBe('CTX_FILE_FORBIDDEN')
  })

  it('空 path / 纯空白 path → CTX_BAD_REQUEST', async () => {
    expect((await expectReject(ws, '')).code).toBe('CTX_BAD_REQUEST')
    expect((await expectReject(ws, '   ')).code).toBe('CTX_BAD_REQUEST')
  })
})
