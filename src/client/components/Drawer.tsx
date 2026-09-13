/**
 * 右侧抽屉：文件正文（file 端点）或条目全文渲染（§2）。
 * loading / error / ready 三态；Esc / 遮罩关闭；支持全屏放大。
 * 正文按文件扩展名做基础高亮（Markdown / 代码 / 纯文本，见下方高亮小节）。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ContextAggregate } from '../../shared/types.ts'
import { ContextApiError, fetchFileBody, fetchOutputText, revealFileInFolder } from '../api-client.ts'
import type { DrawerTarget } from '../store.ts'
import { AgentBadge, type Translate } from './AgentBadge.tsx'
import type { AgentBadge as AgentBadgeType } from '../../shared/types.ts'
import { IconFolderOpen16, IconFullscreenOutline16, IconCloseOutline16 } from '../icons/index.tsx'
import css from './Drawer.module.css'

// ============================================================
// 基础高亮（需求 §五）：只按扩展名分类，不引第三方着色库
// ============================================================

/**
 * 刻意**不引入第三方高亮库**（零新增外部依赖），也**不拼 HTML 字符串**：
 * 全部输出 React 元素，天然转义，没有注入面。只做行级分类 + 代码里最稳的
 * 注释/字符串记号；无扩展名、点文件、未知扩展一律回落纯文本（宁缺勿错）。
 */

type HighlightKind = 'markdown' | 'code' | 'text'

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdx', 'mdtext'])

/** 常见源码扩展名；未列出的类型回落纯文本，不猜。 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'bash', 'c', 'cc', 'cpp', 'cxx', 'cjs', 'css', 'cts', 'go', 'h', 'hh', 'hpp', 'htm', 'html',
  'java', 'js', 'json', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'mjs', 'mts', 'py', 'rb', 'rs',
  'scss', 'sh', 'sql', 'svg', 'svelte', 'swift', 'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])

function highlightKindOf(path: string): HighlightKind {
  const name = path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'text' // 无扩展名或点文件（如 .gitignore）
  const ext = name.slice(dot + 1).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  return 'text'
}

/** 代码行内记号：行注释、块注释、双/单引号字符串。不认 `#`（C 预处理、CSS 色值都会误伤）。 */
const CODE_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g

function renderCodeLine(line: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = []
  let cursor = 0
  let index = 0
  CODE_TOKEN.lastIndex = 0
  let match = CODE_TOKEN.exec(line)
  while (match !== null) {
    if (match.index > cursor) {
      parts.push(<span key={`${keyPrefix}p${String(index)}`}>{line.slice(cursor, match.index)}</span>)
    }
    const token = match[0]
    const isComment = token.startsWith('//') || token.startsWith('/*')
    parts.push(
      <span key={`${keyPrefix}t${String(index)}`} className={isComment ? css.comment : css.string}>
        {token}
      </span>,
    )
    cursor = match.index + token.length
    index += 1
    match = CODE_TOKEN.exec(line)
  }
  if (cursor < line.length) parts.push(<span key={`${keyPrefix}p${String(index)}`}>{line.slice(cursor)}</span>)
  return parts
}

