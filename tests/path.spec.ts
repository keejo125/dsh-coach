/**
 * path.ts 纯函数 + file-access 五级安全校验链（../、绝对路径、symlink 逃逸、
 * 目录、截断）的单元测试（设计文档任务 #2 / #4）。
 */

import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { isSafeRelativePath, normalizeWorkspacePath, relativizeAgainstRoot } from '../src/shared/path.ts'
import { FileAccessError, readWorkspaceFile } from '../src/host/file-access.ts'
import { ensureDir, ensureFile, ensureSymlink, fixtureDir } from './tmp-root.ts'

describe('normalizeWorkspacePath', () => {
  it('折叠多斜杠、去前导 ./、剔除空段', () => {
    expect(normalizeWorkspacePath('a//b///c')).toBe('a/b/c')
    expect(normalizeWorkspacePath('./a/b')).toBe('a/b')
    expect(normalizeWorkspacePath('a/./b')).toBe('a/b')
  })

  it('解析后仍在工作区内的 .. 保留规范化结果', () => {
    expect(normalizeWorkspacePath('a/b/../c')).toBe('a/c')
  })

  it('逃逸出工作区的整条丢弃（返回 null）', () => {
    expect(normalizeWorkspacePath('../x')).toBeNull()
    expect(normalizeWorkspacePath('a/../../x')).toBeNull()
    expect(normalizeWorkspacePath('..')).toBeNull()
  })

  it('绝对路径与空串返回 null', () => {
    expect(normalizeWorkspacePath('/abs/path')).toBeNull()
    expect(normalizeWorkspacePath('C:/win')).toBeNull()
    expect(normalizeWorkspacePath('')).toBeNull()
    expect(normalizeWorkspacePath('.')).toBeNull()
  })
})

describe('isSafeRelativePath', () => {
  it('接受常规相对路径', () => {
    expect(isSafeRelativePath('src/index.ts')).toBe(true)
    expect(isSafeRelativePath('a.b-c/d.e')).toBe(true)
  })

  it('拒绝绝对路径、反斜杠、盘符、..、空段', () => {
    expect(isSafeRelativePath('/abs')).toBe(false)
    expect(isSafeRelativePath('a\\b')).toBe(false)
    expect(isSafeRelativePath('C:/x')).toBe(false)
    expect(isSafeRelativePath('a/../b')).toBe(false)
    expect(isSafeRelativePath('../a')).toBe(false)
    expect(isSafeRelativePath('')).toBe(false)
    expect(isSafeRelativePath('a//b')).toBe(false)
  })
})

describe('relativizeAgainstRoot', () => {
  it('把 cwd 下的绝对展示路径相对化', () => {
    expect(relativizeAgainstRoot('/ws/src/a.ts', '/ws')).toBe('src/a.ts')
  })

  it('相对路径原样返回', () => {
    expect(relativizeAgainstRoot('src/a.ts', '/ws')).toBe('src/a.ts')
  })

  it('绝对路径不在 cwd 之下返回 null（宁缺勿错）', () => {
    expect(relativizeAgainstRoot('/elsewhere/a.ts', '/ws')).toBeNull()
  })

  it('cwd 缺失时绝对路径返回 null', () => {
    expect(relativizeAgainstRoot('/ws/a.ts', undefined)).toBeNull()
  })
})

describe('readWorkspaceFile 五级安全校验链', () => {
  // 夹具固定复用、幂等建、收尾不删除（见 tests/tmp-root.ts 顶部说明）
  const base = realpathSync(fixtureDir('path-spec'))
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')

  beforeAll(() => {
    ensureDir(root)
    ensureDir(outside)
    ensureFile(join(root, 'a.txt'), 'hello')
    ensureDir(join(root, 'dir'))
    ensureFile(join(root, 'dir', 'b.txt'), 'x'.repeat(600 * 1024)) // > 512KB
    ensureFile(join(outside, 'secret.txt'), 'top-secret')
    ensureSymlink(join(outside, 'secret.txt'), join(root, 'link-out'))
  })

  it('正常读取工作区内文件', async () => {
    const result = await readWorkspaceFile(root, 'a.txt')
    expect(result.path).toBe('a.txt')
    expect(result.content).toBe('hello')
    expect(result.truncated).toBe(false)
    expect(result.encoding).toBe('utf-8')
    expect(result.realPath).toBe(join(root, 'a.txt'))
  })

  it('第 1 级：拒绝绝对路径与盘符', async () => {
    await expect(readWorkspaceFile(root, '/etc/passwd')).rejects.toMatchObject({ code: 'CTX_FILE_FORBIDDEN' })
    await expect(readWorkspaceFile(root, 'C:/win')).rejects.toMatchObject({ code: 'CTX_FILE_FORBIDDEN' })
  })

  it('第 2 级：拒绝含 .. 段的路径', async () => {
    await expect(readWorkspaceFile(root, '../outside/secret.txt')).rejects.toMatchObject({ code: 'CTX_FILE_FORBIDDEN' })
    await expect(readWorkspaceFile(root, 'a/../b')).rejects.toMatchObject({ code: 'CTX_FILE_FORBIDDEN' })
  })

  it('第 3 级：畸形路径不会逃逸（.... 是合法名，落空返回 NOT_FOUND）', async () => {
    await expect(readWorkspaceFile(root, '....//outside/secret.txt')).rejects.toMatchObject({ code: 'CTX_FILE_NOT_FOUND' })
  })

  it('第 4 级：realpath 反 symlink 逃逸', async () => {
    await expect(readWorkspaceFile(root, 'link-out')).rejects.toMatchObject({ code: 'CTX_FILE_FORBIDDEN' })
  })

  it('第 4 级：不存在的文件返回 CTX_FILE_NOT_FOUND', async () => {
    await expect(readWorkspaceFile(root, 'missing.txt')).rejects.toMatchObject({ code: 'CTX_FILE_NOT_FOUND' })
  })

  it('第 5 级：拒绝目录', async () => {
    await expect(readWorkspaceFile(root, 'dir')).rejects.toMatchObject({ code: 'CTX_FILE_FORBIDDEN' })
  })

  it('超过 512KB 截断', async () => {
    const result = await readWorkspaceFile(root, 'dir/b.txt')
    expect(result.truncated).toBe(true)
    expect(result.content).toHaveLength(512 * 1024)
    expect(result.size).toBe(600 * 1024)
  })

  it('root 缺失（空串/相对路径）整体拒绝', async () => {
    await expect(readWorkspaceFile('', 'a.txt')).rejects.toBeInstanceOf(FileAccessError)
    await expect(readWorkspaceFile('relative/root', 'a.txt')).rejects.toMatchObject({ code: 'CTX_FILE_FORBIDDEN' })
  })
})
