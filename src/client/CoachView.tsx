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
import { CoachDetailDrawer, type CoachDetailSection } from './CoachDetailDrawer.tsx'
import { FileTree } from './components/FileTree.tsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import type { Translate } from './components/AgentBadge.tsx'
import css from './CoachView.module.css'
import detailCss from './CoachDetailDrawer.module.css'

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
/** 维度解读文案：i18n（coach.dim.hint.*），供雷达 hover。 */
function dimHintOf(t: Translate, id: string): string {
  switch (id) {
    case 'completion': return t('coach.dim.hint.completion')
    case 'efficiency': return t('coach.dim.hint.efficiency')
    case 'recovery': return t('coach.dim.hint.recovery')
    case 'artifact': return t('coach.dim.hint.artifact')
    case 'delegation': return t('coach.dim.hint.delegation')
    default: return t('coach.dim.hint.context')
  }
}

function RadarChart({
  dimensions,
  t,
  highlightId,
}: {
  dimensions: CoachReport['score']['dimensions']
  t: Translate
  highlightId?: string | null
}): JSX.Element {
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
      {dataPoints.map(([x, y], i) => (
        <circle
          key={order[i]}
          cx={x}
          cy={y}
          r={highlightId === order[i] ? 5 : 3}
          className={highlightId === order[i] ? css.radarDotHot : css.radarDot}
        />
      ))}
      {order.map((id, i) => {
        const [x, y] = labelPoint(i)
        const zh = dimLabelOf(t, id)?.split(' ')[0] ?? DIMENSION_LABELS[id] ?? id
        const en = DIMENSION_LABELS[id] ?? id
        return (
          <text key={id} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className={css.radarLabel}>
            <title>{zh} · {dimHintOf(t, id)}</title>
            <tspan x={x} dy="-0.35em" className={css.radarLabelZh}>{zh}</tspan>
            <tspan x={x} dy="1.15em" className={css.radarLabelEn}>{en} {value(id)}</tspan>
          </text>
        )
      })}
    </svg>
  )
}

