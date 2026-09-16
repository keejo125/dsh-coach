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
import { CoachDrawer } from './CoachDrawer.tsx'
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

/** 六维明细标签：i18n 双语（完成度 completion），无匹配回退 undefined。 */
function dimLabelOf(t: Translate, id: string): string | undefined {
  switch (id) {
    case 'completion': return t('coach.dim.completion')
    case 'efficiency': return t('coach.dim.efficiency')
    case 'recovery': return t('coach.dim.recovery')
    case 'artifact': return t('coach.dim.artifact')
    case 'delegation': return t('coach.dim.delegation')
    case 'context': return t('coach.dim.context')
    default: return undefined
  }
}

/** 六维明细单维度：中文名 + 进度条 + 数值 + 英文小字（两行结构，避免长标签换行错乱）。 */
function DimItem({ zh, en, score }: { zh: string; en: string; score: number }): JSX.Element {
  const tone = score >= 80 ? css.barGood : (score >= 60 ? css.barMid : css.barPoor)
  return (
    <div className={css.dimItem}>
      <div className={css.dimTop}>
        <span className={css.dimZh}>{zh}</span>
        <span className={css.dimScore}>{score}</span>
      </div>
      <div className={css.barTrack}><div className={`${css.barFill} ${tone}`} style={{ width: `${score}%` }} /></div>
      <div className={css.dimEn}>{en}</div>
    </div>
  )
}

/** 卡片头：标题 + 副标题（汇总信息一句话，引用分析式）。 */
function CardHead({ title, sub }: { title: string; sub?: string | undefined }): JSX.Element {
  return (
    <div className={css.cardHead}>
      <div className={css.cardTitle}>{title}</div>
      {sub !== undefined && sub.length > 0 && <div className={css.cardSub}>{sub}</div>}
    </div>
  )
}

