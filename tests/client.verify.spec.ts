/**
 * E. client 面验证（QA 独立验证）。
 *
 * 说明：本仓库未装 jsdom / @testing-library（只有 react + react-dom），
 * 因此交互行为分两层验证：
 * - 可测部分：Tab 注册形状（用假 ctx 真调 apply）、store 状态机、filterTree 筛选、
 *   文案字典齐全性、服务端渲染冒烟（react-dom/server）；
 * - 不可测部分：Esc / 遮罩关闭、CSS 三栏比例，按静态审查断言（读取源码文本），
 *   报告中标注为「静态验证」。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as clientEntry from '../src/client/index.tsx'
import { ContextView, CONTEXT_VIEW_ID } from '../src/client/ContextView.tsx'
import { ContextStore, agentMap } from '../src/client/store.ts'
import { filterTree } from '../src/client/panes/InputPane.tsx'
import { selectInputGroups } from '../src/client/selectors.ts'
import { RefPane } from '../src/client/panes/RefPane.tsx'
import { InputPane } from '../src/client/panes/InputPane.tsx'
import { OutputPane } from '../src/client/panes/OutputPane.tsx'
// 组件与 shared 的 AgentBadge 类型同名，组件侧起别名
import { AgentBadge as AgentBadgeView, agentBadgeText } from '../src/client/components/AgentBadge.tsx'
import { agentOptionLabel } from '../src/client/ContextView.tsx'
import { zh, NS, type ContextLocaleKey } from '../src/client/locales/zh-CN.ts'
import { en } from '../src/client/locales/en-US.ts'
import { aggregateContext } from '../src/host/aggregator.ts'
import type { AggregatorEngine, AggregatorEvent } from '../src/host/aggregator.ts'
import type { AgentBadge, ContextAggregate, FileTreeNode } from '../src/shared/types.ts'

const CLIENT_SRC = join(process.cwd(), 'src', 'client')

/** 递归列出 src/client 下的源码文件。 */
function clientFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(CLIENT_SRC)
  return out
}

const t = (key: ContextLocaleKey, params?: Record<string, string | number>): string => {
  const template = zh[key]
  if (template === undefined) return key
  return template.replaceAll(/\{(\w+)\}/g, (_all, name: string) => String(params?.[name] ?? `{${name}}`))
}

describe('E1 · Tab 注册形状（真调 apply，对照 ui-trajectory 惯例）', () => {
  it('注入声明含 slots；注册包在 ctx.slots.inject 里；不传 priority', () => {
    const registered: Array<{ name: string; options: Record<string, unknown>; component: unknown }> = []
    const injected: string[] = []
    const localeRegistered: Array<{ ns: string; dict: unknown }> = []

    const ctx = {
      effect: (fn: () => unknown) => fn(),
      locale: {
        register: (ns: string, dict: unknown) => { localeRegistered.push({ ns, dict }); return () => undefined },
        bind: () => t,
      },
      slots: {
        inject: (slot: string, factory: () => unknown) => { injected.push(slot); return factory() },
        register: (options: Record<string, unknown>, component: unknown) => {
          registered.push({ name: String(options['name']), options, component })
          return () => undefined
        },
      },
    }
    clientEntry.apply(ctx as never)

    expect(clientEntry.inject).toContain('slots')
    expect(clientEntry.inject).toContain('locale')
    expect(injected).toEqual(['conversation.view'])
    expect(registered).toHaveLength(1)

    const entry = registered[0]
    expect(entry?.name).toBe('conversation.view')
    expect(entry?.component).toBe(ContextView)
    // §5 验收点：id / order / locale / label 齐备
    expect(entry?.options).toMatchObject({ id: CONTEXT_VIEW_ID, order: 100, locale: NS })
    expect(typeof entry?.options['label']).toBe('function')
    // 动态插件不传 priority（同 id 同 priority 注册会抛）
    expect(Object.keys(entry?.options ?? {})).not.toContain('priority')
    expect((entry?.options['label'] as () => string)()).toBe(zh['tab.label'])
    // 字典按命名空间注册，中英都在
    expect(localeRegistered).toEqual([{ ns: NS, dict: { zh, en } }])
  })
})

