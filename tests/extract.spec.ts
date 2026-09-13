/**
 * 注入路径提取规则与兜底策略用例（设计文档 §3.5 / 任务 #2）。
 */

import { describe, expect, it } from 'vitest'
import { extractInjectFilePaths } from '../src/shared/extract.ts'

describe('extractInjectFilePaths', () => {
  it('显式动词模式：读取/Read/加载/文件 后紧跟路径', () => {
    expect(extractInjectFilePaths('instructions', ['请先读取 src/index.ts 再改'])).toEqual(['src/index.ts'])
    expect(extractInjectFilePaths('instructions', ['Read packages/a/b.ts carefully'])).toEqual(['packages/a/b.ts'])
    expect(extractInjectFilePaths('instructions', ['文件：docs/spec.md 内容如下'])).toEqual(['docs/spec.md'])
  })

  it('markdown 链接中的路径', () => {
    expect(extractInjectFilePaths('instructions', ['见 [指南](docs/guide.md) 与 [首页](README.md)']))
      .toEqual(['docs/guide.md', 'README.md'])
  })

  it('行内代码中的路径', () => {
    expect(extractInjectFilePaths('instructions', ['修改 `src/shared/types.ts` 的接口'])).toEqual(['src/shared/types.ts'])
  })

  it('已知注入文档名（无斜杠文件名）', () => {
    expect(extractInjectFilePaths('instructions', ['请遵循 AGENTS.md 的约定'])).toEqual(['AGENTS.md'])
    expect(extractInjectFilePaths('instructions', ['请遵循 subdir/CLAUDE.md 的约定'])).toEqual(['subdir/CLAUDE.md'])
  })

  it('通用路径模式（含 / 的相对路径 token）', () => {
    expect(extractInjectFilePaths('instructions', ['配置在 config/settings.json 中'])).toEqual(['config/settings.json'])
  })

  it('排除：http(s) URL、命令行 flag、纯数字/版本号', () => {
    expect(extractInjectFilePaths('notice', ['访问 https://example.com/a/b.png 查看'])).toEqual([])
    expect(extractInjectFilePaths('notice', ['运行 pnpm --filter app build 无路径'])).toEqual([])
    expect(extractInjectFilePaths('notice', ['版本 1.2.3 与 2024 已排除'])).toEqual([])
  })

  it('排除：.. 逃逸与基座内部前缀', () => {
    expect(extractInjectFilePaths('instructions', ['读取 ../secrets.txt'])).toEqual([])
    expect(extractInjectFilePaths('instructions', ['依赖在 node_modules/x/y.js'])).toEqual([])
    expect(extractInjectFilePaths('instructions', ['见 .git/config'])).toEqual([])
  })

  it('去重保序', () => {
    expect(extractInjectFilePaths('instructions', [
      '读取 src/a.ts；详见 `src/a.ts` 与 [说明](src/b.ts)。',
    ])).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('snapshot form：逐段独立提取后合并（去重）', () => {
    expect(extractInjectFilePaths('snapshot', [
      'Runtime context: 读取 docs/one.md',
      'Skills: docs/two.md 与 docs/one.md',
    ])).toEqual(['docs/one.md', 'docs/two.md'])
  })

  it('notice summary 参与提取', () => {
    expect(extractInjectFilePaths('notice', [
      'AGENTS.md has changed',
      '文件变更通知：AGENTS.md 被修改',
    ])).toEqual(['AGENTS.md'])
  })

  it('兜底：无任何候选路径返回空数组（宁缺勿错）', () => {
    expect(extractInjectFilePaths('notice', ['会话已开始，请继续工作'])).toEqual([])
    expect(extractInjectFilePaths('notice', [])).toEqual([])
  })

  it('规范化：去 ./、折叠多斜杠', () => {
    expect(extractInjectFilePaths('instructions', ['读取 ./src//a.ts'])).toEqual(['src/a.ts'])
  })
})

// ---------------------------------------------------------------------------
// 误报收紧（真实 12-agent 会话 session-068f8dac 上实测所得；§3.5「宁缺勿错」）
// ---------------------------------------------------------------------------

describe('extractInjectFilePaths · 误报收紧（真实数据回归）', () => {
  it('排除含冒号的字段名/策略名（policy:）', () => {
    // 真实快照原文片段：Current DSH file policy: workspace-write.
    // 「file」命中动词模式，连同结尾冒号一起把 policy: 捕获成了路径。
    expect(extractInjectFilePaths('snapshot', ['Current DSH file policy: workspace-write.'])).toEqual([])
    expect(extractInjectFilePaths('instructions', ['读取 policy: 的说明'])).toEqual([])
  })

  it('排除无扩展名的裸词（sandbox / guards）', () => {
    expect(extractInjectFilePaths('snapshot', ['enforced by the DSH file sandbox may modify files'])).toEqual([])
    expect(extractInjectFilePaths('instructions', ['读取 sandbox 与 guards 的配置'])).toEqual([])
  })

  it('排除末段无扩展名的路径（工具类别名 Bash/formatters）', () => {
    expect(extractInjectFilePaths('instructions', ['工具类别 Bash/formatters 已注册'])).toEqual([])
  })

  it('排除目录条目（src/components），同目录下的真文件不受影响', () => {
    expect(extractInjectFilePaths('instructions', ['见 src/components 目录'])).toEqual([])
    // 对照：目录判定不能误伤「长得很像目录前缀」的真文件
    expect(extractInjectFilePaths('instructions', ['见 src/components/Button.tsx 文件']))
      .toEqual(['src/components/Button.tsx'])
  })

  it('排除 npm 包名形态（@scope/name）', () => {
    expect(extractInjectFilePaths('instructions', ['依赖 @deepseek-ai/dsh-session-persistence-jsonl 提供存储']))
      .toEqual([])
  })

  it('真阳性不误伤：带扩展名路径 / 已知文档名 / 隐藏文件 / 无扩展名白名单', () => {
    expect(extractInjectFilePaths('instructions', ['见 docs/auth-spec.md 与 AGENTS.md']))
      .toEqual(['docs/auth-spec.md', 'AGENTS.md'])
    // 点文件：唯一的点在首位也应算「有扩展名」
    expect(extractInjectFilePaths('instructions', ['读取 .env 的配置'])).toEqual(['.env'])
    // 无扩展名白名单（扩展名判据的已知代价，显式补回）
    expect(extractInjectFilePaths('instructions', ['读取 Makefile 的构建目标'])).toEqual(['Makefile'])
  })

  it('file:line 行号后缀剥离后保留文件（此前会产出两条脏数据）', () => {
    // 修复前：['docs/spec.md:12', 'docs/spec'] —— 一条带冒号、一条被点截断，都是脏数据
    expect(extractInjectFilePaths('instructions', ['读取 docs/spec.md:12'])).toEqual(['docs/spec.md'])
    expect(extractInjectFilePaths('instructions', ['读取 docs/spec.md:12-20'])).toEqual(['docs/spec.md'])
    expect(extractInjectFilePaths('instructions', ['读取 src/index.ts:7'])).toEqual(['src/index.ts'])
  })
})
