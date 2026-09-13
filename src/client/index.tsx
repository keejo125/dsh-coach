/**
 * dsh-coach client 入口（v0.2b）：注册 conversation.view 复盘 Tab（id='coach'）。
 *
 * - host 端 `/ctx/api` 已停用（与 dsh-context-plugin 并存零冲突）；「上下文」Tab 一并摘除。
 * - v0.2b 起注册「复盘」Tab，消费 /coach/api/session/:id/report + /timeline。
 * - 注册走 ctx.slots.inject 包裹（卸载即摘除），label 用 thunk 跟随活跃 locale。
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型-only：locale 与 conversation.view 槽位行的 Context 合并必须进入本程序
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// ctx.slots（SlotRegistry）由 ui-renderer 服务合并进 Context，不是 ui-slots：
// ui-slots 只导出纯槽位注册表的类型与不变量，不带 /client 子路径。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { COACH_VIEW_ID, CoachView } from './CoachView.tsx'
import { en } from './locales/en-US.ts'
import { NS, zh, type ContextLocaleKey } from './locales/zh-CN.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-coach 复盘 Tab 文案命名空间（含上下文三栏遗留文案，P2 复用）。 */
    'dsh-coach': ContextLocaleKey
  }
}

/** 所需服务：槽位（Tab 注册）与文案（字典注册与绑定）。 */
export const inject = ['slots', 'locale']

/**
 * Client 插件体：注册「复盘」Tab。注册挂在 slots 的 effect 包装上，插件卸载即移除。
 * @param ctx - client 根 context。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-coach: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: COACH_VIEW_ID,
    order: 100,
    locale: NS,
    label: () => t('tab.label'),
  }, CoachView))
}
