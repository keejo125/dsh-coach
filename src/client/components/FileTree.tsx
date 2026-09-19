/**
 * 通用目录树组件：参考树 / 输出树 / 注入树三处复用（§2）。
 * 支持徽标插槽（×N 查看次数、create/update 标记、Agent 徽标）与排序展示
 * （host 已按 dir 前、字典序排序，这里只做展开态管理）。
 * 超大树默认折叠：初始仅展开第 1 层目录。
 */

import { useMemo, useState } from 'react'
import type { FileTreeNode } from '../../shared/types.ts'
import { AgentBadge, type Translate } from './AgentBadge.tsx'
import type { AgentBadge as AgentBadgeType } from '../../shared/types.ts'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconBrowseOutline16 } from '../icons/index.tsx'
import css from './FileTree.module.css'

export interface FileTreeProps {
  nodes: readonly FileTreeNode[]
  t: Translate
  /** Agent 徽标查找表（agentKey → badge）。 */
  agentsMeta: ReadonlyMap<string, AgentBadgeType>
  /**
   * 注入文件树标记：给文件条目加「系统注入」徽标，与用户主动提供的输入区分。
   * 走组件入参而不是给 FileTreeNode 加字段——注入树里的每个文件本来就都是系统注入的，
   * 没必要为「整棵树的共同属性」往 §3.3 的共用契约里塞字段。
   */
  injected?: boolean
  /** 点击文件节点（不传则文件不可点）。 */
  onSelectFile?: (path: string, node: FileTreeNode) => void
}

/** 展开第 1 层目录的默认集合。 */
function defaultExpanded(nodes: readonly FileTreeNode[]): ReadonlySet<string> {
  const set = new Set<string>()
  for (const node of nodes) {
    if (node.type === 'dir') set.add(node.path)
  }
  return set
}

export function FileTree({ nodes, t, agentsMeta, injected = false, onSelectFile }: FileTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => defaultExpanded(nodes))
  // 换树（筛选/刷新）后重置展开态
  const nodesKey = useMemo(() => JSON.stringify(nodes.map(node => node.path)), [nodes])
  const [seenKey, setSeenKey] = useState(nodesKey)
  if (seenKey !== nodesKey) {
    setSeenKey(nodesKey)
    setExpanded(defaultExpanded(nodes))
  }

  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setExpanded(next)
  }

  const renderRow = (node: FileTreeNode, depth: number) => {
    const isOpen = node.type === 'dir' && expanded.has(node.path)
    const interactive = node.type === 'dir' || onSelectFile !== undefined
    return (
      <div key={`${node.path}:${depth}`} className={css.rowWrap}>
        <div
          className={[
            css.row,
            node.type === 'file' && onSelectFile !== undefined ? css.rowClickable : '',
          ].filter(Boolean).join(' ')}
          style={{ paddingLeft: `${String(depth * 14 + 6)}px` }}
          role={interactive ? 'button' : undefined}
          tabIndex={interactive ? 0 : undefined}
          onClick={() => {
            if (node.type === 'dir') toggle(node.path)
            else onSelectFile?.(node.path, node)
          }}
          onKeyDown={event => {
            if (!interactive) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              if (node.type === 'dir') toggle(node.path)
              else onSelectFile?.(node.path, node)
            }
          }}
        >
          <span className={css.glyph}>
            {node.type === 'dir'
              ? (isOpen ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />)
              : <IconBrowseOutline16 size={14} />}
          </span>
          <span className={node.type === 'dir' ? css.dirName : css.fileName}>{node.name}</span>
          <span className={css.badges}>
            {injected && node.type === 'file' ? (
              <span className={css.injectBadge} title={t('input.injected')}>{t('badge.injected')}</span>
            ) : null}
            {node.outputOp !== undefined ? (
              <span className={`${css.opBadge} ${node.outputOp === 'create' ? css.opCreate : css.opUpdate}`}>
                {t(node.outputOp === 'create' ? 'badge.create' : 'badge.update')}
              </span>
            ) : null}
            {node.viewCount !== undefined && node.viewCount > 0 ? (
              <span className={css.viewBadge} title={t('column.reference')}>{t('badge.views', { n: node.viewCount })}</span>
            ) : null}
            {node.unused === true ? (
              <span className={css.unusedBadge} title={t('coach.references.unusedHint') ?? '本轮读取但未用于任何产物'}>{t('coach.references.unusedTag') ?? '未用'}</span>
            ) : null}
            {(node.agents ?? []).map(agentKey => (
              <AgentBadge key={agentKey} badge={agentsMeta.get(agentKey)} t={t} />
            ))}
          </span>
        </div>
        {node.type === 'dir' && isOpen && node.children !== undefined
          ? node.children.map(child => renderRow(child, depth + 1))
          : null}
      </div>
    )
  }

  if (nodes.length === 0) return null
  return <div className={css.tree}>{nodes.map(node => renderRow(node, 0))}</div>
}
