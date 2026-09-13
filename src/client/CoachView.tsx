/**
 * 复盘 Tab 根组件（v0.2b）：消费 /coach/api 把一场会话变成可追溯的复盘报告。
 *
 * 区块：总分卡（评级+最低分提示）· 六维雷达 · 本场统计 · 交互时间线（逐轮可展开）·
 * 子智能体 · 引用分析（高频 Top + 未使用）· Token 分布（可降级）· 上下文构成 ·
 * 六维明细 · 产物清单。数据一次拉取（report + timeline 并行），刷新即重算。
 */

import { useEffect, useMemo, useState } from 'react'
import type { CoachArtifactFile, CoachArtifacts, CoachReport, CoachTimeline, CoachTimelineRound, FileTreeNode } from '../shared/types.ts'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CoachApiError, fetchCoachReport, fetchCoachTimeline } from './coach-client.ts'
import { FileTree } from './components/FileTree.tsx'
import type { Translate } from './components/AgentBadge.tsx'
import css from './CoachView.module.css'

export type CoachViewProps = ConvViewProps & PropsLocale<'dsh-coach'>

/** 本 Tab 在 conversation.view 槽位里的条目 id（注册处与深链命中共用）。 */
export const COACH_VIEW_ID = 'coach'

/** 文件树通用条目（产物带 outputOp、参考带 viewCount）。 */
export interface CoachTreeEntry {
  path: string
  outputOp?: 'create' | 'update'
  viewCount?: number
}

/** 把文件条目构建为文件树（dir 前、字典序；file 节点带徽标字段）。 */
export function buildFileTree(entries: readonly CoachTreeEntry[]): FileTreeNode[] {
  interface Builder { files: Map<string, CoachTreeEntry>; dirs: Map<string, Builder> }
  const tree: Builder = { files: new Map(), dirs: new Map() }
  for (const file of entries) {
    const segments = file.path.split('/')
    let level = tree
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i] as string
      let dir = level.dirs.get(seg)
      if (dir === undefined) {
        dir = { files: new Map(), dirs: new Map() }
        level.dirs.set(seg, dir)
      }
      level = dir
    }
    const name = segments.at(-1)
    if (name !== undefined) level.files.set(name, file)
  }
  const emit = (builder: Builder, parentPath: string): FileTreeNode[] => {
    const nodes: FileTreeNode[] = []
    for (const name of [...builder.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
      const dir = builder.dirs.get(name)
      if (dir === undefined) continue
      const path = parentPath.length === 0 ? name : `${parentPath}/${name}`
      nodes.push({ name, path, type: 'dir', children: emit(dir, path) })
    }
    for (const name of [...builder.files.keys()].sort((a, b) => a.localeCompare(b))) {
      const file = builder.files.get(name)
      if (file === undefined) continue
      const path = parentPath.length === 0 ? name : `${parentPath}/${name}`
      // exactOptionalPropertyTypes：undefined 显式赋值非法，条件式挂徽标字段
      const node: FileTreeNode = { name, path, type: 'file' }
      if (file.outputOp !== undefined) node.outputOp = file.outputOp
      if (file.viewCount !== undefined) node.viewCount = file.viewCount
      nodes.push(node)
    }
    return nodes
  }
  return emit(tree, '')
}

/** 把产物明细构建为文件树（file 节点带 outputOp 徽标）。导出供 SSR 冒烟测试。 */
export function buildArtifactTree(files: readonly CoachArtifactFile[]): FileTreeNode[] {
  return buildFileTree(files.map(file => ({ path: file.path, outputOp: file.op })))
}

/** 评级档位（spec/09 §3：≥90 优秀 / ≥75 良好 / ≥60 一般 / <60 待改进）。 */
function ratingOf(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (score >= 90) return 'excellent'
  if (score >= 75) return 'good'
  if (score >= 60) return 'fair'
  return 'poor'
}

const DIMENSION_LABELS: Record<string, string> = {
  completion: 'completion',
  efficiency: 'efficiency',
  recovery: 'recovery',
  artifact: 'artifact',
  delegation: 'delegation',
  context: 'context',
}

