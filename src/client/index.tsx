/**
 * dsh-coach client 入口（v0.2a 数据层版本）：暂不注册 UI。
 *
 * host 端 `/ctx/api` 已停用（与 dsh-context-plugin 并存时前缀冲突），
 * 继承自 dsh-context 的「上下文」Tab 一并摘除——P1 是纯数据层，页面无变化。
 * P2（复盘 UI）在本入口注册复盘 Tab（消费 /coach/api/session/:id/report）。
 *
 * 保留 LocaleNamespaceMap 的 module 合并：ContextView 等组件的 props 类型
 * （GlobalStandardProps.t）依赖命名空间注入，文件在 P2 继续使用。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextLocaleKey } from './locales/zh-CN.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-coach 复盘 UI 文案命名空间（P2 启用）。 */
    'dsh-coach': ContextLocaleKey
  }
}

export const name = 'dsh-coach'

/** 数据层版本不消费 client 服务；P2 复盘 UI 恢复 slots/locale。 */
export const inject: string[] = []

/**
 * Client 插件体（v0.2a）：无 UI，空实现。
 * @param _ctx - client 根 context（保留签名，P2 复用）。
 */
export function apply(_ctx: Context): void {
  // P2：在此注册复盘 Tab（id='coach'，消费 /coach/api）
}
