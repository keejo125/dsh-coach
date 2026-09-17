/**
 * 文件正文抽屉（复盘点击参考/产物文件打开）：mask + 右侧面板 + loading/error/ready 三态。
 * 与 Context 插件的抽屉同视觉（主题令牌跟随），按 Esc / 点遮罩关闭，支持全屏放大。
 */

import { useEffect, useRef, useState } from 'react'
import { CoachApiError, fetchCoachFile, type CoachFileContent } from './coach-client.ts'
import { IconCloseOutline16, IconFullscreenOutline16 } from './icons/index.tsx'
import type { Translate } from './components/AgentBadge.tsx'
import css from './CoachDrawer.module.css'

export interface CoachDrawerProps {
  sessionId: string
  /** 要打开的文件（工作区相对路径）。 */
  path: string
  t: Translate
  onClose: () => void
}

type DrawerBody =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; content: CoachFileContent }

export function CoachDrawer({ sessionId, path, t, onClose }: CoachDrawerProps): JSX.Element {
  const [zoom, setZoom] = useState(false)
  const [body, setBody] = useState<DrawerBody>({ state: 'loading' })

  // Esc 关闭 + 打开时焦点移入面板（WCAG 2.4.7）
  const panelRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    window.setTimeout(() => { panelRef.current?.focus() }, 0)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  // 文件正文加载（随目标切换中止旧请求）
  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setBody({ state: 'loading' })
    void (async(): Promise<void> => {
      try {
        const content = await fetchCoachFile(sessionId, path, controller.signal)
        if (!alive) return
        setBody({ state: 'ready', content })
      } catch (error) {
        if (!alive) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        const apiError = error instanceof CoachApiError ? error : undefined
        const message = apiError !== undefined
          ? (apiError.code === 'COACH_BAD_REQUEST' && apiError.message.includes('not found')
            ? t('coach.drawer.fileNotFound')
            : t('coach.drawer.loadFailed'))
          : t('coach.drawer.loadFailed')
        setBody({ state: 'error', message })
      }
    })()
    return () => {
      alive = false
      controller.abort()
    }
  }, [sessionId, path, t])

  return (
    <div className={css.mask} onClick={onClose} role="presentation">
      <section
        ref={panelRef}
        className={`${css.panel}${zoom ? ` ${css.zoom}` : ''}`}
        role="dialog"
        aria-label={t('coach.drawer.title')}
        tabIndex={-1}
        onClick={event => { event.stopPropagation() }}
      >
        <header className={css.header}>
          <div className={css.headerMain}>
            <span className={css.title}>{t('coach.drawer.title')}</span>
            <code className={css.path} title={path}>{path}</code>
          </div>
          <div className={css.headerActions}>
            <button
              type="button"
              className={css.iconButton}
              onClick={() => { setZoom(value => !value) }}
              title={t('coach.drawer.zoom')}
              aria-label={t('coach.drawer.zoom')}
            >
              <IconFullscreenOutline16 size={16} />
            </button>
            <button type="button" className={css.iconButton} onClick={onClose} title={t('coach.drawer.close')} aria-label={t('coach.drawer.close')}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>
        <div className={css.body}>
          {body.state === 'loading' ? <div className={css.hint}>{t('coach.state.loading')}</div> : null}
          {body.state === 'error' ? <div className={`${css.hint} ${css.errorHint}`}>{body.message}</div> : null}
          {body.state === 'ready' ? (
            <>
              {body.content.truncated ? <div className={css.truncatedHint}>{t('coach.drawer.truncated')}</div> : null}
              <pre className={css.content}>{body.content.text}</pre>
            </>
          ) : null}
        </div>
      </section>
    </div>
  )
}