/** 六维雷达：正六边形网格 + 数据多边形（SVG 手绘，无外部依赖）。 */
function RadarChart({ dimensions }: { dimensions: CoachReport['score']['dimensions'] }): JSX.Element {
  const center = 110
  const radius = 74
  const value = (id: string): number => dimensions.find(d => d.id === id)?.score ?? 0
  const point = (index: number, score: number): [number, number] => {
    const angle = (Math.PI / 3) * index - Math.PI / 2
    const r = (score / 100) * radius
    return [center + r * Math.cos(angle), center + r * Math.sin(angle)]
  }
  const order = ['completion', 'efficiency', 'recovery', 'artifact', 'delegation', 'context']
  const dataPoints = order.map((id, i) => point(i, value(id)))
  const gridLevels = [1, 2, 3, 4]
  const labelPoint = (index: number): [number, number] => {
    const angle = (Math.PI / 3) * index - Math.PI / 2
    return [center + (radius + 20) * Math.cos(angle), center + (radius + 20) * Math.sin(angle)]
  }
  return (
    <svg viewBox="0 0 220 220" role="img" aria-label="radar" className={css.radar}>
      {gridLevels.map(level => (
        <polygon
          key={level}
          points={order.map((_, i) => {
            const [x, y] = point(i, level * 25)
            return `${x},${y}`
          }).join(' ')}
          className={css.radarGrid}
        />
      ))}
      <polygon points={dataPoints.map(([x, y]) => `${x},${y}`).join(' ')} className={css.radarData} />
      {dataPoints.map(([x, y], i) => <circle key={order[i]} cx={x} cy={y} r={3} className={css.radarDot} />)}
      {order.map((id, i) => {
        const [x, y] = labelPoint(i)
        return (
          <text key={id} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className={css.radarLabel}>
            {DIMENSION_LABELS[id] ?? id} {value(id)}
          </text>
        )
      })}
    </svg>
  )
}

/** 评分条（六维明细）。 */
function ScoreBar({ label, score }: { label: string; score: number }): JSX.Element {
  const tone = score >= 80 ? css.barGood : (score >= 60 ? css.barMid : css.barPoor)
  return (
    <div className={css.scoreRow}>
      <span className={css.scoreLabel}>{label}</span>
      <div className={css.barTrack}><div className={`${css.barFill} ${tone}`} style={{ width: `${score}%` }} /></div>
      <span className={css.scoreValue}>{score}</span>
    </div>
  )
}

