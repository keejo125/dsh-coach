/**
 * 输入栏：按 Agent 分组的输入块 + 注入文件树。
 */

import { useMemo, useState } from 'react'
import type { AgentBadge, ContextAggregate, FileTreeNode, InputEntry, PluginInjectItem, UserInputItem } from '../../shared/types.ts'
import type { DrawerTarget } from '../store.ts'
import { selectInputGroups } from '../selectors.ts'
import { AgentBadge as AgentBadgeView, type Translate } from '../components/AgentBadge.tsx'
import { FileTree } from '../components/FileTree.tsx'
import { ChevronGlyph } from '../icons/index.tsx'
import css from '../panes.module.css'

export interface PaneProps {
  t: Translate
  aggregate: ContextAggregate
  agentsMeta: ReadonlyMap<string, AgentBadge>
  selectedAgentKey: string | null
  injectExpanded: boolean
  onToggleInject: (expanded: boolean) => void
  onOpenDrawer: (target: DrawerTarget) => void
}

/** 按 Agent 筛选文件树：保留 agents 命中的文件与其祖先目录。 */
export function filterTree(nodes: readonly FileTreeNode[], selectedAgentKey: string | null): FileTreeNode[] {
  if (selectedAgentKey === null) return [...nodes]
  const keep = (node: FileTreeNode): FileTreeNode | null => {
    if (node.type === 'file') {
      const agents = node.agents ?? []
      return agents.includes(selectedAgentKey) ? { ...node } : null
    }
    const children = (node.children ?? []).map(keep).filter((child): child is FileTreeNode => child !== null)
    if (children.length === 0) return null
    return { ...node, children }
  }
  return nodes.map(keep).filter((node): node is FileTreeNode => node !== null)
}

/** 统计树内文件节点数。 */
export function countFiles(nodes: readonly FileTreeNode[]): number {
  let total = 0
  for (const node of nodes) {
    if (node.type === 'file') total += 1
    else total += countFiles(node.children ?? [])
  }
  return total
}

function formatTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 条目标签的**完整** className（基础样式 + 配色变体）。
 *
 * 必须带空格拼接：此前本函数只返回变体类（无前导空格），调用处
 * `${css.kindTag}${kindTagClass(item.inputKind)}` 会拼成 `kindTagkindDelegation` 这类
 * 非法类名，两个类同时失效——委派指令 / 继承上下文 / 来自XXX的消息因此丢掉了
 * 9px 字号与底色，只有「用户输入」（无变体、只挂基础类）字号正常，
 * 视觉上就表现为几类标签字号不一致。故在此处一次拼好，调用处直接使用。
 */
function kindTagClassName(kind: UserInputItem['inputKind']): string {
  const base = css.kindTag ?? ''
  const variant = kind === 'delegation' ? css.kindDelegation
    : kind === 'inherited' ? css.kindInherited
    : kind === 'agent-message' ? css.kindAgentMessage
    : undefined
  return variant !== undefined && variant.length > 0 ? `${base} ${variant}` : base
}

/** 条目标签文案：agent-message 时把 senderName（lead→主Agent）插值进「来自XXX的消息」。 */
function kindTagName(kind: UserInputItem['inputKind'], senderName: string | undefined, t: Translate): string {
  if (kind === 'inherited') return t('input.kind.inherited')
  if (kind === 'delegation') return t('input.kind.delegation')
  if (kind === 'agent-message') {
    const agent = senderName === 'lead' ? t('agent.main') : (senderName ?? t('agent.subagent'))
    return t('input.kind.agentMessage', { agent })
  }
  return t('input.kind.prompt')
}

/** 条目标签 hover 提示（说明该来源的含义，避免再次误解）。 */
function kindTagTitle(kind: UserInputItem['inputKind'], t: Translate): string | undefined {
  if (kind === 'inherited') return t('input.kind.inheritedHint')
  if (kind === 'delegation') return t('input.kind.delegationHint')
  if (kind === 'agent-message') return t('input.kind.agentMessageHint')
  return undefined
}

function asUserEntry(entry: InputEntry): UserInputItem | null {
  return entry.entryKind === 'user' ? entry.item : null
}

function asInjectEntry(entry: InputEntry): PluginInjectItem | null {
  return entry.entryKind === 'inject' ? entry.item : null
}