/** Markdown 行级分类：标题、列表标记、引用、围栏。 */
function markdownLineClass(line: string): string | undefined {
  if (/^#{1,6}\s/.test(line)) return css.heading
  if (/^\s*```/.test(line)) return css.fence
  if (/^\s*>/.test(line)) return css.quote
  if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) return css.marker
  return undefined
}

/** 渲染正文；纯文本类别直接返回原串（保持原本的单文本节点形态）。 */
function renderHighlighted(text: string, kind: HighlightKind): ReactNode {
  if (kind === 'text') return text
  return text.split('\n').map((line, index) => {
    const key = `l${String(index)}`
    if (kind === 'code') {
      return <div key={key} className={css.line}>{renderCodeLine(line, key)}</div>
    }
    const lineClass = markdownLineClass(line)
    return (
      <div key={key} className={lineClass === undefined ? css.line : `${css.line} ${lineClass}`}>
        {line.length === 0 ? ' ' : line}
      </div>
    )
  })
}

export interface DrawerProps {
  target: DrawerTarget
  sessionId: string
  aggregate: ContextAggregate
  agentsMeta: ReadonlyMap<string, AgentBadgeType>
  t: Translate
  onClose: () => void
}

type DrawerBody =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; text: string; truncated?: boolean }

export function Drawer({ target, sessionId, aggregate, agentsMeta, t, onClose }: DrawerProps) {
  const [zoom, setZoom] = useState(false)
  const [body, setBody] = useState<DrawerBody>({ state: 'loading' })
  const [revealError, setRevealError] = useState(false)

  // 唤起系统文件管理器定位该文件（仅 file 类抽屉可用）。
  // 浏览器无法直接开 Finder，交给 host 端点；失败只在按钮旁轻量提示，不打断阅读。
  const revealFolder = useCallback((): void => {
    if (target.kind !== 'file') return
    setRevealError(false)
    void revealFileInFolder(sessionId, target.path)
      .catch(() => { setRevealError(true) })
  }, [sessionId, target])

  // Esc 关闭
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  // 目标内容加载（inject 全文已在聚合载荷里，无需拉取）
  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setBody({ state: 'loading' })
    void (async(): Promise<void> => {
      try {
        if (target.kind === 'file') {
          const file = await fetchFileBody(sessionId, target.path, controller.signal)
          if (!alive) return
          setBody({ state: 'ready', text: file.content, truncated: file.truncated })
        } else if (target.kind === 'output-text') {
          const segment = await fetchOutputText(sessionId, target.id, controller.signal)
          if (!alive) return
          setBody({ state: 'ready', text: segment.text })
        } else {
          // 按 id 查找：seq 只在单会话内唯一，跨会话（主 seq 1 / 子 seq 1）会撞车
          const item = aggregate.inputs.pluginItems.find(entry => entry.id === target.id)
          if (!alive) return
          setBody(item !== undefined ? { state: 'ready', text: item.text } : { state: 'error', message: t('error.loadFailed') })
        }
      } catch (error) {
        if (!alive) return
        if (error instanceof ContextApiError) {
          const message = error.code === 'CTX_FILE_NOT_FOUND'
            ? t('error.fileNotFound')
            : error.code === 'CTX_FILE_FORBIDDEN'
              ? t('error.fileForbidden')
              : t('error.loadFailed')
          setBody({ state: 'error', message })
        } else {
          setBody({ state: 'error', message: t('error.loadFailed') })
        }
      }
    })()
    return () => {
      alive = false
      controller.abort()
    }
  }, [target, sessionId, aggregate, t])

  // —— 头部信息 ——
  let headerPath = ''
  let headerTitle = ''
  let headerAgents: readonly string[] = []
  let headerViewCount: number | undefined
  if (target.kind === 'file') {
    headerTitle = t('drawer.file')
    headerPath = target.path
    headerAgents = target.agentKeys ?? []
    headerViewCount = target.viewCount
  } else if (target.kind === 'output-text') {
    // 标题按段性质分派：最终答复全文 / 过程输出全文（端点已下发 kind）
    const segment = aggregate.outputs.textSegments.find(entry => entry.id === target.id)
    headerTitle = t('drawer.outputTextKind', {
      kind: segment?.kind === 'process' ? t('output.process') : t('output.final'),
    })
    headerAgents = [target.agentKey]
  } else {
    headerTitle = t('drawer.inject')
    headerAgents = [target.agentKey]
  }

  return (
    <div className={css.mask} onClick={onClose} role="presentation">
      <section
        className={`${css.panel}${zoom ? ` ${css.zoom}` : ''}`}
        role="dialog"
        aria-label={headerTitle}
        onClick={event => { event.stopPropagation() }}
      >
        <header className={css.header}>
          <div className={css.headerMain}>
            <span className={css.title}>{headerTitle}</span>
            {headerPath !== '' ? <code className={css.path}>{headerPath}</code> : null}
            {headerViewCount !== undefined && headerViewCount > 0 ? (
              <span className={css.views}>{t('badge.views', { n: headerViewCount })}</span>
            ) : null}
            {headerAgents.map(agentKey => (
              <AgentBadge key={agentKey} badge={agentsMeta.get(agentKey)} t={t} />
            ))}
          </div>
          <div className={css.headerActions}>
            {revealError ? <span className={css.revealError}>{t('drawer.revealFailed')}</span> : null}
            {/* 仅 file 类抽屉有路径可定位；注入/输出全文没有对应文件 */}
            {target.kind === 'file' ? (
              <button
                type="button"
                className={css.iconButton}
                onClick={revealFolder}
                title={t('drawer.reveal')}
                aria-label={t('drawer.reveal')}
              >
                <IconFolderOpen16 size={16} />
              </button>
            ) : null}
            <button type="button" className={css.iconButton} onClick={() => { setZoom(value => !value) }} title={t('drawer.zoom')}><IconFullscreenOutline16 size={16} /></button>
            <button type="button" className={css.iconButton} onClick={onClose} title={t('drawer.close')}><IconCloseOutline16 size={16} /></button>
          </div>
        </header>
        <div className={css.body}>
          {body.state === 'loading' ? <div className={css.hint}>{t('state.loading')}</div> : null}
          {body.state === 'error' ? <div className={`${css.hint} ${css.errorHint}`}>{body.message}</div> : null}
          {body.state === 'ready' ? (
            <>
              {/* 文件正文截断是 file 端点的 512KB 限额，与输入段 4KB 截断不是一回事，文案分开 */}
              {body.truncated === true ? <div className={css.truncatedHint}>{t('drawer.fileTruncated')}</div> : null}
              {/* 只有 file 端点（有扩展名可判）才按类型高亮；输出全文/注入全文走纯文本 */}
              <pre className={css.content}>
                {target.kind === 'file'
                  ? renderHighlighted(body.text, highlightKindOf(target.path))
                  : body.text}
              </pre>
            </>
          ) : null}
        </div>
      </section>
    </div>
  )
}
