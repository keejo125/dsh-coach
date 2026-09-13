/**
 * dsh-coach host 插件入口：注册 /ctx/api 只读端点。
 * 数据权威是基座 SessionQueryEngine（即时聚合，不落盘、无自有持久状态）。
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型-only：Context 合并（webServer / sessionQuery 服务行）必须进入本程序
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import { registerCtxApi } from './api.ts'

export const name = 'dsh-coach'

/** 所需服务：会话查询引擎（聚合数据源）与 web 服务器（/ctx/api 路由）。 */
export const inject = ['sessionQuery', 'webServer']

/**
 * Host 插件体：注册 /ctx/api 前缀端点。
 * @param ctx - host 根 context。
 */
export function apply(ctx: Context): void {
  registerCtxApi(ctx, ctx.sessionQuery)
}
