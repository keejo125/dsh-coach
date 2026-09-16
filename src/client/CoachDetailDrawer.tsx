/**
 * 数据明细抽屉（复盘点击「查看全部/查看明细/具体数字」下钻）：mask + 右侧面板 + 分区内容。
 * 与文件抽屉（CoachDrawer）同视觉；支持两种可视化单元：
 *  - bars：条形进度（数值占比，如 Token 全量轮次）
 *  - items：文本条目，可带 tone 徽章（ok/error/warn）
 */
import { useEffect } from 'react'
import { IconCloseOutline16 } from './icons/index.tsx'
import type { Translate } from './components/AgentBadge.tsx'
import css from './CoachDetailDrawer.module.css'

export interface CoachDetailItem {
  text: string
  tone?: 'ok' | 'error' | 'warn'
}

export interface CoachDetailBar {
  label: string
  value: number
  total: number
  /** 行尾补充文本（如 token 数值）。 */
  text?: string
}

export interface CoachDetailSection {
  title: string
  items?: readonly (string | CoachDetailItem)[]
  bars?: readonly CoachDetailBar[]
}

export interface CoachDetailDrawerProps {
  title: string
  sections: readonly CoachDetailSection[]
  t: Translate
  onClose: () => void
}

function toneClass(tone: CoachDetailItem['tone']): string {
  switch (tone) {
    case 'ok': return css.toneOk ?? ''
    case 'error': return css.toneError ?? ''
    case 'warn': return css.toneWarn ?? ''
    default: return ''
  }
}

export function CoachDetailDrawer({ title, sections, t, onClose }: CoachDetailDrawerProps): JSX.Element {
  // Esc 关闭
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const nonEmpty = sections.filter(section =>
    (section.items !== undefined && section.items.length > 0) ||
    (section.bars !== undefined && section.bars.length > 0))

  return (
    <div className={css.mask} onClick={onClose}>
      <div className={css.panel} onClick={event => event.stopPropagation()}>
        <div className={css.header}>
          <div className={css.headerMain}>
            <span className={css.title}>{title}</span>
          </div>
          <button className={css.iconButton} onClick={onClose} aria-label={t('coach.drawer.close')}>
            <IconCloseOutline16 />
          </button>
        </div>
        <div className={css.body}>
          {nonEmpty.length === 0
            ? <div className={css.hint}>{t('coach.drawer.noDetail')}</div>
            : nonEmpty.map(section => (
              <section key={section.title} className={css.section}>
                <div className={css.sectionTitle}>{section.title}</div>
                {section.bars !== undefined && section.bars.length > 0 ? (
                  <div className={css.barList}>
                    {section.bars.map((bar, index) => (
                      <div key={index} className={css.barRow}>
                        <span className={css.barLabel} title={bar.label}>{bar.label}</span>
                        <div className={css.barTrack}>
                          <div
                            className={css.barFill}
                            style={{ width: `${bar.total > 0 ? Math.min(100, (bar.value / bar.total) * 100) : 0}%` }}
                          />
                        </div>
                        <span className={css.barValue}>{bar.text ?? bar.value.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  (section.items ?? []).map((item, index) => {
                    const entry = typeof item === 'string' ? { text: item } as CoachDetailItem : item
                    return (
                      <div key={index} className={`${css.item} ${toneClass(entry.tone)}`} title={entry.text}>{entry.text}</div>
                    )
                  })
                )}
              </section>
            ))}
        </div>
      </div>
    </div>
  )
}