/** 六维分数条色阶：≥90 绿 / 75~89 主色 / 60~74 灰 / <60 红。 */
function dimBarTone(score: number): string {
  if (score >= 90) return 'barToneHigh'
  if (score >= 75) return 'barToneMid'
  if (score >= 60) return 'barToneLow'
  return 'barTonePoor'
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
  const [detail, setDetail] = useState<CoachDetail | null>(null)
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

  /** 短板定位：点击六维条/副标题 → 滚动到总览卡并高亮对应雷达顶点。 */
  const jumpToDimension = (id: string): void => {
    setHighlightDim(id)
    document.getElementById('coach-radar-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => setHighlightDim(null), 2200)
  }

  /** 统计数字点击 → 滚动定位到对应明细卡。 */
  const scrollToCard = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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

      {/* 顶部总览大卡：三栏均分（两竖线）—— 总评分+雷达 | 六维条 | 本场统计 */}
      <section className={css.card} id="coach-radar-card">
        <div className={css.topOverview3}>
          <div className={css.topCol}>
            <div className={css.scoreLeft}>
              <div className={css.cardTitle}>{t('coach.score.title')}</div>
              <div className={css.scoreBig}>{report.score.total}</div>
              <span className={css.rating}>{t(`coach.score.rating.${rating}`)}</span>
              {lowest !== undefined && (
                <>
                  <button
                    className={css.cardSubLink}
                    onClick={() => jumpToDimension(lowest.id)}
                    title={t('coach.score.jumpHint')}
                  >
                    {t('coach.score.sub', { name: dimLabelOf(t, lowest.id)?.split(' ')[0] ?? lowest.id, score: lowest.score })} →
                  </button>
                  <div className={css.hint}>
                    {DIMENSION_LABELS[lowest.id] ?? lowest.id} {lowest.score} · {t('coach.score.noDetail')}
                  </div>
                </>
              )}
              <div className={css.radarHint}>{t('coach.radar.hoverHint')}</div>
            </div>
          </div>
          <div className={css.topCol}>
            <div className={css.topRadar}>
              <CardHead title={t('coach.radar.title')} sub={t('coach.radar.sub', { avg: avgDim })} />
              <RadarChart dimensions={report.score.dimensions} t={t} highlightId={highlightDim} />
            </div>
            <div className={css.colTitle}>{t('coach.dims.title')}</div>
            <div className={css.scoreBars}>
              {report.score.dimensions
                .slice()
                .sort((a, b) => b.score - a.score)
                .map(dim => (
                  <button
                    key={dim.id}
                    type="button"
                    className={css.dimBarRow}
                    onClick={() => jumpToDimension(dim.id)}
                    title={dimHintOf(t, dim.id)}
                  >
                    <span className={css.dimBarLabel}>{dimLabelOf(t, dim.id)?.split(' ')[0] ?? DIMENSION_LABELS[dim.id] ?? dim.id}</span>
                    <div className={css.dimBarTrack}>
                      <div
                        className={`${css.dimBarFill} ${dimBarTone(dim.score)}`}
                        style={{ width: `${Math.min(100, dim.score)}%` }}
                      />
                    </div>
                    <span className={css.dimBarScore}>{dim.score}</span>
                  </button>
                ))}
            </div>
          </div>
          <div className={css.topCol}>
            <CardHead
              title={t('coach.stats.title')}
              sub={t('coach.stats.subAll')}
            />
            <div className={css.stats}>
              <Stat label={t('coach.stats.interactions')} value={scope.userTurns} onClick={() => scrollToCard('coach-timeline-card')} />
              <Stat label={t('coach.stats.followUps')} value={signals.followUps} onClick={() => scrollToCard('coach-timeline-card')} />
              <Stat label={t('coach.stats.interventions')} value={signals.interventions} onClick={() => scrollToCard('coach-timeline-card')} />
              <Stat label={t('coach.stats.corrections')} value={signals.correctionTurns} onClick={() => scrollToCard('coach-timeline-card')} />
              <Stat label={t('coach.stats.toolCalls')} value={scope.toolCalls} onClick={() => scrollToCard('coach-timeline-card')} />
              <Stat label={t('coach.stats.failures')} value={scope.failedToolCalls} danger={scope.failedToolCalls > 0} onClick={() => scrollToCard('coach-timeline-card')} />
              <Stat label={t('coach.stats.compactions')} value={signals.compactions} onClick={() => scrollToCard('coach-timeline-card')} />
              <Stat label={t('coach.stats.delegations')} value={report.agents.length} onClick={() => scrollToCard('coach-agents-card')} />
              <Stat label={t('coach.stats.skills')} value={skillCalls} danger={skillFailed > 0} onClick={() => scrollToCard('coach-skills-card')} />
              <Stat label={t('coach.stats.tokenTotal')} value={report.token !== null ? report.token.total : 0} onClick={() => setDetail({ kind: 'token' })} />
              <Stat label={t('coach.stats.refFiles')} value={report.references.totalFiles} onClick={() => scrollToCard('coach-refs-card')} />
              <Stat label={t('coach.stats.artifacts')} value={report.artifacts.writtenFiles} onClick={() => scrollToCard('coach-artifacts-card')} />
            </div>
          </div>
        </div>
      </section>

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
                    .slice(0, 5)
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
                    <button className={css.turnToggle} onClick={() => setDetail({ kind: 'token' })}>
                      {t('coach.token.viewAll', { n: report.token.perTurn.length })} →
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
                <ContextStat t={t} label={t('coach.context.userItems')} value={report.contextProfile.userItems} onClick={() => setDetail({ kind: 'context', target: 'user' })} />
                <ContextStat t={t} label={t('coach.context.pluginItems')} value={report.contextProfile.pluginItems} onClick={() => setDetail({ kind: 'context', target: 'plugin' })} />
                <ContextStat t={t} label={t('coach.context.delegations')} value={report.contextProfile.delegations} onClick={() => setDetail({ kind: 'context', target: 'delegation' })} />
                <ContextStat t={t} label={t('coach.context.injectFiles')} value={report.contextProfile.injectFiles} onClick={() => setDetail({ kind: 'context', target: 'inject' })} />
                <ContextStat t={t} label={t('coach.context.finalSegments')} value={report.contextProfile.finalSegments} onClick={() => setDetail({ kind: 'context', target: 'final' })} />
                <ContextStat t={t} label={t('coach.context.processSegments')} value={report.contextProfile.processSegments} onClick={() => setDetail({ kind: 'context', target: 'process' })} />
              </div>
            )}
        </section>
      </div>

      {/* 子智能体 + Skill 调用（被调用的实体，关联并排） */}
      <div className={css.grid2}>
        <section className={css.card} id="coach-agents-card">
          <CardHead
            title={t('coach.agents.title')}
            sub={report.agents.length > 0 ? t('coach.agents.sub', { n: report.agents.length }) : undefined}
          />
          {report.agents.length === 0
            ? <div className={css.muted}>{t('coach.agents.empty')}</div>
            : (
              <div className={css.agentList}>
                {report.agents.map(agent => (
                  <button
                    key={agent.sessionId}
                    className={css.agentRow}
                    type="button"
                    onClick={() => setDetail({ kind: 'agent', sessionId: agent.sessionId })}
                    title={t('coach.agents.viewDetail')}
                  >
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
                  </button>
                ))}
              </div>
            )}
        </section>

        {report.skills.length > 0 && (
          <section className={css.card} id="coach-skills-card">
            <CardHead
              title={t('coach.skills.title')}
              sub={t('coach.skills.sub', { calls: skillCalls, failed: skillFailed })}
            />
            <div className={css.skillList}>
              {report.skills.map(skill => (
                <button
                  key={skill.name}
                  className={css.skillRow}
                  type="button"
                  onClick={() => setDetail({ kind: 'skill', name: skill.name })}
                  title={t('coach.skills.viewDetail')}
                >
                  <span className={css.skillName} title={skill.name}>{skill.name}</span>
                  <span className={css.skillCalls}>{t('coach.skills.calls')} <b>{skill.calls}</b></span>
                  {skill.failed > 0 && <span className={css.skillFailed}>{t('coach.skills.failed')} {skill.failed}</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* 引用分析 + 产物清单（文件侧：读的引用 vs 写的产物） */}
      <div className={css.grid2}>
        <section className={css.card} id="coach-refs-card">
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

        <section className={css.card} id="coach-artifacts-card">
          <CardHead
            title={t('coach.artifacts.title')}
            sub={report.artifacts.writtenFiles > 0 ? (() => {
              const iterated = report.artifacts.files.filter(file => file.opCount >= 2).length
              return iterated > 0
                ? t('coach.artifacts.subIterated', {
                    files: report.artifacts.writtenFiles,
                    created: report.artifacts.createdFiles,
                    updated: report.artifacts.updatedFiles,
                    iterated,
                  })
                : t('coach.artifacts.sub', {
                    files: report.artifacts.writtenFiles,
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
      {/* 交互时间线（页面最底部：全量列出，点击某轮 → 右侧抽屉展示详情） */}
      <section className={css.card} id="coach-timeline-card">
        <CardHead
          title={t('coach.timeline.title')}
          sub={timeline !== null ? t('coach.timeline.sub', { n: timeline.rounds.length }) : t('coach.timeline.expandHint')}
        />
        {timeline === null || timeline.rounds.length === 0
          ? <div className={css.muted}>{t('coach.timeline.noRounds')}</div>
          : (
            <div className={css.timelineFull}>
              {timeline.rounds.map((round, index) => (
                <button
                  key={index}
                  type="button"
                  className={css.roundRow}
                  onClick={() => setDetail({ kind: 'timelineTurn', index })}
                  title={t('coach.timeline.openTurn')}
                >
                  <span className={css.roundNo}>{round.kind === 'initial' ? '★' : `R${index + 1}`}</span>
                  <span className={round.kind === 'initial' ? css.tagInitial : css.tagFollow}>
                    {round.kind === 'initial' ? t('coach.timeline.initial') : t('coach.timeline.followup')}
                  </span>
                  <span className={css.roundText}>{round.userText}</span>
                  {round.signals.intervention && <span className={css.tagWarn}>{t('coach.timeline.intervention')}</span>}
                  {round.signals.correction && <span className={css.tagError}>{t('coach.timeline.correction')}</span>}
                  {round.references.length > 0 && (
                    <span className={css.tagRef}>{t('coach.timeline.refs', { n: round.references.length })}</span>
                  )}
                  {round.artifacts.length > 0 && (
                    <span className={css.tagOk}>{t('coach.timeline.artifact')} {round.artifacts.length}</span>
                  )}
                  <span className={css.roundArrow}>{'›'}</span>
                </button>
              ))}
            </div>
          )}
      </section>

      {detail !== null && report !== null ? (
        detail.kind === 'timeline' || detail.kind === 'timelineTurn'
          ? (
            <TimelineDrawer
              rounds={timeline?.rounds ?? []}
              t={t}
              onSelectFile={openFile}
              onClose={() => { setDetail(null) }}
              {...(detail.kind === 'timelineTurn' ? { focusIndex: detail.index } : {})}
            />
          )
          : (
            <CoachDetailDrawer
              title={detailDrawerTitle(detail, report, t)}
              sections={detailDrawerSections(detail, report, timeline, t)}
              t={t}
              onClose={() => { setDetail(null) }}
              onSelectItem={openFile}
            />
          )
      ) : null}
    </div>
  )
}

/** 下钻目标（右侧抽屉）。 */
type CoachDetail =
  | { kind: 'token' }
  | { kind: 'context'; target: 'user' | 'plugin' | 'delegation' | 'inject' | 'process' | 'final' }
  | { kind: 'contextAll' }
  | { kind: 'agent'; sessionId: string }
  | { kind: 'skill'; name: string }
  | { kind: 'timeline' }
  | { kind: 'timelineTurn'; index: number }

function detailDrawerTitle(detail: CoachDetail, report: CoachReport, t: Translate): string {
  switch (detail.kind) {
    case 'token': return t('coach.token.drawerTitle')
    case 'context': return t(`coach.context.drawer.${detail.target}`)
    case 'contextAll': return t('coach.context.drawerTitle')
    case 'agent': {
      const agent = report.agents.find(candidate => candidate.sessionId === detail.sessionId)
      return t('coach.agents.drawerTitle', { name: agent?.label ?? 'Agent' })
    }
    case 'skill': return t('coach.skills.drawerTitle', { name: detail.name })
    case 'timeline': return t('coach.timeline.drawerTitle')
    case 'timelineTurn': return t('coach.timeline.turnTitle', { n: detail.index + 1 })
  }
}

/** 抽屉内容组装：按下钻目标输出对应分区（bars 可视化 / items 徽章条目）。 */
function detailDrawerSections(
  detail: CoachDetail,
  report: CoachReport,
  timeline: CoachTimeline | null,
  t: Translate,
): CoachDetailSection[] {
  switch (detail.kind) {
    case 'token': return tokenDrawerSections(t, report)
    case 'context': return contextTargetSections(detail.target, report, t)
    case 'contextAll': return contextTargetSections('all', report, t)
    case 'timeline':
    case 'timelineTurn':
      return []
    case 'agent': {
      const agent = report.agents.find(candidate => candidate.sessionId === detail.sessionId)
      if (agent === undefined) return []
      const sections: CoachDetailSection[] = [
        { title: t('coach.agents.drawerTask'), items: [agent.task ?? agent.label] },
        {
          title: t('coach.agents.drawerMetrics'),
          items: [
            `${t('coach.agents.readFiles', { n: agent.readFiles })}`,
            `${t('coach.agents.toolCalls', { n: agent.toolCalls })}`,
            agent.failedToolCalls > 0
              ? { text: t('coach.agents.failures', { n: agent.failedToolCalls }), tone: 'error' }
              : `${t('coach.agents.failures', { n: 0 })}`,
            `${t('coach.agents.writtenFiles', { n: agent.writtenFiles })}`,
          ],
        },
      ]
      if (agent.files.length > 0) {
        sections.push({
          title: t('coach.agents.drawerFiles', { n: agent.files.length }),
          items: agent.files.map(file => ({
            text: `${file.path} · ${file.op === 'create' ? t('coach.timeline.artifact') : t('coach.timeline.updated')}${file.opCount > 1 ? ` ×${file.opCount}` : ''}`,
            tone: file.op === 'create' ? 'ok' : 'warn',
            path: file.path,
          })),
        })
      }
      return sections
    }
    case 'skill': {
      const skill = report.skills.find(candidate => candidate.name === detail.name)
      if (skill === undefined) return []
      const calls = (timeline?.rounds ?? []).flatMap((round, index) =>
        round.actions
          .filter(action => action.name === detail.name)
          .map(action => ({ round: index + 1, failed: action.failed, retried: action.retried, path: action.path })))
      const sections: CoachDetailSection[] = []
      if (calls.length > 0) {
        sections.push({
          title: t('coach.skills.drawerCalls', { n: calls.length }),
          items: calls.map(call => ({
            text: `R${call.round} · ${call.path ?? detail.name}${call.retried ? ` · ${t('coach.timeline.retried')}` : ''}`,
            tone: call.failed ? 'error' : 'ok',
          })),
        })
      }
      sections.push({
        title: t('coach.skills.drawerStats'),
        items: [
          `${t('coach.skills.calls')} ${skill.calls}`,
          skill.failed > 0
            ? { text: `${t('coach.skills.failed')} ${skill.failed}`, tone: 'error' }
            : `${t('coach.skills.failed')} 0`,
        ],
      })
      return sections
    }
    case 'timeline': return []
  }
}

/** Token 抽屉：输入构成 + 全量轮次（bars 占比可视化）。 */
function tokenDrawerSections(t: Translate, report: CoachReport): CoachDetailSection[] {
  const sections: CoachDetailSection[] = []
  const profile = report.token?.profile
  if (profile !== undefined && profile !== null) {
    const total = Math.max(1, profile.user + profile.tools + profile.plugin + profile.system)
    sections.push({
      title: t('coach.token.profile.title'),
      bars: [
        { label: t('coach.token.profile.user'), value: profile.user, total, text: profile.user.toLocaleString() },
        { label: t('coach.token.profile.tools'), value: profile.tools, total, text: profile.tools.toLocaleString() },
        { label: t('coach.token.profile.plugin'), value: profile.plugin, total, text: profile.plugin.toLocaleString() },
        { label: t('coach.token.profile.system'), value: profile.system, total, text: profile.system.toLocaleString() },
      ],
    })
  }
  if (report.token !== null) {
    const grand = Math.max(1, report.token.perTurn.reduce((sum, turn) => sum + turn.total, 0))
    sections.push({
      title: t('coach.token.allTurnsTitle', { n: report.token.perTurn.length }),
      bars: report.token.perTurn.map(turn => ({
        label: `R${turn.turn}`,
        value: turn.total,
        total: grand,
        text: `${turn.text.length > 0 ? turn.text : t('coach.token.toolTurn')} · ${turn.total.toLocaleString()}`,
      })),
    })
  }
  return sections
}

/** 上下文抽屉：点击具体数字 → 单节；「查看明细」→ 全量（all）。 */
function contextTargetSections(
  target: 'user' | 'plugin' | 'delegation' | 'inject' | 'process' | 'final' | 'all',
  report: CoachReport,
  t: Translate,
): CoachDetailSection[] {
  const profile = report.contextProfile
  if (profile === null) return []
  const user: CoachDetailSection = {
    title: t('coach.context.drawerCount', { n: profile.userItems }),
    items: profile.userTexts.length > 0 ? profile.userTexts : [t('coach.drawer.noDetail')],
  }
  const plugin: CoachDetailSection = {
    title: t('coach.context.drawerCount', { n: profile.pluginItems }),
    items: profile.pluginSummaries.length > 0 ? profile.pluginSummaries : [t('coach.drawer.noDetail')],
  }
  const delegation: CoachDetailSection = {
    title: t('coach.context.drawerCount', { n: profile.delegationTexts.length > 0 ? profile.delegationTexts.length : report.agents.length }),
    items: profile.delegationTexts.length > 0
      ? profile.delegationTexts
      : report.agents.length > 0
        ? report.agents.map(agent => agent.task !== null ? agent.task : agent.label)
        : [t('coach.drawer.noDetail')],
  }
  const inject: CoachDetailSection = {
    title: t('coach.context.drawerCount', { n: profile.injectPaths.length }),
    items: profile.injectPaths.length > 0 ? profile.injectPaths : [t('coach.drawer.noDetail')],
  }
  const counted: CoachDetailSection = {
    title: t('coach.context.drawerCountOnly'),
    items: [t('coach.context.drawerCountOnlyHint')],
  }
  switch (target) {
    case 'user': return [user]
    case 'plugin': return [plugin]
    case 'delegation': return [delegation]
    case 'inject': return [inject]
    case 'process': return [counted]
    case 'final': return [counted]
    case 'all':
      return [user, plugin, delegation, inject].filter(section => (section.items?.length ?? 0) > 0)
  }
}

/** 时间线抽屉：全量轮次列表，点击展开三段式明细（对话/参考/产物 + 过程）。 */
function TimelineDrawer({
  rounds,
  t,
  onSelectFile,
  onClose,
  focusIndex,
}: {
  rounds: readonly CoachTimelineRound[]
  t: Translate
  onSelectFile: (path: string) => void
  onClose: () => void
  focusIndex?: number
}): JSX.Element {
  const focused = focusIndex === undefined || focusIndex < 0 || focusIndex >= rounds.length ? null : rounds[focusIndex]!
  return (
    <div className={detailCss.mask} onClick={onClose}>
      <div className={detailCss.panel} onClick={event => event.stopPropagation()}>
        <div className={detailCss.header}>
          <div className={detailCss.headerMain}>
            <span className={detailCss.title}>
              {focused !== null
                ? t('coach.timeline.turnTitle', { n: focusIndex! + 1 })
                : t('coach.timeline.drawerTitle', { n: rounds.length })}
            </span>
          </div>
          <button className={detailCss.iconButton} onClick={onClose} aria-label={t('coach.drawer.close')}>
            <IconCloseOutline16 />
          </button>
        </div>
        <div className={detailCss.body}>
          {rounds.length === 0
            ? <div className={detailCss.hint}>{t('coach.timeline.noRounds')}</div>
            : focused !== null
              ? <RoundDetail round={focused} t={t} onSelectFile={onSelectFile} />
              : rounds.map((round, index) => (
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
                <RoundDetail round={round} t={t} onSelectFile={onSelectFile} />
              </details>
            ))}
        </div>
      </div>
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

function Stat({ label, value, danger = false, onClick }: {
  label: string
  value: number
  danger?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      className={css.stat}
      onClick={onClick}
      type="button"
      {...(onClick !== undefined ? {} : { disabled: true })}
    >
      <b className={danger ? css.danger : undefined}>{value}</b>
      <span>{label}</span>
    </button>
  )
}

function ContextStat({ label, value, onClick, t }: {
  label: string
  value: number
  onClick?: () => void
  t: Translate
}): JSX.Element {
  const disabled = value === 0
  return (
    <button
      className={css.contextStat}
      onClick={disabled ? undefined : onClick}
      type="button"
      disabled={disabled}
      title={disabled ? t('coach.context.zeroHint') : t('coach.context.clickHint')}
    >
      <b>{value}</b>
      <span>{label}</span>
      {!disabled && <span className={css.contextStatArrow}>{'›'}</span>}
    </button>
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
