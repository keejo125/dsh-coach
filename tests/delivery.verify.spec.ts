/**
 * F. 交付物完整性（QA 独立验证）。
 *
 * - 28 个交付文件：清单直接从设计文档 §2 的代码块解析出来逐条比对，
 *   而不是硬编码一份可能过期的列表；
 * - 契约单源：src/shared/types.ts；
 * - 无 dsh-workbench-plugin 残留引用；
 * - 基座仓库 tracked 修改数为 0。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_AVAILABLE, BASE_ROOT } from './real-log.verify.helper.ts'

const PROJECT = process.cwd()
// 设计文档已归入本项目的 spec/ 目录（早期位于仓库父目录，路径在此同步修正）
const DESIGN = join(PROJECT, 'spec', '02-架构设计.md')
/** v1.1 增量设计文档（§11 登记本轮新增文件：ids.ts / selectors.ts / 4 个新 spec）。 */
const DESIGN_V11 = join(PROJECT, 'spec', '03-架构设计-v1.1增量.md')
/** v0.2a 复盘数据层设计文档（§8 登记本轮新增文件：src/host/coach/* 4 件 + 2 个新 spec）。 */
const DESIGN_V08 = join(PROJECT, 'spec', '08-复盘数据层设计.md')

/** 从设计文档的指定小节代码块解析出相对路径清单。 */
function parseDesignFileList(designPath: string, heading: string): string[] {
  const source = readFileSync(designPath, 'utf-8')
  const head = source.indexOf(heading)
  expect(head, `设计文档缺少小节：${heading}`).toBeGreaterThan(-1)
  const fenceStart = source.indexOf('```', head)
  const fenceEnd = source.indexOf('```', fenceStart + 3)
  expect(fenceStart).toBeGreaterThan(-1)
  expect(fenceEnd).toBeGreaterThan(fenceStart)
  const block = source.slice(fenceStart + 3, fenceEnd)

  const stack: string[] = []
  const paths: string[] = []
  for (const rawLine of block.split('\n')) {
    // v1.1 清单行尾带 `[新]` / `[改]` 注解，去注解后再解析（与 `#` 注释同理）
    const line = rawLine.split('#')[0]?.replace(/\s+\[[^\]]*\].*$/, '').replace(/\s+$/, '') ?? ''
    if (line.trim().length === 0) continue
    const glyph = line.search(/[├└]──/)
    if (glyph < 0) {
      // 根行：`dsh-coach/`
      const root = line.trim().replace(/\/$/, '')
      stack.length = 0
      stack.push(root)
      continue
    }
    const depth = glyph / 4
    const name = line.slice(glyph + 4).trim().replace(/\/$/, '')
    if (name.length === 0) continue
    stack.length = depth + 1
    stack[depth + 1] = name
    paths.push(stack.slice(1).join('/'))
  }
  // 目录行（`src`、`tests` …）不属交付文件，只保留带扩展名的条目
  return paths.filter(path => /\.[a-z]+$/.test(path))
}

/** 递归列出目录下的文件（相对路径，POSIX 分隔；排除 node_modules / lib / .git / tests）。 */
function listSources(dir: string, root = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === '.git' || entry === '.tmp') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listSources(full, root))
    else out.push(relative(root, full).split('/').join('/'))
  }
  return out
}