/** 复盘 Tab 根组件。 */
export function CoachView({ sessionId, t }: CoachViewProps): JSX.Element {
  const [report, setReport] = useState<CoachReport | null>(null)
  const [timeline, setTimeline] = useState<CoachTimeline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = (): void => {
    setLoading(true)
    setError(null)
    void Promise.all([
      fetchCoachReport(sessionId).then(setReport),
      fetchCoachTimeline(sessionId).then(setTimeline),
    ]).catch((err: unknown) => {
      setError(err instanceof CoachApiError ? err.message : t('coach.state.error'))
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  if (loading && report === null) return <div className={css.state}>{t('coach.state.empty')}…</div>
  if (error !== null && report === null) {
    return (
      <div className={css.state}>
        <div>{t('coach.state.error')}: {error}</div>
        <button className={css.retry} onClick={load}>{t('coach.state.retry')}</button>
      </div>
    )
  }
  if (report === null) return <div className={css.state}>{t('coach.state.empty')}</div>

  const rating = ratingOf(report.score.total)
  const lowest = [...report.score.dimensions].sort((a, b) => a.score - b.score)[0]
  const scope = report.scope
  const signals = report.signals

  return (
    <div className={css.wrap}>
      <div className={css.header}>
        <div>
          <div className={css.title}>{t('coach.header.subtitle')}</div>
          <div className={css.subtitle}>{sessionId}</div>
        </div>
        <button className={css.refresh} onClick={load}>{t('action.refresh')}</button>
      </div>

      {/* 总分 + 雷达 + 统计 */}
      <div className={css.grid3}>
        <section className={css.card}>
          <div className={css.cardTitle}>{t('coach.score.title')}</div>
          <div className={css.scoreBig}>{report.score.total}</div>
          <span className={css.rating}>{t(`coach.score.rating.${rating}`)}</span>
          {lowest !== undefined && (
            <div className={css.hint}>
              {DIMENSION_LABELS[lowest.id] ?? lowest.id} {lowest.score} · {t('coach.score.noDetail')}
            </div>
          )}
        </section>

        <section className={css.card}>
          <div className={css.cardTitle}>{t('coach.radar.title')}</div>
          <RadarChart dimensions={report.score.dimensions} />
        </section>

        <section className={css.card}>
          <div className={css.cardTitle}>{t('coach.stats.title')}</div>
          <div className={css.stats}>
            <Stat label={t('coach.stats.interactions')} value={scope.userTurns} />
            <Stat label={t('coach.stats.followUps')} value={signals.followUps} />
            <Stat label={t('coach.stats.interventions')} value={signals.interventions} />
            <Stat label={t('coach.stats.corrections')} value={signals.correctionTurns} />
            <Stat label={t('coach.stats.toolCalls')} value={scope.toolCalls} />
            <Stat label={t('coach.stats.failures')} value={scope.failedToolCalls} danger={scope.failedToolCalls > 0} />
            <Stat label={t('coach.stats.compactions')} value={signals.compactions} />
            <Stat label={t('coach.stats.delegations')} value={scope.delegations} />
          </div>
        </section>
      </div>

      {/* 子智能体 + 引用分析 */}
      <div className={css.grid2}>
        <section className={css.card}>
          <div className={css.cardTitle}>{t('coach.agents.title')}</div>
          {report.agents.length === 0
            ? <div className={css.muted}>{t('coach.agents.empty')}</div>
            : report.agents.map(agent => (
              <div key={agent.sessionId} className={css.agentRow}>
                <div className={css.agentName}>{agent.label}</div>
                <div className={css.agentMeta}>
                  {t('coach.agents.readFiles', { n: agent.readFiles })} · {t('coach.agents.toolCalls', { n: agent.toolCalls })}
                  {' · '}{agent.failedToolCalls > 0 ? t('coach.agents.failures', { n: agent.failedToolCalls }) : t('coach.agents.hasFinal')}
                  {' · '}{t('coach.agents.writtenFiles', { n: agent.writtenFiles })}
                </div>
              </div>
            ))}
        </section>

        <section className={css.card}>
          <div className={css.cardTitle}>
            {t('coach.references.title')}
            <span className={css.muted}>
              {' '}· {t('coach.stats.references')} {report.references.totalFiles} / {t('coach.stats.views')} {report.references.totalViews}
            </span>
          </div>
          <div className={css.sectionLabel}>{t('coach.references.top')}</div>
          {report.references.topReferences.length === 0
            ? <div className={css.muted}>{t('coach.references.empty')}</div>
            : report.references.topReferences.slice(0, 6).map(ref => (
              <div key={ref.path} className={css.refRow}>
                <span className={css.refPath} title={ref.path}>{ref.path}</span>
                <div className={css.barTrack}><div className={`${css.barFill} ${css.barGood}`} style={{ width: `${Math.min(100, ref.views * 20)}%` }} /></div>
                <span className={css.refViews}>×{ref.views}</span>
              </div>
            ))}
          {report.references.unusedReferences.length > 0 && (
            <>
              <div className={css.sectionLabel}>
                {t('coach.references.unused')}
                <span className={css.muted}> · {t('coach.references.unusedHint')}</span>
              </div>
              {report.references.unusedReferences.slice(0, 4).map(ref => (
                <div key={ref.path} className={`${css.refRow} ${css.unused}`}>
                  <span className={css.refPath} title={ref.path}>{ref.path}</span>
                  <span className={css.refViews}>×{ref.views}</span>
                </div>
              ))}
            </>
          )}
        </section>
      </div>

      {/* Token 分布 + 上下文构成 */}
      <div className={css.grid2}>
        <section className={css.card}>
          <div className={css.cardTitle}>{t('coach.token.title')}</div>
          {report.token === null
            ? <div className={css.muted}>{t('coach.token.unavailable')}</div>
            : (
              <>
                <div className={css.tokenTotal}>
                  {t('coach.token.total')} <b>{report.token.total.toLocaleString()}</b>
                  <span className={css.muted}>
                    {' · '}{t('coach.token.input')} {report.token.input.toLocaleString()}
                    {' · '}{t('coach.token.output')} {report.token.output.toLocaleString()}
                    {' · '}{t('coach.token.cache')} {report.token.cache.toLocaleString()}
                  </span>
                </div>
                {report.token.perTurn.map(turn => (
                  <div key={turn.turn} className={css.turnRow}>
                    <span className={css.refPath}>R{turn.turn}</span>
                    <div className={css.barTrack}>
                      <div className={`${css.barFill} ${css.barToken}`} style={{ width: `${Math.min(100, (turn.total / report.token!.total) * 100)}%` }} />
                    </div>
                    <span className={css.refViews}>{turn.total.toLocaleString()}</span>
                  </div>
                ))}
              </>
            )}
        </section>

        <section className={css.card}>
          <div className={css.cardTitle}>{t('coach.context.title')}</div>
          {report.contextProfile === null
            ? <div className={css.muted}>{t('coach.stats.none')}</div>
            : (
              <div className={css.contextGrid}>
                <ContextStat label={t('coach.context.userItems')} value={report.contextProfile.userItems} />
                <ContextStat label={t('coach.context.pluginItems')} value={report.contextProfile.pluginItems} />
                <ContextStat label={t('coach.context.delegations')} value={report.contextProfile.delegations} />
                <ContextStat label={t('coach.context.injectFiles')} value={report.contextProfile.injectFiles} />
                <ContextStat label={t('coach.context.finalSegments')} value={report.contextProfile.finalSegments} />
                <ContextStat label={t('coach.context.processSegments')} value={report.contextProfile.processSegments} />
              </div>
            )}
        </section>
      </div>

      {/* 时间线 */}
      <section className={css.card}>
        <div className={css.cardTitle}>
          {t('coach.timeline.title')}
          <span className={css.muted}> · {t('coach.timeline.expandHint')}</span>
        </div>
        {timeline === null || timeline.rounds.length === 0
          ? <div className={css.muted}>{t('coach.timeline.noRounds')}</div>
          : timeline.rounds.map((round, index) => (
            <details key={index} className={css.round}>
              <summary className={css.roundHead}>
                <span className={round.kind === 'initial' ? css.tagInitial : css.tagFollow}>
                  {round.kind === 'initial' ? t('coach.timeline.initial') : t('coach.timeline.followup')}
                </span>
                <span className={css.roundText}>{round.userText}</span>
                {round.signals.intervention && <span className={css.tagWarn}>{t('coach.timeline.intervention')}</span>}
                {round.signals.correction && <span className={css.tagError}>{t('coach.timeline.correction')}</span>}
                {round.artifacts.length > 0 && (
                  <span className={css.tagOk}>{t('coach.timeline.artifact')} {round.artifacts.length}</span>
                )}
              </summary>
              <RoundDetail round={round} t={t} />
            </details>
          ))}
      </section>

      {/* 六维明细 + 产物 */}
      <div className={css.grid2}>
        <section className={css.card}>
          <div className={css.cardTitle}>{t('coach.dimensions.title')}</div>
          {report.score.dimensions.map(dimension => (
            <ScoreBar key={dimension.id} label={DIMENSION_LABELS[dimension.id] ?? dimension.id} score={dimension.score} />
          ))}
        </section>

        <section className={css.card}>
          <div className={css.cardTitle}>{t('coach.artifacts.title')}</div>
          {report.artifacts.writtenFiles === 0
            ? <div className={css.muted}>{t('coach.artifacts.empty')}</div>
            : <ArtifactTree files={report.artifacts.files} counts={report.artifacts} t={t} />}
        </section>
      </div>
    </div>
  )
}

/** 产物清单：计数行 + 文件树（dir 展开、file 带新建/更新徽标）。导出供 SSR 冒烟测试。 */
export function ArtifactTree({
  files,
  counts,
  t,
}: {
  files: readonly CoachArtifactFile[]
  counts: CoachArtifacts
  t: Translate
}): JSX.Element {
  const nodes = useMemo(() => buildArtifactTree(files), [files])
  const iterated = files.filter(file => file.opCount >= 2).length
  return (
    <div className={css.artifactTree}>
      <div className={css.artifactCounts}>
        {t('coach.artifacts.created')} {counts.createdFiles} · {t('coach.artifacts.updated')} {counts.updatedFiles}
        {iterated > 0 ? <> · {t('coach.artifacts.iterated', { n: iterated })}</> : null}
      </div>
      <FileTree nodes={nodes} t={t} agentsMeta={new Map()} />
    </div>
  )
}

/** 由本轮产物明细生成计数（ArtifactTree 入参）。 */
function countsForRound(files: readonly CoachArtifactFile[]): CoachArtifacts {
  return {
    writtenFiles: files.length,
    createdFiles: files.filter(file => file.op === 'create').length,
    updatedFiles: files.filter(file => file.op === 'update').length,
    files: [...files],
  }
}

/** 时间线单轮展开：①对话气泡 ②参考文件树 ③产物文件树 + 过程折叠。导出供 SSR 冒烟测试。 */
export function RoundDetail({ round, t }: { round: CoachTimelineRound; t: Translate }): JSX.Element {
  return (
    <div className={css.roundBody}>
      {/* ① 对话段：与对话框一致的气泡 */}
      <div className={css.chatBlock}>
        <div className={css.chatUser}>{round.userText}</div>
        {round.assistantText !== null && (
          <div className={css.chatAssistant}>{round.assistantText}</div>
        )}
      </div>
      {/* ② 参考段：本轮读过的文件（viewCount 徽标） */}
      {round.references.length > 0 && (
        <div className={css.subBlock}>
          <div className={css.subTitle}>{t('coach.timeline.references')} {round.references.length}</div>
          <FileTree
            nodes={buildFileTree(round.references.map(ref => ({ path: ref.path, viewCount: ref.views })))}
            t={t}
            agentsMeta={new Map()}
          />
        </div>
      )}
      {/* ③ 产物段：本轮产物清单（新建/更新徽标） */}
      {round.artifacts.length > 0 && (
        <div className={css.subBlock}>
          <div className={css.subTitle}>{t('coach.timeline.outputs')} {round.artifacts.length}</div>
          <ArtifactTree files={round.artifacts} counts={countsForRound(round.artifacts)} t={t} />
        </div>
      )}
      {/* 过程：工具动作明细，折叠 */}
      {round.actions.length > 0 && (
        <details className={css.processBlock}>
          <summary className={css.processHead}>
            {t('coach.timeline.process')} {round.actions.length}
          </summary>
          {round.actions.map((action, i) => (
            <div key={i} className={css.actionRow}>
              <span className={css.actionName}>{action.name}</span>
              {action.path !== null && <span className={css.actionPath} title={action.path}>{action.path}</span>}
              {action.failed && <span className={css.tagError}>{action.retried ? t('coach.timeline.retried') : t('coach.timeline.failed')}</span>}
            </div>
          ))}
        </details>
      )}
    </div>
  )
}

function Stat({ label, value, danger = false }: { label: string; value: number; danger?: boolean }): JSX.Element {  return (
    <div className={css.stat}>
      <b className={danger ? css.danger : undefined}>{value}</b>
      <span>{label}</span>
    </div>
  )
}

function ContextStat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className={css.contextStat}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}
