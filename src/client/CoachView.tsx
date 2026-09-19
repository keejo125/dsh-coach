/**
 * 复盘 Tab 根组件（v0.2b）：消费 /coach/api 把一场会话变成可追溯的复盘报告。
 *
 * 区块：总分卡（评级+最低分提示）· 六维雷达 · 本场统计 · 交互时间线（逐轮可展开）·
 * 子智能体 · 引用分析（高频 Top + 未使用）· Token 分布（可降级）· 上下文构成 ·
 * 六维明细 · 产物清单。数据一次拉取（report + timeline 并行），刷新即重算。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CoachAgentSummary, CoachArtifactFile, CoachArtifacts, CoachReport, CoachSkillStats, CoachTimeline, CoachTimelineRound, FileTreeNode } from '../shared/types.ts'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CoachApiError,
  fetchCoachReport,
  fetchCoachSuggestions,
  fetchCoachTimeline,
} from './coach-client.ts'
import type { CoachSuggestions, CoachSuggestionKind } from '../shared/types.ts'
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
  unused?: boolean
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
      if (file.unused !== undefined) node.unused = file.unused
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
        return (
          <text key={id} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className={css.radarLabel}>
            <title>{zh} · {dimHintOf(t, id)}</title>
            <tspan x={x} dy="-0.35em" className={css.radarLabelZh}>{zh}</tspan>
            <tspan x={x} dy="1.1em" className={css.radarLabelVal}>{value(id)}</tspan>
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
  const [suggestions, setSuggestions] = useState<CoachSuggestions | null>(null)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const [detail, setDetail] = useState<CoachDetail | null>(null)
  /** 抽屉焦点管理：打开时记录触发元素，关闭后焦点归位（WCAG 2.4.7）。 */
  const lastFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (detail !== null || drawerPath !== null) {
      lastFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    } else if (lastFocusRef.current !== null) {
      lastFocusRef.current.focus()
      lastFocusRef.current = null
    }
  }, [detail, drawerPath])
  /** 每轮分布柱联动：高亮下方时间线对应轮（R{n}），4s 后自动消退。 */
  const [highlightTurn, setHighlightTurn] = useState<number | null>(null)
  /** 每轮分布柱 hover：显示该轮 Token 量 tooltip。 */
  const [hoverTurn, setHoverTurn] = useState<number | null>(null)
  /** hover 柱中心在容器内的横向百分比（浮层锚点）。 */
  const [hoverLeft, setHoverLeft] = useState<number | null>(null)
  /** hover 柱顶在容器内的 bottom 偏移（px），浮层紧贴柱顶。 */
  const [hoverBottom, setHoverBottom] = useState<number | null>(null)
  /** 柱图 roving tabindex：左右键切换聚焦柱，减少 Tab 位。 */
  const [rovingTurn, setRovingTurn] = useState<number | null>(null)
  const turnBarsRef = useRef<HTMLDivElement | null>(null)
  const turnBarRefs = useRef<Array<HTMLButtonElement | null>>([])
  const handleTurnBarsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    if (report === null || report.token === null) return
    const turns = report.token.perTurn
    if (turns.length === 0) return
    const current = rovingTurn ?? turns[0]!.turn
    const index = turns.findIndex(turn => turn.turn === current)
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const next = (index + delta + turns.length) % turns.length
    setRovingTurn(turns[next]!.turn)
    turnBarRefs.current[next]?.focus()
  }
  useEffect(() => {
    if (highlightTurn === null) return
    const timer = setTimeout(() => setHighlightTurn(null), 4000)
    return () => clearTimeout(timer)
  }, [highlightTurn])
  /** 点击分布柱 → 滚动到时间线卡并高亮 R{turn} 行。 */
  const jumpToTimelineTurn = (turn: number): void => {
    setHighlightTurn(turn)
    const card = document.getElementById('coach-timeline-card')
    if (card === null) return
    const rows = card.querySelectorAll<HTMLButtonElement>('[class*=roundRow]')
    for (const row of rows) {
      const no = row.querySelector('[class*=roundNo]')
      if (no !== null && no.textContent === `R${turn}`) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return
      }
    }
    card.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const [agentsZeroOpen, setAgentsZeroOpen] = useState(false)
  const [highlightDim, setHighlightDim] = useState<string | null>(null)

  const load = (): void => {
    setLoading(true)
    setError(null)
    void Promise.all([
      fetchCoachReport(sessionId).then(setReport),
      fetchCoachTimeline(sessionId).then(setTimeline),
      fetchCoachSuggestions(sessionId).then(setSuggestions).catch(() => { setSuggestions(null) }),
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
  const skillToolStatsMap = skillToolStats(timeline, report.skills)
  const skillCalls = [...skillToolStatsMap.values()].reduce((sum, s) => sum + s.calls, 0)
  const skillFailed = [...skillToolStatsMap.values()].reduce((sum, s) => sum + s.failed, 0)
  // 抽屉打开时禁用触发行原生 title，避免残留气泡浮在 dialog 之上（P2-7）
  const detailActive = detail !== null || drawerPath !== null

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
            </div>
          </div>
          <div className={css.topCol}>
            <div className={css.topRadar}>
              <CardHead title={t('coach.radar.title')} sub={t('coach.radar.sub', { avg: avgDim })} />
              <RadarChart dimensions={report.score.dimensions} t={t} highlightId={highlightDim} />
              <div className={css.radarHint}>{t('coach.radar.hoverHint')}</div>
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

      {/* P3 复盘建议（知识/规则/偏好提炼；点击展开；采纳功能后续版本开放） */}
      <section className={css.card} id="coach-suggestions-card">
        <button
          type="button"
          className={css.suggestToggle}
          onClick={() => setSuggestionsOpen(open => !open)}
          aria-expanded={suggestionsOpen}
        >
          <span className={css.suggestToggleTitle}>{t('coach.suggestions.title')}</span>
          {suggestions !== null && (
            <span className={css.suggestCount}>{t('coach.suggestions.count', { n: suggestions.items.length })}</span>
          )}
          <span className={`${css.suggestChevron}${suggestionsOpen ? ` ${css.suggestChevronOpen}` : ''}`}>›</span>
        </button>
        {suggestionsOpen && (
          <div className={css.suggestBody}>
            <div className={css.suggestSub}>{t('coach.suggestions.sub')}</div>
            {suggestions !== null && suggestions.targets.length > 0 && (
              <div className={css.memTargets}>
                {suggestions.targets.map(target => (
                  <span key={target.path} className={target.exists ? css.memTarget : css.memTargetNew}>
                    {target.kind === 'global' ? t('coach.suggestions.global') : t('coach.suggestions.workspace')}
                    {' · '}
                    <code title={target.path}>{fileNameOf(target.path)}</code>
                    {target.exists ? ` ✓ ${t('coach.suggestions.exists')}` : ` · ${t('coach.suggestions.willCreate')}`}
                  </span>
                ))}
              </div>
            )}
            {suggestions === null
              ? <div className={css.muted}>{t('coach.suggestions.unavailable')}</div>
              : suggestions.items.length === 0
                ? <div className={css.muted}>{t('coach.suggestions.empty')}</div>
                : (
                  <div className={css.suggestList}>
                    {suggestions.items.map(suggestion => (
                      <div key={suggestion.id} className={css.suggestRow}>
                        <span className={suggestKindClass(suggestion.kind, css)}>
                          {suggestKindLabel(suggestion.kind, t)}
                        </span>
                        <div className={css.suggestMain}>
                          <div className={css.suggestTitle}>{suggestion.title}</div>
                          <div className={css.suggestContent}>{suggestion.content}</div>
                          <div className={css.suggestBasis}>
                            {t('coach.suggestions.basis')} {suggestion.basis}
                            {' · '}
                            <code title={suggestion.target.path}>{fileNameOf(suggestion.target.path)}</code>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
          </div>
      )}
      </section>
      {/* Token 与上下文（合并卡：总量汇总 + 每轮分布 + 输入构成双口径） */}
      <section className={css.card} id="coach-token-card">
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
              {/* 汇总：每轮 Token 分布（全量柱图，hover 看量，点击联动下方时间线对应轮） */}
              {report.token.perTurn.length > 0 && (
                <div className={css.turnBarsWrap}>
                  <div className={css.turnBarsHead}>
                    <span className={css.turnBarsTitle}>{t('coach.token.perTurn.title')}</span>
                  </div>
                  <div className={css.turnBarsHint}>{t('coach.token.perTurn.hint')}</div>
                  <div
                    ref={turnBarsRef}
                    className={css.turnBars}
                    role="group"
                    aria-label={t('coach.token.perTurn.title')}
                    tabIndex={0}
                    onKeyDown={handleTurnBarsKeyDown}
                  >
                    {(() => {
                      const turns = report.token.perTurn
                      const maxTurn = Math.max(1, ...turns.map(turn => turn.total))
                      return turns.map((turn, index) => (
                        <button
                          key={turn.turn}
                          ref={el => { turnBarRefs.current[index] = el }}
                          type="button"
                          tabIndex={rovingTurn === turn.turn ? 0 : -1}
                          className={`${css.turnBar} ${highlightTurn === turn.turn ? css.turnBarActive : ''}`}
                          style={{ height: `${Math.max(4, (turn.total / maxTurn) * 100)}%` }}
                          onClick={() => jumpToTimelineTurn(turn.turn)}
                          onMouseEnter={(event) => {
                            const wrap = turnBarsRef.current
                            if (wrap !== null) {
                              const center = event.currentTarget.offsetLeft + event.currentTarget.offsetWidth / 2
                              setHoverLeft(Math.min(90, Math.max(10, (center / wrap.clientWidth) * 100)))
                            }
                            setHoverBottom(event.currentTarget.offsetHeight + 6)
                            setHoverTurn(turn.turn)
                          }}
                          onMouseLeave={() => { setHoverTurn(null); setHoverLeft(null); setHoverBottom(null) }}
                          onFocus={() => { setRovingTurn(turn.turn); setHoverTurn(turn.turn); setHoverLeft(null); setHoverBottom(null) }}
                          onBlur={() => { setHoverTurn(null); setHoverLeft(null); setHoverBottom(null) }}
                          aria-label={`R${turn.turn} ${turn.total.toLocaleString()} ${t('coach.token.unit')}`}
                        />
                      ))
                    })()}
                    {hoverTurn !== null && hoverLeft !== null && hoverBottom !== null && report.token !== null && (() => {
                      const tn = report.token.perTurn.find(turn => turn.turn === hoverTurn)
                      if (tn === undefined) return null
                      const label = tn.text.length > 0 ? tn.text : t('coach.token.toolTurn')
                      return (
                        <div className={css.turnTip} style={{ left: `${hoverLeft}%`, bottom: `${hoverBottom}px` }} role="status">
                          <span className={css.turnTipRound}>R{tn.turn}</span>
                          <span className={css.turnTipTokens}>{tn.total.toLocaleString()} {t('coach.token.unit')}</span>
                          <span className={css.turnTipText}>{label}</span>
                        </div>
                      )
                    })()}
                  </div>
                  <div className={css.turnBarsAxis}>
                    <span>R1</span>
                    <span>R{report.token.perTurn.length}</span>
                  </div>
                </div>
              )}
              {/* 输入构成（字符量 + 次数 双条，同色） */}
              {renderTokenProfile(
                t,
                report.token.profile,
                report.contextProfile !== null
                  ? {
                      system: report.contextProfile.systemItems,
                      user: report.contextProfile.userItems,
                      delegation: report.contextProfile.delegations,
                      tools: scope.toolCalls,
                      plugin: report.contextProfile.pluginItems,
                    }
                  : null,
                (key) => {
                  switch (key) {
                    case 'user': setDetail({ kind: 'context', target: 'user' }); break
                    case 'delegation': setDetail({ kind: 'context', target: 'delegation' }); break
                    case 'tools': setDetail({ kind: 'context', target: 'tools' }); break
                    case 'plugin': setDetail({ kind: 'context', target: 'plugin' }); break
                    default: break
                  }
                },
              )}
              {/* 输出结构（副信息） */}
              {report.contextProfile !== null && (
                <div className={css.outputMeta}>
                  {t('coach.token.outputMeta', {
                    final: report.contextProfile.finalSegments,
                    process: report.contextProfile.processSegments,
                    inject: report.contextProfile.injectFiles,
                  })}
                </div>
              )}
            </>
          )}
      </section>

      {/* 子智能体 + Skill 调用（被调用的实体，关联并排） */}
      <div className={css.grid2}>
        <section className={css.card} id="coach-agents-card">
          <CardHead
            title={t('coach.agents.title')}
            sub={report.agents.length > 0
              ? t('coach.agents.sub', { total: report.agents.length, readable: report.agents.filter(agent => agent.readable).length })
              : undefined}
          />
          {report.agents.length === 0
            ? <div className={css.muted}>{t('coach.agents.empty')}</div>
            : (
              <div className={css.agentList}>
                {(() => {
                  const renderAgentRow = (agent: CoachAgentSummary): JSX.Element => (
                    <button
                      key={agent.sessionId}
                      className={agent.readable ? css.agentRow : css.agentRowUnreadable}
                      type="button"
                      onClick={agent.readable ? () => setDetail({ kind: 'agent', sessionId: agent.sessionId }) : undefined}
                      title={agent.readable
                        ? (detailActive ? undefined : t('coach.agents.viewDetail'))
                        : t('coach.agents.unreadable')}
                      disabled={!agent.readable}
                    >
                      <div className={css.agentName}>
                        {agent.label}
                        {agent.task !== null && (
                          <span className={css.agentTask} title={detailActive ? undefined : agent.task}>{agent.task}</span>
                        )}
                        {!agent.readable && (
                          <span className={css.agentUnreadableTag}>{t('coach.agents.unreadable')}</span>
                        )}
                      </div>
                      {agent.readable && (
                        <div className={css.agentMeta}>
                          {t('coach.agents.readFiles', { n: agent.readFiles })} · {t('coach.agents.toolCalls', { n: agent.toolCalls })}
                          {' · '}{agent.failedToolCalls > 0 ? t('coach.agents.failures', { n: agent.failedToolCalls }) : t('coach.agents.hasFinal')}
                          {' · '}{t('coach.agents.writtenFiles', { n: agent.writtenFiles })}
                        </div>
                      )}
                    </button>
                  )
                  // 全零卡降噪（P2-10）：读/工具/产物均 0 的子代理折叠为一行，点击展开
                  const zero = report.agents.filter(agent =>
                    agent.readable && agent.readFiles === 0 && agent.toolCalls === 0 && agent.writtenFiles === 0)
                  const actives = report.agents.filter(agent => !zero.includes(agent))
                  return (
                    <>
                      {actives.map(renderAgentRow)}
                      {zero.length > 0 && (
                        <button
                          type="button"
                          className={css.agentZeroRow}
                          onClick={() => setAgentsZeroOpen(open => !open)}
                          aria-expanded={agentsZeroOpen}
                        >
                          <span>{t('coach.agents.zeroRow', { n: zero.length })}</span>
                          <span className={`${css.suggestChevron}${agentsZeroOpen ? ` ${css.suggestChevronOpen}` : ''}`}>›</span>
                        </button>
                      )}
                      {agentsZeroOpen && zero.map(renderAgentRow)}
                    </>
                  )
                })()}
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
              {report.skills.map(skill => {
                const stats = skillToolStatsMap.get(skill.name) ?? { calls: 0, failed: 0 }
                return (
                <button
                  key={skill.name}
                  className={css.skillRow}
                  type="button"
                  onClick={() => setDetail({ kind: 'skill', name: skill.name })}
                  title={t('coach.skills.viewDetail')}
                >
                  <span className={css.skillName} title={skill.name}>{skill.name}</span>
                  <span className={css.skillCalls}>{t('coach.skills.calls')} {stats.calls}</span>
                  <span className={css.skillOk}>{t('coach.skills.ok')} {Math.max(0, stats.calls - stats.failed)}</span>
                  {stats.failed > 0 && <span className={css.skillFailed}>{t('coach.skills.failed')} {stats.failed}</span>}
                </button>
                )
              })}
            </div>
            <SkillRecentCalls timeline={timeline} skills={report.skills} t={t} onOpen={name => setDetail({ kind: 'skill', name })} />
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
              <div className={css.artifactScroll}>
                <FileTree
                  nodes={buildFileTree(
                    report.references.topReferences.map(ref => ({
                      path: ref.path,
                      viewCount: ref.views,
                      unused: report.references.unusedReferences.some(candidate => candidate.path === ref.path),
                    })),
                  )}
                  t={t}
                  agentsMeta={new Map()}
                  onSelectFile={(path) => openFile(path)}
                />
              </div>
            )}
        </section>

        <section className={css.card} id="coach-artifacts-card">
          <CardHead
            title={t('coach.artifacts.title')}
            sub={report.artifacts.writtenFiles > 0 ? (() => {
              const files = report.artifacts.files
              // 口径自洽：新建=创建后未再改；更新=其余（含迭代）；新建+更新=总数
              const created = files.filter(file => file.op === 'create' && file.opCount < 2).length
              const iterated = files.filter(file => file.opCount >= 2).length
              const updated = files.length - created
              return iterated > 0
                ? t('coach.artifacts.subIterated', {
                    files: files.length,
                    created,
                    updated,
                    iterated,
                  })
                : t('coach.artifacts.sub', {
                    files: files.length,
                    created,
                    updated,
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
          sub={timeline !== null
            ? t('coach.timeline.sub', {
                n: timeline.rounds.length,
                total: report.token?.perTurn.length ?? timeline.rounds.length,
                tool: report.token?.perTurn.filter(turn => turn.text.length === 0).length ?? 0,
              })
            : t('coach.timeline.expandHint')}
        />
        {timeline === null || timeline.rounds.length === 0
          ? <div className={css.muted}>{t('coach.timeline.noRounds')}</div>
          : (
            <div className={css.timelineFull}>
              {timeline.rounds.map((round, index) => {
                const roundNo = round.kind === 'initial' ? 'R1' : `R${index + 1}`
                return (
                  <button
                    key={index}
                    type="button"
                    className={`${css.roundRow} ${highlightTurn !== null && roundNo === `R${highlightTurn}` ? css.roundRowHighlight : ''}`}
                    onClick={() => setDetail({ kind: 'timelineTurn', index })}
                    title={t('coach.timeline.openTurn')}
                  >
                    <span className={css.roundNo}>{roundNo}</span>
                    {round.kind === 'initial' ? (
                      <span className={css.tagInitial}>{t('coach.timeline.initial')}</span>
                    ) : round.signals?.correction ? (
                      <span className={css.tagError}>{t('coach.timeline.correction')}</span>
                    ) : round.signals?.intervention ? (
                      <span className={css.tagIntervention}>{t('coach.timeline.intervention')}</span>
                    ) : (
                      <span className={css.tagFollow}>{t('coach.timeline.followup')}</span>
                    )}
                    <span className={css.roundText}>{round.userText}</span>
                    {roundTagsOf(round, t, 3)}
                    <span className={css.roundArrow}>{'›'}</span>
                  </button>
                )
              })}
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

/** Skill 卡最近调用：从时间线提取各 skill 最近 3 次调用（填充内容 + 可下钻）。 */
function SkillRecentCalls({ timeline, skills, t, onOpen }: {
  timeline: CoachTimeline | null
  skills: readonly CoachSkillStats[]
  t: Translate
  onOpen: (name: string) => void
}): JSX.Element | null {
  const names = new Set(skills.map(skill => skill.name))
  const calls = (timeline?.rounds ?? [])
    .flatMap((round, index) =>
      round.actions
        .filter(action => names.has(action.name))
        .map(action => ({ round: index + 1, name: action.name, path: action.path, failed: action.failed })))
    .slice(-3)
    .reverse()
  return (
    <div className={css.skillRecent}>
      <div className={css.sectionLabel}>{t('coach.skills.recent')}</div>
      {calls.length === 0
        ? <div className={css.skillRecentEmpty}>{t('coach.skills.recentEmpty')}</div>
        : (
          <div className={css.skillRecentList}>
            {calls.map((call, i) => (
              <button key={i} type="button" className={css.skillRecentRow} onClick={() => onOpen(call.name)}>
                <span className={css.skillRecentNo}>R{call.round}</span>
                <span className={css.skillRecentName}>{call.name}</span>
                <span className={css.skillRecentPath} title={call.path ?? undefined}>{call.path}</span>
                {call.failed
                  ? <span className={css.tagError}>{t('coach.skills.failed')}</span>
                  : <span className={css.tagOk}>{t('coach.skills.ok')}</span>}
              </button>
            ))}
          </div>
        )}
    </div>
  )
}

/** 下钻目标（右侧抽屉）。 */
type CoachDetail =
  | { kind: 'token' }
  | { kind: 'context'; target: 'user' | 'plugin' | 'delegation' | 'inject' | 'process' | 'final' | 'tools' }
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
    case 'context': return contextTargetSections(detail.target, report, timeline, t)
    case 'contextAll': return contextTargetSections('all', report, timeline, t)
    case 'timeline':
    case 'timelineTurn':
      return []
    case 'agent': {
      const agent = report.agents.find(candidate => candidate.sessionId === detail.sessionId)
      if (agent === undefined) return []
      const sections: CoachDetailSection[] = [
        { title: t('coach.agents.drawerTask'), items: [{ text: agent.task ?? agent.label, noIndex: true }] },
        {
          title: t('coach.agents.drawerMetrics'),
          items: [
            { text: `${t('coach.agents.readFiles', { n: agent.readFiles })}`, noIndex: true },
            { text: `${t('coach.agents.toolCalls', { n: agent.toolCalls })}`, noIndex: true },
            agent.failedToolCalls > 0
              ? { text: t('coach.agents.failures', { n: agent.failedToolCalls }), tone: 'error', noIndex: true }
              : { text: `${t('coach.agents.failures', { n: 0 })}`, noIndex: true },
            { text: `${t('coach.agents.writtenFiles', { n: agent.writtenFiles })}`, noIndex: true },
          ],
        },
      ]
      if (agent.files.length > 0) {
        sections.push({
          title: t('coach.agents.drawerFiles', { n: agent.files.length }),
          items: agent.files.map(file => ({
            text: `${file.path}${file.opCount > 1 ? ` ×${file.opCount}` : ''}`,
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
      const sections: CoachDetailSection[] = [
        {
          title: t('coach.skills.drawerStats'),
          items: [
            { text: `${t('coach.skills.calls')} ${skill.calls}`, noIndex: true },
            { text: `${t('coach.skills.ok')} ${Math.max(0, skill.calls - skill.failed)}`, tone: 'ok', noIndex: true },
            skill.failed > 0
              ? { text: `${t('coach.skills.failed')} ${skill.failed}`, tone: 'error', noIndex: true }
              : { text: `${t('coach.skills.failed')} 0`, noIndex: true },
          ],
        },
      ]
      if (calls.length > 0) {
        sections.push({
          title: t('coach.skills.drawerCalls', { n: calls.length }),
          items: calls.map(call => ({
            text: `R${call.round} · ${(timeline?.rounds[call.round - 1]?.userText ?? call.path ?? detail.name).slice(0, 60)}${call.retried ? ` · ${t('coach.timeline.retried')}` : ''}`,
            tone: call.failed ? 'error' : 'ok',
          })),
        })
      }
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
  target: 'user' | 'plugin' | 'delegation' | 'inject' | 'process' | 'final' | 'tools' | 'all',
  report: CoachReport,
  timeline: CoachTimeline | null,
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
  const readableCount = report.agents.filter(agent => agent.readable).length
  const delegation: CoachDetailSection = {
    title: `${t('coach.context.drawerCount', { n: profile.delegationTexts.length > 0 ? profile.delegationTexts.length : report.agents.length })} · ${t('coach.agents.derived', { total: report.agents.length, readable: readableCount })}`,
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
  const toolSections: CoachDetailSection[] = timeline !== null
    ? timeline.rounds
        .map((round, index) => {
          if (round.actions.length === 0) return null
          return {
            title: `${index === 0 ? 'R1' : `R${index + 1}`} · ${t('coach.context.drawerToolsCount', { n: round.actions.length })}`,
            items: round.actions.map(action => {
              const failed = action.failed ? ` · ${t('coach.context.drawerToolsFailed')}` : ''
              const path = action.path !== null ? ` · ${action.path}` : ''
              return `${action.name}${path}${failed}`
            }),
          } as CoachDetailSection
        })
        .filter((section): section is CoachDetailSection => section !== null)
    : []
  const toolTotal = toolSections.reduce((sum, section) => sum + (section.items?.length ?? 0), 0)
  const tools: CoachDetailSection = {
    title: t('coach.context.drawerToolsTitle', { n: toolTotal }),
    items: toolSections.length > 0
      ? toolSections.flatMap(section => section.items ?? [])
      : [t('coach.drawer.noDetail')],
  }
  switch (target) {
    case 'user': return [user]
    case 'plugin': return [plugin]
    case 'delegation': return [delegation]
    case 'inject': return [inject]
    case 'tools': return toolSections.length > 0 ? toolSections : [tools]
    case 'process': return [counted]
    case 'final': return [counted]
    case 'all':
      return [user, plugin, delegation, inject].filter(section => (section.items?.length ?? 0) > 0)
  }
}

/** P3 建议类型徽章类名。 */
function suggestKindClass(kind: CoachSuggestionKind, css: Record<string, string>): string {
  switch (kind) {
    case 'preference': return css.suggestKindPreference ?? ''
    case 'rule': return css.suggestKindRule ?? ''
    case 'knowledge': return css.suggestKindKnowledge ?? ''
  }
}

/** P3 建议类型双语标签。 */
function suggestKindLabel(kind: CoachSuggestionKind, t: Translate): string {
  switch (kind) {
    case 'preference': return t('coach.suggestions.kind.preference')
    case 'rule': return t('coach.suggestions.kind.rule')
    case 'knowledge': return t('coach.suggestions.kind.knowledge')
  }
}


/** 文件名（末段），完整路径放 title/aria（P2-9）。 */
function fileNameOf(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** Skill 工具级调用口径（P1-1）：与「最近调用」列表同源（时间线 actions），
 *  头部计数与行内计数、最近调用列表三者自洽。 */
function skillToolStats(timeline: CoachTimeline | null, skills: readonly CoachSkillStats[]): Map<string, { calls: number; failed: number }> {
  const names = new Set(skills.map(skill => skill.name))
  const stats = new Map<string, { calls: number; failed: number }>()
  for (const round of timeline?.rounds ?? []) {
    for (const action of round.actions) {
      if (!names.has(action.name)) continue
      const entry = stats.get(action.name) ?? { calls: 0, failed: 0 }
      entry.calls += 1
      if (action.failed) entry.failed += 1
      stats.set(action.name, entry)
    }
  }
  return stats
}

/** 时间线轮次标签（干预/纠错/引用/产物），最多显示 limit 个，超出折叠为 +N。 */
function roundTagsOf(round: CoachTimelineRound, t: Translate, limit: number): JSX.Element[] {
  const tags: JSX.Element[] = []
  if (round.references.length > 0) {
    tags.push(<span key="refs" className={css.tagRef}>{t('coach.timeline.refs', { n: round.references.length })}</span>)
  }
  if (round.artifacts.length > 0) {
    tags.push(<span key="artifacts" className={css.tagOk}>{t('coach.timeline.artifact')} {round.artifacts.length}</span>)
  }
  if (tags.length <= limit) return tags
  const extra = tags.length - limit
  return [
    ...tags.slice(0, limit),
    <span key="more" className={css.tagMore}>+{extra}</span>,
  ]
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
  // Esc 关闭 + 打开时焦点移入面板（WCAG 2.4.7）
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    window.setTimeout(() => { panelRef.current?.focus() }, 0)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  return (
    <div className={detailCss.mask} onClick={onClose}>
      <div
        ref={panelRef}
        className={detailCss.panel}
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={focused !== null
          ? t('coach.timeline.turnTitle', { n: focusIndex! + 1 })
          : t('coach.timeline.drawerTitle', { n: rounds.length })}
      >
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
                  {round.kind === 'initial' ? (
                    <span className={css.tagInitial}>{t('coach.timeline.initial')}</span>
                  ) : round.signals?.correction ? (
                    <span className={css.tagError}>{t('coach.timeline.correction')}</span>
                  ) : round.signals?.intervention ? (
                    <span className={css.tagIntervention}>{t('coach.timeline.intervention')}</span>
                  ) : (
                    <span className={css.tagFollow}>{t('coach.timeline.followup')}</span>
                  )}
                  <span className={css.roundText}>{round.userText}</span>
                  {roundTagsOf(round, t, 3)}
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
  void counts // 计数改用 files 重算（口径自洽：新建+更新=总数）
  // 口径自洽：新建（创建后未再改）+ 更新（其余，含迭代）= 总数
  const created = files.filter(file => file.op === 'create' && file.opCount < 2).length
  const updated = files.length - created
  const iterated = files.filter(file => file.opCount >= 2).length
  // FileTree 的 onSelectFile 带 node 参数；对外只暴露 path（exactOptional 下始终传函数）
  const handleSelect = (path: string, _node: FileTreeNode): void => { onSelectFile?.(path) }
  return (
    <div className={css.artifactTree}>
      {showCounts && (
        <div className={css.artifactCounts}>
          {t('coach.artifacts.created')} {created} · {t('coach.artifacts.updated')} {updated}
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
/** 判断是否 skill 调用（非内置工具名）。 */
function isSkillAction(name: string): boolean {
  const builtin = new Set(['Read','Write','Bash','Edit','Grep','Glob','WebFetch','WebSearch','Task','TodoWrite','NotebookEdit','ComputerUse','Mouse','Keyboard','Shell','Exec','Spawn'])
  return !builtin.has(name) && /^[a-z]/.test(name)
}

export function RoundDetail({ round, t, onSelectFile }: {
  round: CoachTimelineRound
  t: Translate
  onSelectFile?: (path: string) => void
}): JSX.Element {
  const handleSelectOutputs = (path: string): void => { onSelectFile?.(path) }
  // 按工具类型聚合（Read/Write/Bash/...），副标题 pill
  const actionGroups = useMemo(() => {
    const map = new Map<string, { name: string; count: number; failed: number; retried: number; paths: string[] }>()
    for (const action of round.actions) {
      const g = map.get(action.name) ?? { name: action.name, count: 0, failed: 0, retried: 0, paths: [] }
      g.count++
      if (action.failed) g.failed++
      if (action.retried) g.retried++
      if (action.path !== null) g.paths.push(action.path)
      map.set(action.name, g)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [round.actions])
  return (
    <div className={css.roundBody}>
      {/* ① 对话详情 */}
      <div className={css.sectionHead}>
        <span className={css.sectionTitle}>{t('coach.timeline.chatTitle')}</span>
      </div>
      <div className={css.chatBlock}>
        <div className={css.chatUser}>{round.userText}</div>
        {round.assistantText !== null && (
          <div className={css.chatAssistant}>{round.assistantText}</div>
        )}
      </div>
      {/* ② 参考 + ③ 产物 */}
      {(round.references.length > 0 || round.artifacts.length > 0) && (
        <div className={css.subPair}>
          {round.references.length > 0 && (
            <div className={css.subBlock}>
              <div className={css.sectionHead}>
                <span className={css.sectionTitle}>{t('coach.timeline.references')}</span>
                <span className={css.sectionSub}>{round.references.length} {t('coach.timeline.files')}</span>
              </div>
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
              <div className={css.sectionHead}>
                <span className={css.sectionTitle}>{t('coach.timeline.outputs')}</span>
                <span className={css.sectionSub}>
                  {round.artifacts.length} {t('coach.timeline.files')}
                </span>
              </div>
              <ArtifactTree files={round.artifacts} counts={countsForRound(round.artifacts)} t={t} onSelectFile={handleSelectOutputs} />
            </div>
          )}
        </div>
      )}
      {/* ④ 过程工具调用（默认展开） */}
      {round.actions.length > 0 && (
        <div className={css.processBlockOpen}>
          <div className={css.sectionHead}>
            <span className={css.sectionTitle}>{t('coach.timeline.process')}</span>
            <span className={css.sectionSub}>
              {round.actions.length} {t('coach.timeline.toolCalls')}
            </span>
          </div>
          {actionGroups.map(g => (
            <div key={g.name} className={css.actionGroup}>
              <div className={css.actionGroupHead}>
                <span className={css.actionGroupName}>{g.name}</span>
                {isSkillAction(g.name) && <span className={css.tagSkill}>skill</span>}
                <span className={css.actionGroupCount}>{g.count}</span>
                {g.failed > 0 && <span className={css.tagError}>{t('coach.timeline.failed')} {g.failed}</span>}
                {g.retried > 0 && <span className={css.tagWarn}>{t('coach.timeline.retried')} {g.retried}</span>}
              </div>
              {g.paths.length > 0 && (
                <div className={css.actionGroupPaths}>
                  {g.paths.slice(0, 5).map((p, i) => (
                    <span key={i} className={css.actionPath}>{p}</span>
                  ))}
                  {g.paths.length > 5 && <span className={css.actionPath}>… +{g.paths.length - 5}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 统计数字缩写：≥1M 用 M、≥10K 用 K（精确值放 title）。 */
function fmtStatValue(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`
  }
  if (value >= 10_000) {
    const k = value / 1_000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}K`
  }
  return String(value)
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
      title={value.toLocaleString()}
      {...(onClick !== undefined ? {} : { disabled: true })}
    >
      <b className={danger ? css.danger : undefined}>{fmtStatValue(value)}</b>
      <span>{label}</span>
    </button>
  )
}

/** 输入构成（双条）：上条=字符量、下条=次数（条数/份数），对象同色。
 *  五对象：系统提示词 / 用户提示 / 委派指令 / 工具调用 / 上下文注入。
 *  图例数字可点击下钻：user/delegation → 对应抽屉；tools → 时间线卡；plugin → 注入抽屉。 */
function renderTokenProfile(
  t: Translate,
  profile: { system: number; user: number; tools: number; plugin: number; delegation: number } | null,
  counts: { system: number; user: number; delegation: number; tools: number; plugin: number } | null,
  onDrill?: (key: string) => void,
): JSX.Element | null {
  if (profile === null) return null
  const parts = [
    { key: 'system', value: profile.system, count: counts?.system ?? 0 },
    { key: 'user', value: profile.user, count: counts?.user ?? 0 },
    { key: 'delegation', value: profile.delegation, count: counts?.delegation ?? 0 },
    { key: 'tools', value: profile.tools, count: counts?.tools ?? 0 },
    { key: 'plugin', value: profile.plugin, count: counts?.plugin ?? 0 },
  ]
  const visible = parts.filter(part => part.value > 0 || part.count > 0)
  const totalChars = parts.reduce((sum, part) => sum + part.value, 0)
  const totalCounts = parts.reduce((sum, part) => sum + part.count, 0)
  if (totalChars <= 0 && totalCounts <= 0) return null
  const labelOf = (key: string): string => {
    switch (key) {
      case 'system': return t('coach.token.profile.system')
      case 'user': return t('coach.token.profile.user')
      case 'delegation': return t('coach.token.profile.delegation')
      case 'tools': return t('coach.token.profile.tools')
      default: return t('coach.token.profile.plugin')
    }
  }
  const drillable = (key: string): boolean => key === 'user' || key === 'delegation' || key === 'tools' || key === 'plugin'
  const unitOf = (key: string): string => {
    switch (key) {
      case 'system': return t('coach.token.profile.unitItems')
      case 'tools': return t('coach.token.profile.unitCalls')
      default: return t('coach.token.profile.unitMessages')
    }
  }
  return (
    <div className={css.tokenProfile}>
      <div className={css.tokenProfileTitle}>
        <span>{t('coach.token.profile.title')}</span>
        <span className={css.muted}>{t('coach.token.profile.estimate')}</span>
      </div>
      <div className={css.profileDual}>
        <div className={css.profileRow}>
          <span className={css.profileRowLabel}>{t('coach.token.profile.chars')}</span>
          <div className={css.profileBar}>
            {visible
              .filter(part => part.value > 0)
              .map(part => (
                <div
                  key={part.key}
                  className={`${css.profileSeg} ${css[`profileSeg_${part.key}`]}`}
                  style={{ width: `${(part.value / totalChars) * 100}%` }}
                  title={`${labelOf(part.key)} · ${part.value.toLocaleString()}`}
                />
              ))}
          </div>
        </div>
        {totalCounts > 0 && (
          <div className={css.profileRow}>
            <span className={css.profileRowLabel}>{t('coach.token.profile.counts')}</span>
            <div className={css.profileBar}>
              {visible
                .filter(part => part.count > 0)
                .map(part => (
                  <div
                    key={part.key}
                    className={`${css.profileSeg} ${css[`profileSeg_${part.key}`]}`}
                    style={{ width: `${(part.count / totalCounts) * 100}%` }}
                    title={`${labelOf(part.key)} · ${part.count}${unitOf(part.key)}`}
                  />
                ))}
            </div>
          </div>
        )}
      </div>
      <div className={css.profileLegend}>
        {visible.map(part => {
          const inner = (
            <>
              <i className={`${css.profileDot} ${css[`profileDot_${part.key}`]}`} />
              {labelOf(part.key)}
              <b>{part.value.toLocaleString()} 字</b>
              <span className={css.profileCount}>{part.count} {unitOf(part.key)}</span>
            </>
          )
          return drillable(part.key) && onDrill !== undefined
            ? (
              <button
                key={part.key}
                type="button"
                className={css.profileLegendItem}
                onClick={() => onDrill(part.key)}
                title={t('coach.context.clickHint')}
              >
                {inner}
              </button>
            )
            : <span key={part.key} className={css.profileLegendItem}>{inner}</span>
        })}
      </div>
    </div>
  )
}