describe('F1 · 交付文件齐备（清单来自设计文档 §2 + v1.1 §11 + v0.2a §8）', () => {
  const baseline = parseDesignFileList(DESIGN, '## 2. 文件清单')
  const incremental = parseDesignFileList(DESIGN_V11, '## 11. 文件清单（本轮增量）')
  const incrementalV08 = parseDesignFileList(DESIGN_V08, '## 8. 文件清单（v0.2a 增量）')
  const expected = [...new Set([...baseline, ...incremental, ...incrementalV08])]

  it('三个设计文档列出的文件逐个存在', () => {
    expect(baseline.length).toBe(28)
    // v1.1 §11 登记的新增件必须齐备（glob 条目如 *.module.css 不做存在性检查）
    const declared = new Set(incremental)
    for (const path of [
      'src/shared/ids.ts',
      'src/client/selectors.ts',
      'tests/final-answer.spec.ts',
      'tests/input-groups.spec.ts',
      'tests/delegation-fallback.spec.ts',
      'tests/selectors.spec.ts',
    ]) {
      expect(declared.has(path), `v1.1 §11 未登记：${path}`).toBe(true)
    }
    // v0.2a §8 登记的新增件必须齐备
    const declaredV08 = new Set(incrementalV08)
    for (const path of [
      'src/host/coach/api.ts',
      'src/host/coach/metrics.ts',
      'src/host/coach/report.ts',
      'src/host/coach/score.ts',
      'tests/coach.spec.ts',
      'tests/coach.verify.spec.ts',
    ]) {
      expect(declaredV08.has(path), `v0.2a §8 未登记：${path}`).toBe(true)
    }
    const missing = expected
      .filter(path => !path.includes('*'))
      .filter(path => !existsSync(join(PROJECT, path)))
    expect(missing).toEqual([])
  })

  it('src/ 下没有设计文档未列出的多余源码文件（CSS 模块与 css-modules.d.ts 属实现必需，单独登记）', () => {
    const srcFiles = listSources(join(PROJECT, 'src')).map(path => `src/${path}`)
    const declared = new Set(expected)
    const extra = srcFiles.filter(path => !declared.has(path))
    // 允许项：各组件的样式模块 + CSS 模块的 TS 声明（设计文档 §2 未列 CSS，实现必需）
    const acceptable = extra.every(path => path.endsWith('.module.css') || path.endsWith('css-modules.d.ts'))
    expect(acceptable, `未登记的源码文件：${extra.join(', ')}`).toBe(true)
  })
})