describe('E2 · 文案字典完整性', () => {
  it('中英键集合一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('组件里出现的 t(\'…\') 键全部存在于字典', () => {
    const missing: string[] = []
    for (const file of clientFiles()) {
      if (!/\.tsx?$/.test(file)) continue
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9._]+)'/g)) {
        const key = match[1]
        if (key !== undefined && !(key in zh)) missing.push(`${file.replace(process.cwd(), '.')}:${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('占位符替换：banner.truncated.children 能拿到 scanned/total', () => {
    const text = t('banner.truncated.children', { scanned: 2, total: 5 })
    expect(text).toContain('2')
    expect(text).toContain('5')
    expect(text).not.toContain('{')
  })
})

describe('E3 · client 侧不得误引 host / node 代码', () => {
  it('src/client 下无 node: 内建模块、无 ../host 引用', () => {
    const offenders: string[] = []
    for (const file of clientFiles()) {
      if (!/\.tsx?$/.test(file)) continue
      const source = readFileSync(file, 'utf-8')
      if (/from\s+'node:[^']+'/.test(source)) offenders.push(`${file}: node: import`)
      if (/from\s+'[^']*\/host\//.test(source)) offenders.push(`${file}: host import`)
      if (/from\s+'[^']*dsh-host/.test(source)) offenders.push(`${file}: dsh-host import`)
    }
    expect(offenders).toEqual([])
  })

  it('client 只从 shared/types.ts 取契约，不自行重复声明（除本地 Translate 投影）', () => {
    const offenders: string[] = []
    for (const file of clientFiles()) {
      if (!/\.tsx?$/.test(file)) continue
      const source = readFileSync(file, 'utf-8')
      if (/interface\s+ContextAggregate|interface\s+FileTreeNode|type\s+CtxApiErrorCode\s*=/.test(source)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('E4 · 三栏布局与抽屉（静态审查）', () => {
  it('三栏比例 1 : 1.2 : 1', () => {
    const css = readFileSync(join(CLIENT_SRC, 'ContextView.module.css'), 'utf-8')
    expect(css).toMatch(/grid-template-columns:\s*1fr\s+1\.2fr\s+1fr/)
  })

  it('composer 浮层底部净空（静态审查）：不预留就会被对话框盖住最下面一截条目', () => {
    const css = readFileSync(join(CLIENT_SRC, 'ContextView.module.css'), 'utf-8')
    const tsx = readFileSync(join(CLIENT_SRC, 'ContextView.tsx'), 'utf-8')
    // 视图挂钩子后，基座把 composer 座位改成 absolute 浮在视图底部
    expect(tsx).toContain('data-conversation-composer-overlay')
    // 必须按基座发布的 composer 实时高度（--dsh-composer-height，兜底 152px）+ 余量预留净空
    expect(css).toMatch(/--dsh-composer-height,\s*152px/)
    expect(css).toMatch(/padding-bottom:\s*var\(--dsh-coach-bottom-clearance\)/)
    // box-sizing: border-box 让 padding 计入 height:100%，不产生纵向溢出
    expect(css).toMatch(/\.root\s*\{[^}]*box-sizing:\s*border-box/)
  })

  it('抽屉：window keydown 监听 Escape 关闭 + 遮罩 onClick 关闭 + 面板阻止冒泡', () => {
    const source = readFileSync(join(CLIENT_SRC, 'components', 'Drawer.tsx'), 'utf-8')
    expect(source).toMatch(/event\.key === 'Escape'/)
    expect(source).toMatch(/window\.addEventListener\('keydown', onKey\)/)
    expect(source).toMatch(/removeEventListener\('keydown', onKey\)/)
    expect(source).toMatch(/className=\{css\.mask\}[^>]*onClick=\{onClose\}/s)
    expect(source).toMatch(/onClick=\{event => \{ event\.stopPropagation\(\) \}\}/)
    expect(source).toMatch(/role="dialog"/)
  })

  it('输出栏：最终答复区 / 过程区受 showProcess 控制 / 预览提示行按 previewOnly 渲染', () => {
    const source = readFileSync(join(CLIENT_SRC, 'panes', 'OutputPane.tsx'), 'utf-8')
    // 过程区整体受开关控制，位置在最终答复之后、文件输出之前
    expect(source).toMatch(/showProcess \? \(/)
    expect(source).toMatch(/segment\.previewOnly \? <div className=\{css\.previewHint\}>\{t\('output\.process\.previewHint'\)\}/)
    // 过程区按 round 分组折叠，且默认全折叠（不自动展开末轮）
    expect(source).toMatch(/useState<ReadonlySet<number>>\(\(\) => new Set\(\)\)/)
  })

  it('输入栏：按 groups 渲染 Agent 块；provisional 条目以次要样式呈现', () => {
    const source = readFileSync(join(CLIENT_SRC, 'panes', 'InputPane.tsx'), 'utf-8')
    expect(source).toMatch(/selectInputGroups\(aggregate, selectedAgentKey\)/)
    expect(source).toMatch(/css\.provisional/)
    expect(source).toMatch(/t\('input\.provisional'\)/)
  })

  it('一致性：注入文件的贡献者按可见集合解析，不再扫全局 pluginItems', () => {
    // 同一路径常被多个 Agent 注入：扫全局会把筛到子 Agent 后的归属判给主 Agent，
    // 与主 Agent 视角下的结果自相矛盾。
    const source = readFileSync(join(CLIENT_SRC, 'panes', 'InputPane.tsx'), 'utf-8')
    expect(source).toMatch(/injectSourceByPath/)
    expect(source).not.toMatch(/aggregate\.inputs\.pluginItems\.find/)
  })

  it('一致性：抽屉按 id 取注入全文（seq 跨会话不唯一）', () => {
    const source = readFileSync(join(CLIENT_SRC, 'components', 'Drawer.tsx'), 'utf-8')
    expect(source).toMatch(/entry\.id === target\.id/)
    expect(source).not.toMatch(/entry\.seq === target\.seq/)
  })

  it('抽屉三态：loading / error / ready 均有渲染分支', () => {
    const source = readFileSync(join(CLIENT_SRC, 'components', 'Drawer.tsx'), 'utf-8')
    expect(source).toMatch(/body\.state === 'loading'/)
    expect(source).toMatch(/body\.state === 'error'/)
    expect(source).toMatch(/body\.state === 'ready'/)
  })
})

describe('E5 · store 状态机', () => {
  /** 一个最小聚合载荷。 */
  const aggregate = (sessionId: string, agents: AgentBadge[]): ContextAggregate => ({
    sessionId,
    generatedAt: 1,
    agents,
    inputs: { userItems: [], pluginItems: [], groups: [], injectTree: [], totalItems: 0 },
    references: { tree: [], totalFiles: 0, totalViews: 0 },
    outputs: { textSegments: [], finalByAgent: [], processCount: 0, files: [], totalFiles: 0 },
    budgets: {
      inputsTruncated: false,
      referencesTruncated: false,
      outputsTruncated: false,
      droppedOutputSegments: 0,
      childrenScanned: 0,
      childrenTotal: 0,
    },
  })

  /** 让 store 的 async load 链路跑完（fetch → json → patch 跨多个微任务）。 */
  const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

  let originalFetch: typeof globalThis.fetch | undefined

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch as typeof globalThis.fetch })

  const stubFetch = (body: unknown, status = 200): void => {
    globalThis.fetch = (async() => ({
      status,
      json: async() => body,
    })) as unknown as typeof globalThis.fetch
  }

  it('observe → loading → ready；缓存命中不重复拉取', async () => {
    const store = new ContextStore()
    const payload = { ok: true, data: aggregate('s1', [{ agentKey: 'main', sessionId: 's1', label: 'main', role: 'main' }]) }
    let calls = 0
    globalThis.fetch = (async() => { calls += 1; return { status: 200, json: async() => payload } }) as unknown as typeof globalThis.fetch

    store.observe('s1')
    expect(store.getState().loading).toBe(true)
    await flush()
    expect(store.getState().loading).toBe(false)
    expect(store.getState().aggregate?.sessionId).toBe('s1')
    expect(calls).toBe(1)

    // 同会话重复 observe：条件满足（aggregate 非空且 loading=false）直接返回
    store.observe('s1')
    expect(calls).toBe(1)

    // 换会话再换回来 → 命中缓存（Map 顺序保证 LRU 语义）
    stubFetch(payload)
    store.observe('s2')
    await flush()
    expect(calls).toBe(1)
    stubFetch(payload)
    store.observe('s1')
    expect(store.getState().aggregate?.sessionId).toBe('s1')
    expect(store.getState().loading).toBe(false)
  })

  it('错误包络归一为 LoadError；CTX_SESSION_NOT_FOUND 之外的错误可重试', async () => {
    const store = new ContextStore()
    stubFetch({ ok: false, error: { code: 'CTX_INTERNAL', message: 'boom' } }, 500)
    store.observe('s1')
    await flush()
    expect(store.getState()).toMatchObject({ loading: false, error: { code: 'CTX_INTERNAL', message: 'boom' }, aggregate: null })

    // refresh 后成功 → 错误清空
    stubFetch({ ok: true, data: aggregate('s1', []) })
    store.refresh()
    await flush()
    expect(store.getState().error).toBeNull()
    expect(store.getState().aggregate).not.toBeNull()
  })

  it('HTTP 非 200 且非 JSON → CTX_INTERNAL', async () => {
    const store = new ContextStore()
    globalThis.fetch = (async() => ({
      status: 502,
      json: async() => { throw new Error('not json') },
    })) as unknown as typeof globalThis.fetch
    store.observe('s1')
    await flush()
    expect(store.getState().error).toMatchObject({ code: 'CTX_INTERNAL' })
  })

  it('视图态：选中 Agent / 抽屉开关 / 注入展开 / 过程输出开关 / 窄屏切栏', () => {
    const store = new ContextStore()
    // 过程输出默认关闭，且不跨会话持久化（切换会话/重新加载都会回到 false）
    expect(store.getState().showProcess).toBe(false)
    store.setShowProcess(true)
    expect(store.getState().showProcess).toBe(true)
    store.selectAgent('child-1')
    expect(store.getState().selectedAgentKey).toBe('child-1')
    // 抽屉目标按 **段 id** 定位（§1.3），不再是下标
    store.openDrawer({ kind: 'output-text', id: 's1:7', agentKey: 'main', turn: 1 })
    expect(store.getState().drawer).toMatchObject({ kind: 'output-text', id: 's1:7' })
    store.closeDrawer()
    expect(store.getState().drawer).toBeNull()
    store.setInjectExpanded(true)
    expect(store.getState().injectExpanded).toBe(true)
    store.setNarrowPane('output')
    expect(store.getState().narrowPane).toBe('output')
  })

  it('过程输出开关：切会话/重新加载回到默认关闭（会话内记忆，不落盘）', async () => {
    const store = new ContextStore()
    stubFetch({ ok: true, data: aggregate('s1', []) })
    store.observe('s1')
    await flush()
    store.setShowProcess(true)
    expect(store.getState().showProcess).toBe(true)
    // 换会话：重新加载 → 开关复位
    stubFetch({ ok: true, data: aggregate('s2', []) })
    store.observe('s2')
    await flush()
    expect(store.getState().showProcess).toBe(false)
    // 同会话再次 observe 命中缓存时不复位（会话内记忆）
    store.setShowProcess(true)
    store.observe('s2')
    expect(store.getState().showProcess).toBe(true)
  })

  it('agentMap：按 agentKey 建索引，aggregate 为 null 时给空表', () => {
    expect(agentMap(null).size).toBe(0)
    const map = agentMap(aggregate('s1', [
      { agentKey: 'main', sessionId: 's1', label: 'main', role: 'main' },
      { agentKey: 'c1', sessionId: 'c1', label: 'builder', role: 'subagent' },
    ]))
    expect(map.get('c1')?.label).toBe('builder')
  })

  it('agentBadgeText：main → locale 主Agent；子 Agent → label；缺徽标 → 兜底', () => {
    expect(agentBadgeText({ agentKey: 'main', sessionId: 's', label: 'main', role: 'main' }, t)).toBe(zh['agent.main'])
    expect(agentBadgeText({ agentKey: 'c1', sessionId: 'c1', label: 'builder', role: 'subagent' }, t)).toBe('builder')
    expect(agentBadgeText(undefined, t)).toBe(zh['agent.subagent'])
  })

  it('徽标 hover 文案：任务描述落到 aria-label（自绘 tooltip 的文案源）；降级让位给降级提示', () => {
    const sub: AgentBadge = {
      agentKey: 'c1', sessionId: 'a17c00cf', label: '子Agent · a17c00cf', role: 'subagent',
      title: '讲解复杂多阶段任务的编排方法',
    }
    // 不再用原生 title（延迟 1~2s 且被滚动容器裁切），改为自绘气泡 + aria-label
    const html = renderToStaticMarkup(createElement(AgentBadgeView, { badge: sub, t }))
    expect(html).toContain('aria-label="讲解复杂多阶段任务的编排方法"')
    expect(html).not.toContain('title=')

    const degradedHtml = renderToStaticMarkup(
      createElement(AgentBadgeView, { badge: { ...sub, degraded: true }, t }),
    )
    expect(degradedHtml).toContain(`aria-label="${zh['agent.degraded']}"`)
    expect(degradedHtml).not.toContain('讲解复杂多阶段任务的编排方法')
  })

  it('徽标自绘 tooltip 用 fixed 定位（静态审查：三栏 overflow:auto 会裁掉 absolute）', () => {
    const tsx = readFileSync(join(CLIENT_SRC, 'components', 'AgentBadge.tsx'), 'utf-8')
    const cssText = readFileSync(join(CLIENT_SRC, 'components', 'AgentBadge.module.css'), 'utf-8')
    // 坐标按视口现算，hover 进出都有清理
    expect(tsx).toContain('getBoundingClientRect')
    expect(tsx).toContain('onMouseEnter')
    expect(tsx).toContain('onMouseLeave')
    // fixed 才不参与祖先 overflow 裁切；气泡自身不接鼠标，避免指针下抖动
    expect(cssText).toMatch(/\.tip\s*\{[^}]*position:\s*fixed/)
    expect(cssText).toMatch(/\.tip\s*\{[^}]*pointer-events:\s*none/)
  })

  it('筛选下拉选项：非 Team 子 Agent 并排写出任务描述；主 Agent 不追加', () => {
    // 非 Team 子 Agent 的展示名「子Agent · a17c00cf」彼此无法分辨，任务描述必须可见
    const sub: AgentBadge = {
      agentKey: 'c1', sessionId: 'a17c00cf', label: '子Agent · a17c00cf', role: 'subagent',
      title: '讲解复杂多阶段任务的编排方法',
    }
    const team: AgentBadge = {
      agentKey: 'dev', sessionId: 'e2c86b78', label: 'developer', role: 'subagent',
      title: '负责实现 demo 应用，展示框架特性',
    }
    const main: AgentBadge = {
      agentKey: 'main', sessionId: 's1', label: '高见远', role: 'main',
      title: 'software-company-software-architect',
    }
    expect(agentOptionLabel(sub, t)).toBe('子Agent · a17c00cf · 讲解复杂多阶段任务的编排方法')
    expect(agentOptionLabel(team, t)).toBe('developer · 负责实现 demo 应用，展示框架特性')
    // 主 Agent 无歧义，且其 title 是 preset id 而非任务 → 不追加
    expect(agentOptionLabel(main, t)).toBe('高见远')
  })

  it('筛选下拉选项：超长任务描述截断，主 Agent 无 title 也不炸', () => {
    const long = '任'.repeat(80)
    const sub: AgentBadge = {
      agentKey: 'c1', sessionId: 'a17c00cf', label: '子Agent · a17c00cf', role: 'subagent', title: long,
    }
    const label = agentOptionLabel(sub, t)
    expect(label.startsWith('子Agent · a17c00cf · ')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThan(long.length)
    // 无 title 时回退为纯展示名（不出现尾部空分隔符）
    const bare: AgentBadge = { agentKey: 'c2', sessionId: 'b28d4e6c', label: '子Agent · b28d4e6c', role: 'subagent' }
    expect(agentOptionLabel(bare, t)).toBe('子Agent · b28d4e6c')
  })
})

describe('E6 · 按 Agent 筛选（filterTree + 时间线）', () => {
  const tree: FileTreeNode[] = [
    {
      name: 'src', path: 'src', type: 'dir', agents: ['main', 'c1'],
      children: [
        { name: 'a.ts', path: 'src/a.ts', type: 'file', viewCount: 2, agents: ['main'] },
        { name: 'b.ts', path: 'src/b.ts', type: 'file', viewCount: 3, agents: ['c1'] },
      ],
    },
    { name: 'root.txt', path: 'root.txt', type: 'file', viewCount: 1, agents: ['c1'] },
  ]

  it('null = 全部，原样返回', () => {
    expect(filterTree(tree, null)).toEqual(tree)
  })

  it('选中 Agent：只保留命中文件与其祖先目录', () => {
    const filtered = filterTree(tree, 'c1')
    expect(filtered).toHaveLength(2)
    expect(filtered[0]).toMatchObject({ path: 'src', type: 'dir' })
    expect(filtered[0]?.children).toEqual([{ name: 'b.ts', path: 'src/b.ts', type: 'file', viewCount: 3, agents: ['c1'] }])
    expect(filtered[1]).toMatchObject({ path: 'root.txt' })
  })

  it('选中不存在的 Agent：整棵树清空', () => {
    expect(filterTree(tree, 'nobody')).toEqual([])
  })
})

describe('E7 · 服务端渲染冒烟（不依赖 DOM）', () => {
  it('RefPane / 空聚合不抛异常，渲染出栏标题与空态', () => {
    const aggregate: ContextAggregate = {
      sessionId: 's1', generatedAt: 0, agents: [],
      inputs: { userItems: [], pluginItems: [], groups: [], injectTree: [], totalItems: 0 },
      references: { tree: [], totalFiles: 0, totalViews: 0 },
      outputs: { textSegments: [], finalByAgent: [], processCount: 0, files: [], totalFiles: 0 },
      budgets: {
        inputsTruncated: false,
        referencesTruncated: false,
        outputsTruncated: false,
        droppedOutputSegments: 0,
        childrenScanned: 0,
        childrenTotal: 0,
      },
    }
    // ContextView 依赖 window.matchMedia 与真实 fetch，这里只渲染纯展示的三个 Pane
    const html = renderToStaticMarkup(
      createElement(RefPane, { t, aggregate, agentsMeta: new Map(), selectedAgentKey: null, onOpenDrawer: () => undefined }),
    )
    expect(html).toContain(zh['column.reference'])
    expect(html).toContain(zh['state.empty'])

    // v1.1 重写的输入/输出两栏：空聚合下也不能抛异常
    const inputHtml = renderToStaticMarkup(
      createElement(InputPane, {
        t, aggregate, agentsMeta: new Map(), selectedAgentKey: null,
        injectExpanded: false, onToggleInject: () => undefined, onOpenDrawer: () => undefined,
      }),
    )
    expect(inputHtml).toContain(zh['state.empty'])
    const outputHtml = renderToStaticMarkup(
      createElement(OutputPane, {
        t, aggregate, agentsMeta: new Map(), selectedAgentKey: null,
        showProcess: false, onToggleProcess: () => undefined, onOpenDrawer: () => undefined,
      }),
    )
    expect(outputHtml).toContain(zh['output.final'])
  })

  it('输出栏渲染：最终答复区 + 过程开关（关闭态不渲染过程段）', () => {
    const process = {
      id: 's1:1', seq: 1, time: 1, turn: 1, step: 1, agentKey: 'main', round: 1,
      text: '过程正文', textTruncated: false, kind: 'process' as const, previewOnly: true,
    }
    const final = {
      id: 's1:2', seq: 2, time: 2, turn: 2, step: 1, agentKey: 'main', round: 2,
      text: '最终答复正文', textTruncated: false, kind: 'final' as const, previewOnly: false,
    }
    const aggregate: ContextAggregate = {
      sessionId: 's1', generatedAt: 1,
      agents: [{ agentKey: 'main', sessionId: 's1', label: 'main', role: 'main' }],
      inputs: { userItems: [], pluginItems: [], groups: [], injectTree: [], totalItems: 0 },
      references: { tree: [], totalFiles: 0, totalViews: 0 },
      outputs: {
        textSegments: [process, final],
        finalByAgent: [{ agentKey: 'main', segment: final, processCount: 1 }],
        processCount: 1,
        files: [], totalFiles: 0,
      },
      budgets: {
        inputsTruncated: false, referencesTruncated: false, outputsTruncated: true,
        droppedOutputSegments: 3, childrenScanned: 0, childrenTotal: 0,
      },
    }
    const render = (showProcess: boolean): string => renderToStaticMarkup(
      createElement(OutputPane, {
        t, aggregate, agentsMeta: new Map(), selectedAgentKey: null,
        showProcess, onToggleProcess: () => undefined, onOpenDrawer: () => undefined,
      }),
    )

    const off = render(false)
    expect(off).toContain(zh['output.final'])
    expect(off).toContain('最终答复正文')
    // 开关关闭：过程段正文不出现，但开关与计数在（1 段，已省略 3）
    expect(off).not.toContain('过程正文')
    expect(off).toContain(t('output.toggle.process', { n: 1 }))

    const on = render(true)
    expect(on).toContain(t('output.process.omitted', { n: 1, k: 3 }))
    // 过程区按 round 分组折叠，且**末轮不自动展开**（避免一打开就撑爆视口）
    expect(on).toContain(t('output.round', { round: 1 }))
    expect(on).not.toContain('过程正文')
    // 开关打开后文案切换为「隐藏过程输出」
    expect(on).toContain(zh['output.toggle.process.off'])
  })

  it('输出栏文件节：计数走筛选后的文件数，不用全局 totalFiles', () => {
    // 主 Agent 产出 2 个文件、子 Agent 产出 1 个；全局 totalFiles = 3。
    // 筛到子 Agent 时标题必须显示 1，否则与栏头「… · 1 files」自相矛盾（D1）。
    const files: FileTreeNode[] = [
      { name: 'a.ts', path: 'out/a.ts', type: 'file', outputOp: 'create', agents: ['main'] },
      { name: 'b.ts', path: 'out/b.ts', type: 'file', outputOp: 'create', agents: ['main'] },
      { name: 'c.ts', path: 'out/c.ts', type: 'file', outputOp: 'create', agents: ['c1'] },
    ]
    const aggregate: ContextAggregate = {
      sessionId: 's1', generatedAt: 1,
      agents: [
        { agentKey: 'main', sessionId: 's1', label: 'main', role: 'main' },
        { agentKey: 'c1', sessionId: 'c1', label: 'builder', role: 'subagent' },
      ],
      inputs: { userItems: [], pluginItems: [], groups: [], injectTree: [], totalItems: 0 },
      references: { tree: [], totalFiles: 0, totalViews: 0 },
      outputs: {
        textSegments: [], finalByAgent: [], processCount: 0,
        files, totalFiles: 3,
      },
      budgets: {
        inputsTruncated: false, referencesTruncated: false, outputsTruncated: false,
        droppedOutputSegments: 0, childrenScanned: 0, childrenTotal: 0,
      },
    }
    const render = (selectedAgentKey: string | null): string => renderToStaticMarkup(
      createElement(OutputPane, {
        t, aggregate, agentsMeta: new Map(), selectedAgentKey,
        showProcess: false, onToggleProcess: () => undefined, onOpenDrawer: () => undefined,
      }),
    )

    // 全部视图：3 个文件
    expect(render(null)).toContain(`${zh['output.files']}（3）`)
    // 筛到子 Agent：只剩它自己的 1 个文件，标题计数同步收敛
    const filtered = render('c1')
    expect(filtered).toContain(`${zh['output.files']}（1）`)
    expect(filtered).not.toContain('（3）')
    // 栏头计数与节标题同源
    expect(filtered).toContain(t('pane.counts.output', { n: 0, m: 1 }))
  })

  it('输出栏过程节：「已省略 K 段」是全局事实，只在全部 Agent 视图呈现', () => {
    const process = {
      id: 's1:1', seq: 1, time: 1, turn: 1, step: 1, agentKey: 'main', round: 1,
      text: '过程正文', textTruncated: false, kind: 'process' as const, previewOnly: false,
    }
    const aggregate: ContextAggregate = {
      sessionId: 's1', generatedAt: 1,
      agents: [
        { agentKey: 'main', sessionId: 's1', label: 'main', role: 'main' },
        { agentKey: 'c1', sessionId: 'c1', label: 'builder', role: 'subagent' },
      ],
      inputs: { userItems: [], pluginItems: [], groups: [], injectTree: [], totalItems: 0 },
      references: { tree: [], totalFiles: 0, totalViews: 0 },
      outputs: {
        textSegments: [process],
        finalByAgent: [{ agentKey: 'main', segment: null, processCount: 1 }, { agentKey: 'c1', segment: null, processCount: 0 }],
        processCount: 1,
        files: [], totalFiles: 0,
      },
      // 全局段预算丢弃了 12 段（无法归因到具体 Agent）
      budgets: {
        inputsTruncated: false, referencesTruncated: false, outputsTruncated: true,
        droppedOutputSegments: 12, childrenScanned: 0, childrenTotal: 0,
      },
    }
    const render = (selectedAgentKey: string | null): string => renderToStaticMarkup(
      createElement(OutputPane, {
        t, aggregate, agentsMeta: new Map(), selectedAgentKey,
        showProcess: true, onToggleProcess: () => undefined, onOpenDrawer: () => undefined,
      }),
    )

    expect(render(null)).toContain(t('output.process.omitted', { n: 1, k: 12 }))
    // 筛到子 Agent：它自己没有过程段，全局的「已省略 12」也不该配在它头上
    const filtered = render('c1')
    expect(filtered).not.toContain(t('output.process.omitted', { n: 0, k: 12 }))
    expect(filtered).not.toContain('已省略')
  })
})

describe('E8 · 注入文件树的 Agent 归属（契约 §3.3：agents 为共用字段）', () => {
  it('注入文件树节点带上贡献 agentKey，按 Agent 筛选后不为空', async () => {
    const events: AggregatorEvent[] = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } } },
      {
        type: 'user/message', seq: 2, time: 2,
        data: {
          content: [{ type: 'text', text: 'load `docs/guide.md` and AGENTS.md' }],
          source: { kind: 'plugin', plugin: 'p-inject', form: 'instructions' },
        },
      },
    ]
    const engine: AggregatorEngine = {
      readSession: async id => ({ session: { id, cwd: '/ws' }, events }),
      traceSession: async id => ({
        target: { header: { id, cwd: '/ws' } },
        descendants: [{ session: { header: { id: 'c1', cwd: '/ws', parentSession: id } }, descendants: [] }],
      }),
    }
    // 子会话也注入了同一批文件，用于验证多 Agent 归并
    const childEvents: AggregatorEvent[] = [{
      type: 'user/message', seq: 1, time: 3,
      data: {
        content: [{ type: 'text', text: 'read `docs/guide.md`' }],
        source: { kind: 'plugin', plugin: 'p-inject', form: 'instructions' },
      },
    }]
    engine.readSession = async id => ({ session: { id, cwd: '/ws' }, events: id === 'c1' ? childEvents : events })

    const { aggregate } = await aggregateContext(engine, 'main')
    expect(aggregate.inputs.pluginItems).toHaveLength(2)
    expect(aggregate.inputs.injectTree.length).toBeGreaterThan(0)

    const guide = findNode(aggregate.inputs.injectTree, 'docs/guide.md')
    expect(guide).toBeDefined()
    // 两个 Agent 都注入过 → 节点应带上两者，且主在前
    expect(guide?.agents).toEqual(['main', 'c1'])
    // 筛选到子 Agent 时，注入文件树不应被清空
    expect(filterTree(aggregate.inputs.injectTree, 'c1').length).toBeGreaterThan(0)
  })

  it('按 Agent 筛选后 input groups 只剩该 Agent 的块（「过滤块」而非「过滤条目」）', async () => {
    const event = (seq: number, time: number, text: string): AggregatorEvent => ({
      type: 'user/message', seq, time,
      data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
    })
    const engine: AggregatorEngine = {
      readSession: async id => ({
        session: { id, cwd: '/ws' },
        events: id === 'c1'
          ? [event(1, 10, '子 Agent 提示词')]
          : [event(1, 11, '主 Agent 提示词'), event(2, 12, '第二条')],
      }),
      traceSession: async id => ({
        target: { header: { id, cwd: '/ws' } },
        descendants: [{ session: { header: { id: 'c1', cwd: '/ws', parentSession: id } }, descendants: [] }],
      }),
    }
    const { aggregate } = await aggregateContext(engine, 'main')

    const all = selectInputGroups(aggregate, null)
    expect(all.map(group => group.agentKey)).toEqual(['main', 'c1'])
    expect(all.map(group => group.order)).toEqual([0, 1])
    expect(all[0]?.counts).toEqual({ user: 2, inherited: 0, delegations: 0, agentMessages: 0, injections: 0 })

    const onlyChild = selectInputGroups(aggregate, 'c1')
    expect(onlyChild).toHaveLength(1)
    expect(onlyChild[0]?.agentKey).toBe('c1')
    expect(onlyChild[0]?.entries.map(entry => entry.item.text)).toEqual(['子 Agent 提示词'])
    // 分组只存 id 引用，每个 id 都能解析回条目本体（解析前后条目数一致）
    const hostGroup = aggregate.inputs.groups.find(group => group.agentKey === 'c1')
    expect(hostGroup?.entryIds).toHaveLength(onlyChild[0]?.entries.length ?? -1)
    expect(hostGroup?.entryIds).toEqual(onlyChild[0]?.entries.map(entry => entry.item.id))
  })
})

function findNode(nodes: readonly FileTreeNode[], path: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.type === 'dir') {
      const hit = findNode(node.children ?? [], path)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}
