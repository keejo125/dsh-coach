/**
 * Agent 徽标：主 Agent（locale 化）/ 子 Agent label 短码（§2）。
 */

import { useCallback, useRef, useState } from 'react'
import type { AgentBadge as AgentBadgeType } from '../../shared/types.ts'
import type { ContextLocaleKey } from '../locales/zh-CN.ts'
import css from './AgentBadge.module.css'

/** 翻译函数形态（与框架 PropsLocale<NS>['t'] 结构一致）。 */
export type Translate = (key: ContextLocaleKey, params?: Record<string, string | number>) => string

export interface AgentBadgeProps {
  badge: AgentBadgeType | undefined
  t: Translate
  /** 可选的条目计数（输入栏 Agent 块头用，渲染为 `input.group.count`）。 */
  count?: number
}

/** 徽标文案推导：main 有真名（label≠'main'）→ 真名；否则 locale「主Agent」；子 Agent → label（短名）。 */
export function agentBadgeText(badge: AgentBadgeType | undefined, t: Translate): string {
  if (badge === undefined) return t('agent.subagent')
  if (badge.role === 'main') return badge.label === 'main' ? t('agent.main') : badge.label
  return badge.label
}

/** 自绘 tooltip 的最大宽度（与 CSS `.tip` 的 max-width 保持一致）。 */
const TIP_MAX_WIDTH = 260
/** tooltip 距视口左右边缘的最小留白。 */
const TIP_EDGE_GAP = 8
/** tooltip 相对徽标底边的偏移。 */
const TIP_OFFSET = 6

interface TipPosition {
  left: number
  top: number
}

/**
 * Agent 徽标；`count` 有值时在徽标后附一条目计数（块头复用）。
 *
 * 悬停说明放在**自绘 tooltip** 里，不用原生 `title`：
 * - 原生 title 要悬停 1~2 秒才弹，用户据此反馈「悬停看不到任务描述」；
 * - 三栏正文区是 `overflow:auto`，原生气泡还会被容器裁切。
 * 自绘气泡即时出现、fixed 定位不参与祖先 overflow 裁切、并按视口收边
 * （靠右的徽标不会溢出屏幕）。原 `title` 属性降级为 `aria-label`：
 * 保留无障碍语义，又不会额外弹出原生气泡造成两个气泡叠加。
 */
export function AgentBadge({ badge, t, count }: AgentBadgeProps) {
  const text = agentBadgeText(badge, t)
  const degraded = badge?.degraded === true
  // hover 优先级：降级提示 > 显式 title（任务描述 / preset id）> 内联文案
  const tipText = degraded ? t('agent.degraded') : (badge?.title ?? text)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [tip, setTip] = useState<TipPosition | null>(null)

  const showTip = useCallback((): void => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    // 贴徽标左下角，再收进视口（靠右时不会溢出屏幕）
    const maxLeft = Math.max(window.innerWidth - TIP_MAX_WIDTH - TIP_EDGE_GAP, TIP_EDGE_GAP)
    const left = Math.min(Math.max(rect.left, TIP_EDGE_GAP), maxLeft)
    setTip({ left, top: rect.bottom + TIP_OFFSET })
  }, [])
  const hideTip = useCallback((): void => { setTip(null) }, [])

  // 与展示名相同时不弹——否则气泡只是一句重复的名字，纯噪音
  const hasTipContent = tipText.length > 0 && tipText !== text

  return (
    <span
      className={css.badgeWrap}
      ref={anchorRef}
      onMouseEnter={showTip}
      onMouseLeave={hideTip}
    >
      <span
        className={`${css.badge}${badge?.role === 'main' ? ` ${css.main}` : ''}`}
        aria-label={tipText}
      >
        {text}
        {degraded ? <span className={css.degraded}>!</span> : null}
        {count !== undefined ? <span className={css.count}>{t('input.group.count', { n: count })}</span> : null}
      </span>
      {hasTipContent && tip !== null ? (
        <span className={css.tip} style={{ left: tip.left, top: tip.top }} role="tooltip">
          {tipText}
        </span>
      ) : null}
    </span>
  )
}