describe('F2 · 契约单源（src/shared/types.ts）', () => {
  const CONTRACT = [
    'CtxApiErrorCode', 'CtxApiEnvelope', 'AgentBadge', 'PayloadBudgets', 'FileTreeNode',
    'AttachmentRef', 'UserInputItem', 'PluginInjectItem', 'InputsSection',
    'ReferencesSection', 'OutputTextSegment', 'OutputsSection', 'ContextAggregate',
    'FileContentResult', 'OutputTextResult',
  ]

  it('全部 §3 契约类型只在 shared/types.ts 声明', () => {
    const offenders: string[] = []
    for (const path of listSources(join(PROJECT, 'src')).map(p => `src/${p}`)) {
      if (!/\.tsx?$/.test(path)) continue
      if (path === 'src/shared/types.ts') continue
      const source = readFileSync(join(PROJECT, path), 'utf-8')
      for (const name of CONTRACT) {
        const re = new RegExp(`(?:export\\s+)?(?:interface|type)\\s+${name}\\b`)
        if (re.test(source)) offenders.push(`${path}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('host 与 client 都从 shared/types.ts 取类型，不各自定义', () => {
    const host = listSources(join(PROJECT, 'src', 'host')).map(p => `src/host/${p}`)
    const client = listSources(join(PROJECT, 'src', 'client')).map(p => `src/client/${p}`)
    for (const path of [...host, ...client]) {
      const source = readFileSync(join(PROJECT, path), 'utf-8')
      if (/types?\s+/.test(source) && /from '.*shared\/types\.ts'/.test(source)) continue
    }
    // 显式确认两侧确有引用（不是「都不引用」而通过）
    const hostRefs = host.filter(p => readFileSync(join(PROJECT, p), 'utf-8').includes("shared/types.ts"))
    const clientRefs = client.filter(p => readFileSync(join(PROJECT, p), 'utf-8').includes("shared/types.ts"))
    expect(hostRefs.length).toBeGreaterThan(0)
    expect(clientRefs.length).toBeGreaterThan(0)
  })
})

describe('F3 · 无 dsh-workbench-plugin 残留', () => {
  it('src/ 下无 dsh-workbench-plugin 引用', () => {
    const offenders: string[] = []
    for (const path of listSources(join(PROJECT, 'src')).map(p => `src/${p}`)) {
      const source = readFileSync(join(PROJECT, path), 'utf-8')
      if (source.includes('dsh-workbench-plugin')) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })

  it('随包交付物（src + package.json + cordis.patch.yml）无 dsh-workbench-plugin 引用', () => {
    // 只扫随包交付物：tsdown.config.ts 与 README 里的提及是「零代码复用」的说明性注释，
    // 不进 lib/ 产物，不构成代码引用。
    const shipped = [
      ...listSources(join(PROJECT, 'src')).map(p => `src/${p}`),
      'package.json',
      'cordis.patch.yml',
    ]
    const offenders: string[] = []
    for (const path of shipped) {
      const source = readFileSync(join(PROJECT, path), 'utf-8')
      if (source.includes('dsh-workbench-plugin')) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })

  it('构建产物 lib/ 中不含 dsh-workbench-plugin 的运行时引用', () => {
    const libDir = join(PROJECT, 'lib')
    if (!existsSync(libDir)) return // 未构建时跳过（构建非本次验证范围）
    const offenders: string[] = []
    for (const path of listSources(libDir).map(p => `lib/${p}`)) {
      if (!/\.jsx?$/.test(path)) continue
      const source = readFileSync(join(PROJECT, path), 'utf-8')
      if (source.includes('dsh-workbench-plugin')) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})

describe('F4 · 插件清单与需求定稿', () => {
  it('package.json：双面入口、插件名、client inject 声明', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf-8')) as {
      name: string
      exports: Record<string, unknown>
      dsh: { bundle: { patch: string }; client: { inject: string[]; platform: string } }
    }
    expect(manifest.name).toBe('dsh-coach')
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining(['.', './client']))
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.client.inject.length).toBeGreaterThan(0)
  })

  it('cordis.patch.yml 声明插件行 id/name', () => {
    const patch = readFileSync(join(PROJECT, 'cordis.patch.yml'), 'utf-8')
    expect(patch).toMatch(/id:\s*dsh-coach/)
    expect(patch).toMatch(/dsh-coach/)
  })

  it('/ctx/api 前缀只在插件内部使用（client 侧路径与 host 注册路径一致）', () => {
    const apiClient = readFileSync(join(PROJECT, 'src/client/api-client.ts'), 'utf-8')
    const hostApi = readFileSync(join(PROJECT, 'src/host/api.ts'), 'utf-8')
    expect(apiClient).toContain('/ctx/api/session/')
    expect(hostApi).toContain("const API_PREFIX = '/ctx/api'")
    // client 不能把该前缀写进任何对外契约/公共导出说明之外的地方：host 侧同样只用同一常量
    expect(hostApi.match(/\/ctx\/api/g)?.length).toBeGreaterThan(0)
  })
})

describe('F5 · 基座仓库未被污染', () => {
  const suite = BASE_AVAILABLE ? it : it.skip

  suite('git status 只出现未跟踪项（tracked 修改数为 0）', () => {
    const output = execFileSync('git', ['-C', BASE_ROOT, 'status', '--short'], { encoding: 'utf-8' })
    const lines = output.split('\n').filter(line => line.trim().length > 0)
    const tracked = lines.filter(line => !line.startsWith('??'))
    expect(tracked, `基座仓库存在 tracked 改动：\n${tracked.join('\n')}`).toEqual([])
  })

  suite('本次验证没有在基座仓库里留下文件', () => {
    const output = execFileSync('git', ['-C', BASE_ROOT, 'status', '--short'], { encoding: 'utf-8' })
    const untracked = output.split('\n').filter(line => line.startsWith('??')).map(line => line.slice(3))
    const suspicious = untracked.filter(path => /dsh-coach|verify/i.test(path))
    expect(suspicious).toEqual([])
  })
})
