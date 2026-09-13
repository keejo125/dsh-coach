/**
 * 视图状态 store：选中 agentKey、抽屉目标、注入区展开态、加载/错误态（§2）。
 *
 * 只存视图态与最近一次聚合快照，不缓存聚合数据权威副本（§1.2）：
 * 每次 Tab 激活重新拉取，连续切换 Tab 期间以 sessionId 缓存最近一次结果
 * （带 generatedAt 供「手动刷新」比对，§7.5），缓存上限 4 个会话 FIFO。
 */

import type { AgentBadge, ContextAggregate, CtxApiErrorCode } from '../shared/types.ts'
import { ContextApiError, fetchContextAggregate } from './api-client.ts'

/**
 * 抽屉目标：文件正文 / 输出全文 / 注入全文。
 *
 * 文件变体的可选项直接转发 FileTreeNode 的同名字段（本身可缺省），故显式带上
 * `| undefined`：在 `exactOptionalPropertyTypes` 下 `?: T` 不接受显式 undefined，
 * 转发会编译不过。消费侧（Drawer）一律以 `??` 兜底。
 */
export type DrawerTarget =
  | { kind: 'file'; path: string; agentKeys?: string[] | undefined; viewCount?: number | undefined; outputOp?: 'create' | 'update' | undefined }
  /** 输出全文：按**段 id** 取（`<sessionId>:<seq>`），跨聚合恒定。 */
  | { kind: 'output-text'; id: string; agentKey: string; turn: number }
  /** 注入全文：按**条目 id** 取（`seq` 跨会话不唯一，主/子会话各有 seq 1）。 */
  | { kind: 'inject'; id: string; agentKey: string; plugin: string }

export type LoadError = { code: CtxApiErrorCode; message: string }

export interface ContextViewState {
  /** 当前观察的会话 id。 */
  sessionId: string | null
  loading: boolean
  error: LoadError | null
  /** 最近一次聚合快照（激活时重新拉取；切换 Tab 命中缓存则不重复拉取）。 */
  aggregate: ContextAggregate | null
  /** 选中 Agent（null = 全部）；筛选在 client 端完成（待明确 #5 定案）。 */
  selectedAgentKey: string | null
  drawer: DrawerTarget | null
  /** 注入折叠区展开态。 */
  injectExpanded: boolean
  /**
   * 是否显示「过程输出」（默认关闭）。
   *
   * 刻意**不持久化**：既无 localStorage 约定，也不进 URL（§1.4）。开关态只在
   * 本次会话内记忆，切换会话/刷新后回到关闭——过程输出是辅助信息，默认不该撑爆视口。
   */
  showProcess: boolean
  /** 窄屏单栏模式的激活栏。 */
  narrowPane: 'input' | 'ref' | 'output'
}

interface CacheEntry {
  aggregate: ContextAggregate
}

const CACHE_LIMIT = 4

/** 视图状态 store（可观察；React 侧经 useSyncExternalStore 订阅）。 */
export class ContextStore {
  private state: ContextViewState = {
    sessionId: null,
    loading: false,
    error: null,
    aggregate: null,
    selectedAgentKey: null,
    drawer: null,
    injectExpanded: false,
    showProcess: false,
    narrowPane: 'input',
  }

  private readonly listeners = new Set<() => void>()
  private readonly cache = new Map<string, CacheEntry>()
  private loadEpoch = 0

  getState = (): ContextViewState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private patch(partial: Partial<ContextViewState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) listener()
  }

  /** Tab 激活/会话切换：命中缓存直接呈现，否则发起拉取（§7.5）。 */
  observe(sessionId: string): void {
    if (this.state.sessionId === sessionId && (this.state.aggregate !== null || this.state.loading)) return
    // 换会话：过程输出开关回到默认关闭（只在会话内记忆，不做跨会话持久化）。
    // 刻意**不**在 load() 里复位——手动刷新仍是同一会话，不该打断用户已开的开关。
    if (this.state.sessionId !== sessionId) this.patch({ showProcess: false })
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) {
      // 触碰缓存（移到 Map 尾部）
      this.cache.delete(sessionId)
      this.cache.set(sessionId, cached)
      this.patch({ sessionId, loading: false, error: null, aggregate: cached.aggregate, drawer: null, selectedAgentKey: null, injectExpanded: false })
      return
    }
    void this.load(sessionId)
  }

  /** 拉取/强制刷新：新的 loadEpoch 使过期响应失效。 */
  async load(sessionId: string): Promise<void> {
    const epoch = ++this.loadEpoch
    this.patch({ sessionId, loading: true, error: null, drawer: null, injectExpanded: false })
    try {
      const aggregate = await fetchContextAggregate(sessionId)
      if (epoch !== this.loadEpoch) return // 已被更新的加载覆盖
      if (this.cache.size >= CACHE_LIMIT && !this.cache.has(sessionId)) {
        const oldest = this.cache.keys().next().value
        if (oldest !== undefined) this.cache.delete(oldest)
      }
      this.cache.set(sessionId, { aggregate })
      this.patch({ loading: false, error: null, aggregate })
    } catch (error) {
      if (epoch !== this.loadEpoch) return
      if (error instanceof ContextApiError) {
        this.patch({ loading: false, error: { code: error.code, message: error.message } })
      } else {
        this.patch({ loading: false, error: { code: 'CTX_INTERNAL', message: 'unknown error' } })
      }
    }
  }

  /** 手动刷新：绕过缓存重新聚合。 */
  refresh(): void {
    const sessionId = this.state.sessionId
    if (sessionId === null) return
    void this.load(sessionId)
  }

  selectAgent(agentKey: string | null): void {
    this.patch({ selectedAgentKey: agentKey })
  }

  openDrawer(target: DrawerTarget): void {
    this.patch({ drawer: target })
  }

  closeDrawer(): void {
    this.patch({ drawer: null })
  }

  setInjectExpanded(expanded: boolean): void {
    this.patch({ injectExpanded: expanded })
  }

  /** 切换「显示过程输出」（会话内记忆，不落盘）。 */
  setShowProcess(showProcess: boolean): void {
    this.patch({ showProcess })
  }

  setNarrowPane(pane: ContextViewState['narrowPane']): void {
    this.patch({ narrowPane: pane })
  }
}

/** agentKey → AgentBadge 的查找表。 */
export function agentMap(aggregate: ContextAggregate | null): Map<string, AgentBadge> {
  const map = new Map<string, AgentBadge>()
  for (const badge of aggregate?.agents ?? []) map.set(badge.agentKey, badge)
  return map
}
