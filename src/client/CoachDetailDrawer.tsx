/**
 * 数据明细抽屉（复盘点击「查看全部/查看明细」下钻）：mask + 右侧面板 + 分区列表。
 * 与文件抽屉（CoachDrawer）同视觉；承载 Token 全量轮次、上下文构成明细等结构化数据。
 */
import { useEffect } from 'react'
import { IconCloseOutline16 } from './icons/index.tsx'
import type { Translate } from './components/AgentBadge.tsx'
import css from './CoachDetailDrawer.module.css'

export interface CoachDetailSection {
  /** 小节标题（如「用户输入 · 21」）。 */
  title: string
  /** 条目列表（纯文本，已截断）。 */
  items: readonly string[]
}

export interface CoachDetailDrawerProps {
  title: string
  sections: readonly CoachDetailSection[]
  t: Translate
  onClose: () => void
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

  const nonEmpty = sections.filter(section => section.items.length > 0)

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
                {section.items.map((item, index) => (
                  <div key={index} className={css.item} title={item}>{item}</div>
                ))}
              </section>
            ))}
        </div>
      </div>
    </div>
  )
}
