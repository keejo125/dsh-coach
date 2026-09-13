/**
 * 条目/段落的稳定 id：`<拥有者会话 id>:<事件 seq>`。
 *
 * 会话日志 append-only、seq 单调不重写，故同一段在多次聚合之间 id 恒定。
 * 这是 output-text 端点由「按下标取」改为「按 id 取」的基础（增量设计 §1.3）：
 * 端点、React key、抽屉定位、分组引用一律走 id，数组下标只允许出现在
 * `OutputTextResult.index` 这个诊断字段里。
 *
 * 本目录为纯逻辑共享层：无 IO、无框架依赖、无基座包导入。
 */

/**
 * 构造条目稳定 id。
 * @param sessionId 拥有者会话 id（主会话或子会话）。
 * @param seq 事件序号（会话内单调不重写）。
 */
export function makeEntryId(sessionId: string, seq: number): string {
  return `${sessionId}:${String(seq)}`
}
