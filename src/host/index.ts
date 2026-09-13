/**
 * dsh-coach host 插件入口：注册 /coach/api（复盘报告）只读端点。
 *
 * v0.2a 起不再注册 /ctx/api：与 dsh-context-plugin 并存时该前缀会重复注册
 * （webserver 拒绝），dsh-coach 的定位是「会话复盘教练」，数据面只暴露
 * /coach/api。数据权威是基座 SessionQueryEngine（即时聚合，不落盘）。
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型-only：Context 合并（webServer / sessionQuery 服务行）必须进入本程序
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import { registerCoachApi } from './coach/api.ts'

export const name = 'dsh-coach'

/** 所需服务：会话查询引擎（聚合数据源）与 web 服务器（/coach/api 路由）。 */
export const inject = ['sessionQuery', 'webServer']

/**
 * Host 插件体：注册 /coach/api 前缀端点。
 * @param ctx - host 根 context。
 */
export function apply(ctx: Context): void {
  registerCoachApi(ctx, ctx.sessionQuery)
}