function toggleSet(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function InputPane({ t, aggregate, agentsMeta, selectedAgentKey, injectExpanded, onToggleInject, onOpenDrawer }: PaneProps) {
  const groups = useMemo(
    () => selectInputGroups(aggregate, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )
  const injectTree = useMemo(
    () => filterTree(aggregate.inputs.injectTree, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )

  const counts = useMemo(() => {
    let users = 0
    let injections = 0
    for (const group of groups) {
      for (const entry of group.entries) {
        if (entry.entryKind === 'user') users += 1
        else injections += 1
      }
    }
    return { users, injections }
  }, [groups])

  const injectSourceByPath = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of groups) {
      for (const entry of group.entries) {
        if (entry.entryKind !== 'inject') continue
        for (const path of entry.item.filePaths) {
          if (!map.has(path)) map.set(path, entry.item.agentKey)
        }
      }
    }
    return map
  }, [groups])

  const [collapsedUserGroups, setCollapsedUserGroups] = useState<ReadonlySet<string>>(new Set())
  const [treeExpanded, setTreeExpanded] = useState(true)

  return (
    <div className={css.pane}>
      <header className={css.paneHeader}>
        <div className={css.paneTitle}>{t('column.input')}</div>
        <div className={css.paneSubtitle}>{t('pane.counts.input', { n: counts.users, m: counts.injections })}</div>
      </header>

      <div className={css.paneBody}>
        {groups.length === 0 ? <div className={css.empty}>{t('state.empty')}</div> : null}

        {groups.map(group => {
          const userEntries = group.entries
            .map(asUserEntry)
            .filter((item): item is UserInputItem => item !== null)
          const injectEntries = group.entries
            .map(asInjectEntry)
            .filter((item): item is PluginInjectItem => item !== null)

          const usersCollapsed = collapsedUserGroups.has(group.agentKey)

          return (
            <section key={group.agentKey} className={css.agentGroup}>
              <header className={css.agentGroupHead}>
                <AgentBadgeView badge={agentsMeta.get(group.agentKey)} t={t} count={group.entries.length} />
              </header>

              {userEntries.length === 0 && injectEntries.length === 0 ? (
                <div className={css.empty}>{t('state.empty')}</div>
              ) : null}

              {userEntries.length > 0 ? (
                <button
                  type="button"
                  className={css.collapsibleTitle}
                  title={usersCollapsed ? t('action.expand') : t('action.collapse')}
                  onClick={() => { setCollapsedUserGroups(toggleSet(collapsedUserGroups, group.agentKey)) }}
                >
                  <ChevronGlyph open={!usersCollapsed} className={css.toggleGlyph} />
                  {t('input.dialog')}（{String(userEntries.length)}）
                </button>
              ) : null}

              {!usersCollapsed && userEntries.map(item => {
                const provisional = item.provisional === true
                return (
                  <article
                    key={item.id}
                    className={`${css.card}${provisional ? ` ${css.provisional}` : ''}`}
                  >
                    <header className={css.cardHead}>
                      <span
                        className={kindTagClassName(item.inputKind)}
                        title={kindTagTitle(item.inputKind, t)}
                      >
                        {kindTagName(item.inputKind, item.senderName, t)}
                      </span>
                      <time className={css.time}>{formatTime(item.time)}</time>
                    </header>
                    <p className={item.textTruncated ? `${css.cardText} ${css.truncated}` : css.cardText}>{item.text}</p>
                    {item.attachments.length > 0 ? (
                      <div className={css.chips}>
                        {item.attachments.map((attachment, index) => (
                          <span key={`${item.id}:att:${String(index)}`} className={css.chip} title={attachment.mediaType ?? undefined}>
                            📎 {attachment.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {provisional ? <div className={css.provisionalHint}>{t('input.provisional')}</div> : null}
                  </article>
                )
              })}

              {injectEntries.length > 0 ? (
                <>
                  <button
                    type="button"
                    className={css.sectionToggle}
                    title={injectExpanded ? t('action.collapse') : t('action.expand')}
                    onClick={() => { onToggleInject(!injectExpanded) }}
                  >
                    <ChevronGlyph open={injectExpanded} className={css.toggleGlyph} />
                    {t('input.injected')}（{String(injectEntries.length)}）
                  </button>
                  {injectExpanded ? (
                    <div className={css.injectList}>
                      {injectEntries.map(item => (
                        <button
                          key={item.id}
                          type="button"
                          className={css.injectItem}
                          onClick={() => {
                            onOpenDrawer({ kind: 'inject', id: item.id, agentKey: item.agentKey, plugin: item.plugin })
                          }}
                        >
                          <span className={css.injectMeta}>
                            <span className={css.kindTag}>{t('input.kind.inject')}</span>
                            <code className={css.injectPlugin}>{item.plugin}</code>
                            {item.form !== undefined ? <span className={css.injectForm}>{item.form}</span> : null}
                            <time className={css.time}>{formatTime(item.time)}</time>
                          </span>
                          {item.summary !== undefined ? <span className={css.injectSummary}>{item.summary}</span> : null}
                          <span className={css.injectPreview}>{item.text.slice(0, 120)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          )
        })}

        {injectTree.length > 0 ? (
          <>
            <button
              type="button"
              className={css.collapsibleTitle}
              title={treeExpanded ? t('action.collapse') : t('action.expand')}
              onClick={() => { setTreeExpanded(value => !value) }}
            >
              <ChevronGlyph open={treeExpanded} className={css.toggleGlyph} />
              {t('input.injected')}（{String(countFiles(injectTree))}）
            </button>
            {treeExpanded ? (
              <FileTree
                nodes={injectTree}
                t={t}
                agentsMeta={agentsMeta}
                injected
                onSelectFile={path => {
                  const source = injectSourceByPath.get(path)
                  onOpenDrawer({
                    kind: 'file',
                    path,
                    agentKeys: source !== undefined ? [source] : undefined,
                  })
                }}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
