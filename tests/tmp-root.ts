/**
 * 测试夹具目录：固定落在项目内 `.tmp/<name>`（.gitignore 已覆盖），**收尾不删除**。
 *
 * 不用 `os.tmpdir()` + `rmSync` 收尾的两个原因：
 * 1. macOS 上 `os.tmpdir()` 落在 `/var/folders/...`，递归删除会被环境的批量删除
 *    保护拦下，整组用例直接失败；
 * 2. 该保护按「整轮累计删除数」计（阈值 50），反复跑测试必然触顶——与被测代码
 *    无关的误报，在 CI 上同样会间歇性发作。
 *
 * 因此夹具目录固定复用、setup 幂等、收尾不删除。用例只断言自己写入的文件，
 * 历史遗留文件不影响结论（文件名在各自的 spec 内固定）。
 */

import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env['DSH_CONTEXT_TMP'] ?? join(process.cwd(), '.tmp')

/** 取（并按需创建）一个夹具目录；重复调用返回同一路径。 */
export function fixtureDir(name: string): string {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 幂等建目录。 */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/** 幂等写文件：内容一致就跳过（避免每轮重写大文件）。 */
export function ensureFile(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf-8') === content) return
  } catch {
    // 不存在或不可读 → 落到下面写入
  }
  writeFileSync(path, content)
}

/** 幂等建符号链接：已存在且指向目标一致就跳过。 */
export function ensureSymlink(target: string, path: string): void {
  try {
    if (readlinkSync(path) === target) return
    // 指向了别处（夹具变更过的遗留）：摘掉重建
    rmSync(path, { force: true })
  } catch {
    // 不存在 → 落到下面新建
  }
  symlinkSync(target, path)
}
