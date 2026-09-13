/**
 * 输出栏：最终产物优先。
 */

import { useMemo, useState } from 'react'
import type { AgentBadge, ContextAggregate, OutputTextSegment } from '../../shared/types.ts'
import type { DrawerTarget } from '../store.ts'
import { selectFinalAnswers, selectProcessSegments } from '../selectors.ts'
import { AgentBadge as AgentBadgeView, type Translate } from '../components/AgentBadge.tsx'
import { FileTree } from '../components/FileTree.tsx'
import { countFiles, filterTree } from './InputPane.tsx'
import { ChevronGlyph } from '../icons/index.tsx'
import css from '../panes.module.css'

export interface OutputPaneProps {
  t: Translate
  aggregate: ContextAggregate
  agentsMeta: ReadonlyMap<string, AgentBadge>
  selectedAgentKey: string | null
  showProcess: boolean
  onToggleProcess: (showProcess: boolean) => void
  onOpenDrawer: (target: DrawerTarget) => void
}

function formatTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function OutputPane({
  t,
  aggregate,
  agentsMeta,
  selectedAgentKey,
  showProcess,
  onToggleProcess,
  onOpenDrawer,
}: OutputPaneProps) {
  const finals = useMemo(
    () => selectFinalAnswers(aggregate, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )
  const processes = useMemo(
    () => selectProcessSegments(aggregate, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )
  const files = useMemo(
    () => filterTree(aggregate.outputs.files, selectedAgentKey),
    [aggregate, selectedAgentKey],
  )
  const fileCount = useMemo(() => countFiles(files), [files])
  const dropped = selectedAgentKey === null ? aggregate.budgets.droppedOutputSegments : 0

  const [expandedRounds, setExpandedRounds] = useState<ReadonlySet<number>>(() => new Set())
  const [finalsExpanded, setFinalsExpanded] = useState(true)
  const [filesExpanded, setFilesExpanded] = useState(true)

  const toggleRound = (round: number): void => {
    const next = new Set(expandedRounds)
    if (next.has(round)) next.delete(round)
    else next.add(round)
    setExpandedRounds(next)
  }

  const roundGroups = useMemo(() => {
    const map = new Map<number, OutputTextSegment[]>()
    for (const segment of processes) {
      const list = map.get(segment.round)
      if (list === undefined) map.set(segment.round, [segment])
      else list.push(segment)
    }
    return [...map.entries()]
  }, [processes])

  return (
    <div className={css.pane}>
      <header className={css.paneHeader}>
        <div className={css.paneTitle}>{t('column.output')}</div>
        <div className={css.paneSubtitle}>{t('pane.counts.output', { n: finals.length, m: fileCount })}</div>
      </header>

      <div className={css.paneBody}>
        {processes.length > 0 || dropped > 0 ? (
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              checked={showProcess}
              onChange={event => { onToggleProcess(event.target.checked) }}
            />
            <span>{showProcess ? t('output.toggle.process.off') : t('output.toggle.process', { n: processes.length })}</span>
          </label>
        ) : null}

        {/* 最终答复 */}
        {finals.length > 0 || selectedAgentKey !== null ? (
          <button
            type="button"
            className={css.collapsibleTitle}
            title={finalsExpanded ? t('action.collapse') : t('action.expand')}
            onClick={() => { setFinalsExpanded(value => !value) }}
          >
            <ChevronGlyph open={finalsExpanded} className={css.toggleGlyph} />
            {t('output.final')}（{String(finals.length)}）
          </button>
        ) : (
          <div className={css.sectionTitle}>{t('output.final')}</div>
        )}
        {finalsExpanded ? (
          <>
            {finals.length === 0 ? <div className={css.empty}>{t('state.empty')}</div> : null}
            {finals.length === 0 && fileCount === 0 && selectedAgentKey !== null ? (
              <div className={css.hint}>{t('output.noText')}</div>
            ) : null}
            {finals.map(entry => {
              const segment = entry.segment
              if (segment === null) return null
              return (
                <article key={segment.id} className={css.card}>
                  <header className={css.cardHead}>
                    <AgentBadgeView badge={agentsMeta.get(segment.agentKey)} t={t} />
                    <span className={css.time}>{t('output.step', { turn: segment.turn, step: segment.step })}</span>
                    <time className={css.time}>{formatTime(segment.time)}</time>
                    {segment.interrupted === true ? <span className={css.interrupted}>{t('output.interrupted')}</span> : null}
                  </header>
                  <p className={segment.textTruncated ? `${css.cardText} ${css.truncated}` : css.cardText}>{segment.text}</p>
                  <div className={css.cardActions}>
                    <button
                      type="button"
                      className={css.linkButton}
                      onClick={() => { onOpenDrawer({ kind: 'output-text', id: segment.id, agentKey: segment.agentKey, turn: segment.turn }) }}
                    >
                      {t('action.viewFull')}
                    </button>
                  </div>
                </article>
              )
            })}
          </>
        ) : null}

        {/* 过程输出 */}
        {showProcess ? (
          <>
            <div className={css.sectionTitle}>
              {dropped > 0
                ? t('output.process.omitted', { n: processes.length, k: dropped })
                : `${t('output.process')}（${String(processes.length)}）`}
            </div>
            {roundGroups.length === 0 ? <div className={css.empty}>{t('state.empty')}</div> : null}
            {roundGroups.map(([round, roundSegments]) => {
              const collapsed = !expandedRounds.has(round)
              return (
                <div key={`round:${String(round)}`} className={css.roundGroup}>
                  <button type="button" className={css.roundToggle} onClick={() => { toggleRound(round) }}>
                    {t('output.round', { round })}
                    <span className={css.counts}>[{String(roundSegments.length)}]</span>
                    <ChevronGlyph open={!collapsed} className={css.toggleGlyph} />
                  </button>
                  {collapsed ? null : roundSegments.map(segment => (
                    <article key={segment.id} className={css.card}>
                      <header className={css.cardHead}>
                        <AgentBadgeView badge={agentsMeta.get(segment.agentKey)} t={t} />
                        <span className={css.time}>{t('output.step', { turn: segment.turn, step: segment.step })}</span>
                        <time className={css.time}>{formatTime(segment.time)}</time>
                        {segment.interrupted === true ? <span className={css.interrupted}>{t('output.interrupted')}</span> : null}
                      </header>
                      <p className={segment.textTruncated ? `${css.cardText} ${css.truncated}` : css.cardText}>{segment.text}</p>
                      {segment.previewOnly ? <div className={css.previewHint}>{t('output.process.previewHint')}</div> : null}
                      <div className={css.cardActions}>
                        <button
                          type="button"
                          className={css.linkButton}
                          onClick={() => { onOpenDrawer({ kind: 'output-text', id: segment.id, agentKey: segment.agentKey, turn: segment.turn }) }}
                        >
                          {t('action.viewFull')}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )
            })}
          </>
        ) : null}

        {/* 文件输出 */}
        {files.length > 0 ? (
          <>
            <button
              type="button"
              className={css.collapsibleTitle}
              title={filesExpanded ? t('action.collapse') : t('action.expand')}
              onClick={() => { setFilesExpanded(value => !value) }}
            >
              <ChevronGlyph open={filesExpanded} className={css.toggleGlyph} />
              {t('output.files')}（{String(fileCount)}）
            </button>
            {filesExpanded ? (
              <FileTree
                nodes={files}
                t={t}
                agentsMeta={agentsMeta}
                onSelectFile={(path, node) => {
                  onOpenDrawer({
                    kind: 'file',
                    path,
                    agentKeys: node.agents,
                    outputOp: node.outputOp,
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
