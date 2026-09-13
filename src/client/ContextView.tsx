/**
 * Tab 根组件：三栏布局（1 : 1.2 : 1，窄屏单栏切换）+ Agent 筛选下拉 + 刷新（§2）。
 * 激活时拉取一次聚合；手动刷新按钮绕过缓存重新聚合（§1.3.5）。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AgentBadge, ContextAggregate } from '../shared/types.ts'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { agentMap, ContextStore, type DrawerTarget } from './store.ts'
import {
  selectBanners,
  selectFinalSegments,
  selectInputEntries,
  selectProcessSegments,
  selectVisibleTruncation,
} from './selectors.ts'
import { Drawer } from './components/Drawer.tsx'
import { agentBadgeText, type Translate } from './components/AgentBadge.tsx'
import { InputPane } from './panes/InputPane.tsx'
import { RefPane } from './panes/RefPane.tsx'
import { OutputPane } from './panes/OutputPane.tsx'
import css from './ContextView.module.css'

export type ContextViewProps = ConvViewProps & PropsLocale<'dsh-coach'>

/** 本 Tab 在 conversation.view 槽位里的条目 id（注册处与深链命中共用，避免字面量漂移）。 */
export const CONTEXT_VIEW_ID = 'coach'

/**
 * 深链焦点标识的前缀。`focus` 是**本 Tab 自有的**不透明串，语义由本 Tab 定义：
 * - `file:<工作区相对路径>` → 打开该文件正文抽屉
 * - `output:<段 id>` → 打开该文字输出段的全文抽屉（id = `<sessionId>:<seq>`，跨会话重放仍指同一段）
 */
const FOCUS_FILE = 'file:'
const FOCUS_OUTPUT = 'output:'

/** 下拉选项里任务描述的最大字数（超出截断，全文以 title 悬停补）。 */
const AGENT_OPTION_TASK_LIMIT = 40

/**
 * Agent 筛选下拉的选项文案：展示名 + 任务描述。
 *
 * 非 Team 子 Agent 的展示名形如「子Agent · a17c3f2b」，彼此无法分辨，而任务描述
 * 原本只挂在 `title` 上——**原生 `<option>` 的 title 大多数浏览器根本不显示**，
 * 于是「悬停看不到任务描述」。故把任务描述并排写进选项文本，选的时候就能看清是谁。
 * 主 Agent 不追加：它无歧义，且其 title 是 preset id 而非任务。
 */
export function agentOptionLabel(badge: AgentBadge, t: Translate): string {
  const name = agentBadgeText(badge, t)
  if (badge.role !== 'subagent') return name
  const task = badge.title
  if (task === undefined || task.length === 0 || task === name) return name
  const clipped = task.length > AGENT_OPTION_TASK_LIMIT
    ? `${task.slice(0, AGENT_OPTION_TASK_LIMIT - 1)}…`
    : task
  return `${name} · ${clipped}`
}

/**
 * 消费基座发来的深链焦点请求（ConvViewOwnerProps.viewRequest）。
 *
 * 认不出来的 focus 也要 acknowledge：请求是一次性的，不 ack 会一直挂在
 * 会话状态里。地址不是本 Tab 的（view !== 'coach'）则完全不参与。
 */
function useViewFocus(
  viewRequest: ContextViewProps['viewRequest'],
  completeViewRequest: ContextViewProps['completeViewRequest'],
  store: ContextStore,
  aggregate: ContextAggregate,
): void {
  useEffect(() => {
    if (viewRequest === null || viewRequest.view !== CONTEXT_VIEW_ID) return
    const focus = viewRequest.focus
    if (focus.startsWith(FOCUS_FILE)) {
      const path = focus.slice(FOCUS_FILE.length)
      if (path.length > 0) store.openDrawer({ kind: 'file', path })
    } else if (focus.startsWith(FOCUS_OUTPUT)) {
      const token = focus.slice(FOCUS_OUTPUT.length)
      // 兼容 v1.0 的旧深链：纯数字按 textSegments 下标解析（已 deprecated）
      const segment = /^\d+$/.test(token)
        ? aggregate.outputs.textSegments[Number(token)]
        : aggregate.outputs.textSegments.find(candidate => candidate.id === token)
      if (segment !== undefined) {
        store.openDrawer({ kind: 'output-text', id: segment.id, agentKey: segment.agentKey, turn: segment.turn })
      }
    }
    completeViewRequest()
  }, [viewRequest, completeViewRequest, store, aggregate])
}