/** 复盘 Tab 根组件。 */
export function CoachView({ sessionId, t }: CoachViewProps): JSX.Element {
  const [report, setReport] = useState<CoachReport | null>(null)
  const [timeline, setTimeline] = useState<CoachTimeline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const [tokenExpanded, setTokenExpanded] = useState(false)
  const [highlightDim, setHighlightDim] = useState<string | null>(null)

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

  /** 点击参考/产物文件 → 右侧抽屉打开正文。 */
  const openFile = (path: string): void => { setDrawerPath(path) }

  /** 短板定位：点击质量分副标题 → 滚动到六维明细对应维度并短暂高亮。 */
  const jumpToDimension = (id: string): void => {
    setHighlightDim(id)
    document.getElementById(`coach-dim-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => setHighlightDim(null), 2200)
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
  const avgDim = Math.round(report.score.dimensions.reduce((sum, d) => sum + d.score, 0) / report.score.dimensions.length)
  const skillCalls = report.skills.reduce((sum, s) => sum + s.calls, 0)
  const skillFailed = report.skills.reduce((sum, s) => sum + s.failed, 0)

  return (
    <div className={css.wrap}>
      <div className={css.header}>
        <div>
          <div className={css.title}>{t('coach.header.subtitle')}</div>
          <div className={css.subtitle}>{sessionId}</div>
        </div>
        <button className={css.refresh} onClick={load}>{t('action.refresh')}</button>
      </div>

      {/* 总分 + 雷达 + 统计（汇总层） */}
      <div className={css.grid3}>
        <section className={css.card}>
          <div className={css.cardHead}>
            <div className={css.cardTitle}>{t('coach.score.title')}</div>
            {lowest !== undefined && (
              <button
                className={css.cardSubLink}
                onClick={() => jumpToDimension(lowest.id)}
                title={t('coach.score.jumpHint')}
              >
                {t('coach.score.sub', { name: dimLabelOf(t, lowest.id)?.split(' ')[0] ?? lowest.id, score: lowest.score })} →
              </button>
            )}
          </div>
          <div className={css.scoreBig}>{report.score.total}</div>
          <span className={css.rating}>{t(`coach.score.rating.${rating}`)}</span>
          {lowest !== undefined && (
            <div className={css.hint}>
              {DIMENSION_LABELS[lowest.id] ?? lowest.id} {lowest.score} · {t('coach.score.noDetail')}
            </div>
          )}
        </section>

        <section className={css.card}>
          <CardHead title={t('coach.radar.title')} sub={t('coach.radar.sub', { avg: avgDim })} />
          <RadarChart dimensions={report.score.dimensions} />
        </section>

        <section className={css.card}>
          <CardHead
            title={t('coach.stats.title')}
            sub={report.skills.length > 0 ? t('coach.stats.sub', { skills: skillCalls, failed: skillFailed }) : undefined}
          />
          <div className={css.stats}>
            <Stat label={t('coach.stats.interactions')} value={scope.userTurns} />
            <Stat label={t('coach.stats.followUps')} value={signals.followUps} />
            <Stat label={t('coach.stats.interventions')} value={signals.interventions} />
            <Stat label={t('coach.stats.corrections')} value={signals.correctionTurns} />
            <Stat label={t('coach.stats.toolCalls')} value={scope.toolCalls} />
            <Stat label={t('coach.stats.failures')} value={scope.failedToolCalls} danger={scope.failedToolCalls > 0} />
            <Stat label={t('coach.stats.compactions')} value={signals.compactions} />
            <Stat label={t('coach.stats.delegations')} value={scope.delegations} />
            <Stat label={t('coach.stats.skills')} value={skillCalls} danger={skillFailed > 0} />
          </div>
        </section>
      </div>

      {/* Token 分布 + 上下文构成（资源使用） */}
      <div className={css.grid2}>
        <section className={css.card}>
          <CardHead
            title={t('coach.token.title')}
            sub={report.token !== null ? t('coach.token.sub', {
              total: report.token.total.toLocaleString(),
              input: report.token.input.toLocaleString(),
              output: report.token.output.toLocaleString(),
              cache: report.token.cache.toLocaleString(),
            }) : undefined}
          />
          {report.token === null
            ? <div className={css.muted}>{t('coach.token.unavailable')}</div>
            : (
              <>
                {/* 汇总：输入构成（上移，总分原则） */}
                {renderTokenProfile(t, report.token.profile)}
                <div className={css.turnList}>
                  {report.token.perTurn
                    .slice(0, tokenExpanded ? report.token.perTurn.length : 5)
                    .map(turn => (
                      <div key={turn.turn} className={css.turnRow}>
                        <span className={css.turnTag}>R{turn.turn}</span>
                        <span className={`${css.turnText} ${turn.text.length === 0 ? css.turnTextEmpty : ''}`} title={turn.text}>
                          {turn.text.length > 0 ? turn.text : t('coach.token.toolTurn')}
                        </span>
                        <div className={css.barTrack}>
                          <div className={`${css.barFill} ${css.barToken}`} style={{ width: `${Math.min(100, (turn.total / report.token!.total) * 100)}%` }} />
                        </div>
                        <span className={css.refViews}>{turn.total.toLocaleString()}</span>
                      </div>
                    ))}
                  {report.token.perTurn.length > 5 && (
                    <button className={css.turnToggle} onClick={() => setTokenExpanded(v => !v)}>
                      {tokenExpanded
                        ? t('coach.token.collapse')
                        : t('coach.token.expand', { n: report.token.perTurn.length })}
                    </button>
                  )}
                </div>
              </>
            )}
        </section>

        <section className={css.card}>
          <CardHead
            title={t('coach.context.title')}
            sub={report.contextProfile !== null ? t('coach.context.sub', {
              user: report.contextProfile.userItems,
              plugin: report.contextProfile.pluginItems,
              delegations: report.contextProfile.delegations,
              inject: report.contextProfile.injectFiles,
            }) : undefined}
          />
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

      {/* 子智能体 + Skill 调用（被调用的实体，关联并排） */}
      <div className={css.grid2}>
        <section className={css.card}>
          <CardHead
            title={t('coach.agents.title')}
            sub={report.agents.length > 0 ? t('coach.agents.sub', { n: report.agents.length }) : undefined}
          />
          {report.agents.length === 0
            ? <div className={css.muted}>{t('coach.agents.empty')}</div>
            : (
              <div className={css.agentList}>
                {report.agents.map(agent => (
                  <div key={agent.sessionId} className={css.agentRow}>
                    <div className={css.agentName}>
                      {agent.label}
                      {agent.task !== null && (
                        <span className={css.agentTask} title={agent.task}>{agent.task}</span>
                      )}
                    </div>
                    <div className={css.agentMeta}>
                      {t('coach.agents.readFiles', { n: agent.readFiles })} · {t('coach.agents.toolCalls', { n: agent.toolCalls })}
                      {' · '}{agent.failedToolCalls > 0 ? t('coach.agents.failures', { n: agent.failedToolCalls }) : t('coach.agents.hasFinal')}
                      {' · '}{t('coach.agents.writtenFiles', { n: agent.writtenFiles })}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </section>

        {report.skills.length > 0 && (
          <section className={css.card}>
            <CardHead
              title={t('coach.skills.title')}
              sub={t('coach.skills.sub', { calls: skillCalls, failed: skillFailed })}
            />
            <div className={css.skillList}>
              {report.skills.map(skill => (
                <div key={skill.name} className={css.skillRow}>
                  <span className={css.skillName} title={skill.name}>{skill.name}</span>
                  <span className={css.skillCalls}>{t('coach.skills.calls')} <b>{skill.calls}</b></span>
                  {skill.failed > 0 && <span className={css.skillFailed}>{t('coach.skills.failed')} {skill.failed}</span>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* 引用分析（全宽：副标题汇总 + 高频/未使用两段明细，可点） */}
      <section className={css.card}>
        <CardHead
          title={t('coach.references.title')}
          sub={report.references.totalFiles > 0 ? t('coach.references.sub', {
            files: report.references.totalFiles,
            views: report.references.totalViews,
            unused: report.references.unusedReferences.length,
          }) : undefined}
        />
        {report.references.totalFiles === 0
          ? <div className={css.muted}>{t('coach.references.empty')}</div>
          : (
            <div className={css.refPanels}>
              <div className={css.refPanel}>
                <div className={css.sectionLabel}>{t('coach.references.top')}</div>
                {report.references.topReferences.length === 0
                  ? <div className={css.muted}>{t('coach.references.empty')}</div>
                  : report.references.topReferences.slice(0, 8).map(ref => (
                    <div key={ref.path} className={css.refRow} onClick={() => openFile(ref.path)} title={t('coach.references.clickHint')}>
                      <span className={css.refPath} title={ref.path}>{ref.path}</span>
                      <div className={css.barTrack}><div className={`${css.barFill} ${css.barGood}`} style={{ width: `${Math.min(100, ref.views * 20)}%` }} /></div>
                      <span className={css.refViews}>×{ref.views}</span>
                    </div>
                  ))}
              </div>
              {report.references.unusedReferences.length > 0 && (
                <div className={css.refPanel}>
                  <div className={css.sectionLabel}>
                    {t('coach.references.unused')}
                    <span className={css.muted}> · {t('coach.references.unusedHint')}</span>
                  </div>
                  {report.references.unusedReferences.slice(0, 6).map(ref => (
                    <div key={ref.path} className={`${css.refRow} ${css.unused}`} onClick={() => openFile(ref.path)} title={t('coach.references.clickHint')}>
                      <span className={css.refPath} title={ref.path}>{ref.path}</span>
                      <span className={css.refViews}>×{ref.views}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
      </section>

      {/* 时间线 */}
      <section className={css.card}>
        <CardHead
          title={t('coach.timeline.title')}
          sub={timeline !== null ? t('coach.timeline.sub', { n: timeline.rounds.length }) : t('coach.timeline.expandHint')}
        />
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
              <RoundDetail round={round} t={t} onSelectFile={openFile} />
            </details>
          ))}
      </section>

      {/* 六维明细 + 产物 */}
      <div className={css.grid2}>
        <section className={css.card}>
          <CardHead
            title={t('coach.dimensions.title')}
            sub={lowest !== undefined ? t('coach.dimensions.sub', { name: dimLabelOf(t, lowest.id)?.split(' ')[0] ?? lowest.id, score: lowest.score }) : undefined}
          />
          <div className={css.dimGrid}>
            {report.score.dimensions.map(dimension => (
              <div
                key={dimension.id}
                id={`coach-dim-${dimension.id}`}
                className={`${css.dimWrap} ${highlightDim === dimension.id ? css.dimHighlight : ''}`}
              >
                <DimItem
                  zh={dimLabelOf(t, dimension.id)?.split(' ')[0] ?? DIMENSION_LABELS[dimension.id] ?? dimension.id}
                  en={DIMENSION_LABELS[dimension.id] ?? dimension.id}
                  score={dimension.score}
                />
                <div className={css.dimHint}>{t(`coach.dim.hint.${dimension.id}`)}</div>
              </div>
            ))}
          </div>
        </section>

        <section className={css.card}>
          <CardHead
            title={t('coach.artifacts.title')}
            sub={report.artifacts.writtenFiles > 0 ? (() => {
              const iterated = report.artifacts.files.filter(file => file.opCount >= 2).length
              return iterated > 0
                ? t('coach.artifacts.subIterated', {
                    created: report.artifacts.createdFiles,
                    updated: report.artifacts.updatedFiles,
                    iterated,
                  })
                : t('coach.artifacts.sub', {
                    created: report.artifacts.createdFiles,
                    updated: report.artifacts.updatedFiles,
                  })
            })() : undefined}
          />
          {report.artifacts.writtenFiles === 0
            ? <div className={css.muted}>{t('coach.artifacts.empty')}</div>
            : <div className={css.artifactScroll}><ArtifactTree files={report.artifacts.files} counts={report.artifacts} t={t} onSelectFile={openFile} showCounts={false} /></div>}
        </section>
      </div>

      {drawerPath !== null ? (
        <CoachDrawer sessionId={sessionId} path={drawerPath} t={t} onClose={() => { setDrawerPath(null) }} />
      ) : null}
    </div>
  )
}

/** 产物清单：计数行 + 文件树（dir 展开、file 带新建/更新徽标）。导出供 SSR 冒烟测试。 */
export function ArtifactTree({
  files,
  counts,
  t,
  onSelectFile,
  showCounts = true,
}: {
  files: readonly CoachArtifactFile[]
  counts: CoachArtifacts
  t: Translate
  onSelectFile?: (path: string) => void
  showCounts?: boolean
}): JSX.Element {
  const nodes = useMemo(() => buildArtifactTree(files), [files])
  const iterated = files.filter(file => file.opCount >= 2).length
  // FileTree 的 onSelectFile 带 node 参数；对外只暴露 path（exactOptional 下始终传函数）
  const handleSelect = (path: string, _node: FileTreeNode): void => { onSelectFile?.(path) }
  return (
    <div className={css.artifactTree}>
      {showCounts && (
        <div className={css.artifactCounts}>
          {t('coach.artifacts.created')} {counts.createdFiles} · {t('coach.artifacts.updated')} {counts.updatedFiles}
          {iterated > 0 ? <> · {t('coach.artifacts.iterated', { n: iterated })}</> : null}
        </div>
      )}
      <FileTree nodes={nodes} t={t} agentsMeta={new Map()} onSelectFile={handleSelect} />
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
export function RoundDetail({ round, t, onSelectFile }: {
  round: CoachTimelineRound
  t: Translate
  onSelectFile?: (path: string) => void
}): JSX.Element {
  // exactOptionalPropertyTypes：产物树 onSelectFile 始终传函数（内部可选调用）
  const handleSelectOutputs = (path: string): void => { onSelectFile?.(path) }
  return (
    <div className={css.roundBody}>
      {/* ① 对话段：与对话框一致的气泡 */}
      <div className={css.chatBlock}>
        <div className={css.chatUser}>{round.userText}</div>
        {round.assistantText !== null && (
          <div className={css.chatAssistant}>{round.assistantText}</div>
        )}
      </div>
      {/* ② 参考段 + ③ 产物段：左右并排（面板宽度下比纵向三段更平衡） */}
      {(round.references.length > 0 || round.artifacts.length > 0) && (
        <div className={css.subPair}>
          {round.references.length > 0 && (
            <div className={css.subBlock}>
              <div className={css.subTitle}>{t('coach.timeline.references')} {round.references.length}</div>
              <FileTree
                nodes={buildFileTree(round.references.map(ref => ({ path: ref.path, viewCount: ref.views })))}
                t={t}
                agentsMeta={new Map()}
                onSelectFile={(path: string, _node: FileTreeNode): void => { onSelectFile?.(path) }}
              />
            </div>
          )}
          {round.artifacts.length > 0 && (
            <div className={css.subBlock}>
              <div className={css.subTitle}>{t('coach.timeline.outputs')} {round.artifacts.length}</div>
              <ArtifactTree files={round.artifacts} counts={countsForRound(round.artifacts)} t={t} onSelectFile={handleSelectOutputs} />
            </div>
          )}
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

/** 输入构成（字符量估算）：系统提示词 / 用户提示词 / 工具调用与结果 / 上下文注入。 */
function renderTokenProfile(
  t: Translate,
  profile: { system: number; user: number; tools: number; plugin: number } | null,
): JSX.Element | null {
  if (profile === null) return null
  const parts = [
    { key: 'system', value: profile.system },
    { key: 'user', value: profile.user },
    { key: 'tools', value: profile.tools },
    { key: 'plugin', value: profile.plugin },
  ]
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  if (total <= 0) return null
  const labelOf = (key: string): string => {
    switch (key) {
      case 'system': return t('coach.token.profile.system')
      case 'user': return t('coach.token.profile.user')
      case 'tools': return t('coach.token.profile.tools')
      default: return t('coach.token.profile.plugin')
    }
  }
  return (
    <div className={css.tokenProfile}>
      <div className={css.tokenProfileTitle}>
        <span>{t('coach.token.profile.title')}</span>
        <span className={css.muted}>{t('coach.token.profile.estimate')}</span>
      </div>
      <div className={css.profileBar}>
        {parts
          .filter(part => part.value > 0)
          .map(part => (
            <div
              key={part.key}
              className={`${css.profileSeg} ${css[`profileSeg_${part.key}`]}`}
              style={{ width: `${(part.value / total) * 100}%` }}
              title={`${labelOf(part.key)} · ${part.value.toLocaleString()}`}
            />
          ))}
      </div>
      <div className={css.profileLegend}>
        {parts
          .filter(part => part.value > 0)
          .map(part => (
            <span key={part.key} className={css.profileLegendItem}>
              <i className={`${css.profileDot} ${css[`profileDot_${part.key}`]}`} />
              {labelOf(part.key)}
              <b>{part.value.toLocaleString()}</b>
            </span>
          ))}
      </div>
    </div>
  )
}
