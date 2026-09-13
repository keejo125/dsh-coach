/**
 * 参考栏：目录树 + 查看徽标 + Agent 徽标。
 */

import { useMemo, useState } from 'react'
import type { AgentBadge, ContextAggregate, FileTreeNode } from '../../shared/types.ts'
import type { DrawerTarget } from '../store.ts'
import { FileTree } from '../components/FileTree.tsx'
import { filterTree } from './InputPane.tsx'
import type { Translate } from '../components/AgentBadge.tsx'
import { ChevronGlyph } from '../icons/index.tsx'
import css from '../panes.module.css'

export interface RefPaneProps {
  t: Translate
  aggregate: ContextAggregate
  agentsMeta: ReadonlyMap<string, AgentBadge>
  selectedAgentKey: string | null
  onOpenDrawer: (target: DrawerTarget) => void
}

export type { Translate }

export function RefPane({ t, aggregate, agentsMeta, selectedAgentKey, onOpenDrawer }: RefPaneProps) {
  const tree = useMemo(
    () => filterTree(aggregate.references.tree, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )
  const totals = useMemo(() => {
    let files = 0
    let views = 0
    const walk = (nodes: readonly FileTreeNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'file') {
          files += 1
          views += node.viewCount ?? 0
        } else {
          walk(node.children ?? [])
        }
      }
    }
    walk(tree)
    return { files, views }
  }, [tree])

  const [treeExpanded, setTreeExpanded] = useState(true)

  return (
    <div className={css.pane}>
      <header className={css.paneHeader}>
        <div className={css.paneTitle}>{t('column.reference')}</div>
        <div className={css.paneSubtitle}>
          {t('column.reference')} · {String(totals.files)} · ×{String(totals.views)}
        </div>
      </header>

      <div className={css.paneBody}>
        {tree.length === 0 ? <div className={css.empty}>{t('state.empty')}</div> : null}
        {tree.length > 0 ? (
          <button
            type="button"
            className={css.collapsibleTitle}
            title={treeExpanded ? t('action.collapse') : t('action.expand')}
            onClick={() => { setTreeExpanded(value => !value) }}
          >
            <ChevronGlyph open={treeExpanded} className={css.toggleGlyph} />
            {t('column.reference')}（{String(totals.files)}）
          </button>
        ) : null}
        {treeExpanded ? (
          <FileTree
            nodes={tree}
            t={t}
            agentsMeta={agentsMeta}
            onSelectFile={(path, node) => {
              onOpenDrawer({
                kind: 'file',
                path,
                agentKeys: node.agents,
                viewCount: node.viewCount,
              })
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