/** 模块级共享 store：Tab 卸载/切换后缓存仍在（§7.5）。 */
let sharedStore: ContextStore | undefined
function getStore(): ContextStore {
  if (sharedStore === undefined) sharedStore = new ContextStore()
  return sharedStore
}

/** 窄屏断点（单栏切换模式）。 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState((): boolean =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)')
    const onChange = (event: MediaQueryListEvent): void => { setNarrow(event.matches) }
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [])
  return narrow
}

/** 生成空聚合，避免 loading/错误态下三栏 props 判空分支。 */
function emptyAggregate(sessionId: string): ContextAggregate {
  return {
    sessionId,
    generatedAt: 0,
    agents: [],
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
}

export function ContextView({ sessionId, t, viewRequest, completeViewRequest }: ContextViewProps) {
  const store = getStore()
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const narrow = useNarrow()

  useEffect(() => {
    store.observe(sessionId)
  }, [store, sessionId])

  const agentsMeta = useMemo(() => agentMap(state.aggregate), [state.aggregate])
  const aggregate = state.aggregate ?? emptyAggregate(sessionId)
  const selectedAgentKey = state.selectedAgentKey
  // 选中项的完整徽标（下拉收起时用它补全 title：选项文本可能已被截断）
  const selectedAgent = aggregate.agents.find(badge => badge.agentKey === selectedAgentKey)

  useViewFocus(viewRequest, completeViewRequest, store, aggregate)

  // —— 横幅两类分派（§1.6） ——
  // 全局类（条目/段数超上限、子会话降级）是**未筛选的全局事实**，只在「全部 Agent」
  // 视图显示；可见类（单条正文被 4KB 截断）基于筛选后可见集合实时重算，任何视图都跟随。
  // 三个消费者（横幅 / 栏头计数 / 渲染）共用 selectors 的同一份结果，不可能再不一致。
  const inputEntries = useMemo(
    () => selectInputEntries(aggregate, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )
  const finalSegments = useMemo(
    () => selectFinalSegments(aggregate, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )
  const processSegments = useMemo(
    () => selectProcessSegments(aggregate, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )
  const visibleSegments = useMemo(
    () => (state.showProcess ? [...finalSegments, ...processSegments] : finalSegments),
    [state.showProcess, finalSegments, processSegments],
  )
  const visibleTruncation = useMemo(
    () => selectVisibleTruncation(inputEntries, visibleSegments),
    [inputEntries, visibleSegments],
  )

  const banners = useMemo(
    () => selectBanners(aggregate, selectedAgentKey, visibleTruncation),
    [aggregate, selectedAgentKey, visibleTruncation],
  )

  const openDrawer = (target: DrawerTarget): void => { store.openDrawer(target) }

  return (
    // data-conversation-composer-overlay：宿主布局钩子（与 Trajectory Tab 同款）。
    // 宿主 active 阶段把视图容器 .viewArea 设为 flex:1 0 auto / min-height:auto
    // （按内容撑高 → 整体外溢成一个统一滚动条）；命中 :has() 后容器改为
    // flex:1 1 0 / min-height:0 / overflow:hidden，容器才有确定高度，
    // 本组件 .root 的 height:100% 才能生效，三栏才各自滚动。
    <div className={css.root} data-conversation-composer-overlay="">
      {/* —— 工具条 —— */}
      <div className={css.toolbar}>
        <label className={css.filter}>
          <span className={css.filterLabel}>{t('filter.agent')}</span>
          <select
            className={css.select}
            value={selectedAgentKey ?? ''}
            onChange={event => { store.selectAgent(event.target.value === '' ? null : event.target.value) }}
            {...(selectedAgent === undefined ? {} : { title: agentOptionLabel(selectedAgent, t) })}
          >
            <option value="">{t('filter.agent.all')}</option>
            {aggregate.agents.map(badge => (
              <option key={badge.agentKey} value={badge.agentKey}>
                {agentOptionLabel(badge, t)}
              </option>
            ))}
          </select>
        </label>
        {narrow ? (
          <div className={css.paneSwitch}>
            {(['input', 'ref', 'output'] as const).map(pane => (
              <button
                key={pane}
                type="button"
                className={`${css.paneSwitchButton}${state.narrowPane === pane ? ` ${css.paneSwitchActive}` : ''}`}
                onClick={() => { store.setNarrowPane(pane) }}
              >
                {t(pane === 'input' ? 'pane.narrow.input' : pane === 'ref' ? 'pane.narrow.reference' : 'pane.narrow.output')}
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" className={css.refresh} onClick={() => { store.refresh() }}>{t('action.refresh')}</button>
      </div>

      {/* —— 截断/降级提示条 —— */}
      {banners.length > 0 ? (
        <div className={css.banners}>
          {banners.map(banner => (
            <div key={banner.key} className={css.banner}>{t(banner.key, banner.params)}</div>
          ))}
        </div>
      ) : null}

      {/* —— 状态层 —— */}
      {state.loading && state.aggregate === null ? <div className={css.state}>{t('state.loading')}</div> : null}
      {!state.loading && state.error !== null && state.aggregate === null ? (
        <div className={css.state}>
          <div className={state.error.code === 'CTX_SESSION_NOT_FOUND' ? css.stateMuted : css.stateError}>
            {state.error.code === 'CTX_SESSION_NOT_FOUND' ? t('state.notFound') : `${t('state.error')}：${state.error.message}`}
          </div>
          {state.error.code !== 'CTX_SESSION_NOT_FOUND' ? (
            <button type="button" className={css.retry} onClick={() => { store.refresh() }}>{t('state.retry')}</button>
          ) : null}
        </div>
      ) : null}

      {/* —— 三栏 —— */}
      <div className={`${css.columns}${narrow ? ` ${css.columnsNarrow}` : ''}`}>
        {(!narrow || state.narrowPane === 'input') ? (
          <section className={css.colInput} aria-label={t('column.input')}>
            <InputPane
              t={t}
              aggregate={aggregate}
              agentsMeta={agentsMeta}
              selectedAgentKey={selectedAgentKey}
              injectExpanded={state.injectExpanded}
              onToggleInject={expanded => { store.setInjectExpanded(expanded) }}
              onOpenDrawer={openDrawer}
            />
          </section>
        ) : null}
        {(!narrow || state.narrowPane === 'ref') ? (
          <section className={css.colRef} aria-label={t('column.reference')}>
            <RefPane
              t={t}
              aggregate={aggregate}
              agentsMeta={agentsMeta}
              selectedAgentKey={selectedAgentKey}
              onOpenDrawer={openDrawer}
            />
          </section>
        ) : null}
        {(!narrow || state.narrowPane === 'output') ? (
          <section className={css.colOutput} aria-label={t('column.output')}>
            <OutputPane
              t={t}
              aggregate={aggregate}
              agentsMeta={agentsMeta}
              selectedAgentKey={selectedAgentKey}
              showProcess={state.showProcess}
              onToggleProcess={show => { store.setShowProcess(show) }}
              onOpenDrawer={openDrawer}
            />
          </section>
        ) : null}
      </div>

      {/* —— 抽屉 —— */}
      {state.drawer !== null && state.aggregate !== null ? (
        <Drawer
          target={state.drawer}
          sessionId={sessionId}
          aggregate={state.aggregate}
          agentsMeta={agentsMeta}
          t={t}
          onClose={() => { store.closeDrawer() }}
        />
      ) : null}
    </div>
  )
}
