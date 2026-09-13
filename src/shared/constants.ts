/**
 * 载荷预算常量（设计文档 §7.4 的单源）。
 * 所有截断/降级都置位 PayloadBudgets，client 顶部展示「已截断」提示。
 */

/** 单条文本（输入/输出段/注入正文）截断阈值（字节）。 */
export const TEXT_TRUNCATE_BYTES = 4 * 1024

/** 文件正文截断阈值（字节），file 端点生效。 */
export const FILE_BODY_MAX_BYTES = 512 * 1024

/** 子会话扫描数上限，超出 degraded。 */
export const MAX_CHILD_SESSIONS = 32

/** 单子会话扫描事件数上限，超出该子会话 degraded（仅徽标，无明细）。 */
export const MAX_CHILD_EVENTS = 20_000

/** 参考文件条目上限（超出不再计入，置 referencesTruncated）。 */
export const MAX_REFERENCE_FILES = 2_000

/**
 * 单会话输出文字段保留上限。
 *
 * 语义（增量设计 §1.2 F6）：扫描期以 `MAX_OUTPUT_SEGMENTS * 2` 为高水位做滑动窗口，
 * 触达即一次性 `slice(-MAX_OUTPUT_SEGMENTS)`；扫描结束时再按同一上限收口一次。
 * 两次都是**保留最新**——最终答复判定依赖最新段，保留最早会让「取最后一段非空
 * 文本」在超长会话上失效。被丢弃的段计数进 `budgets.droppedOutputSegments`。
 */
export const MAX_OUTPUT_SEGMENTS = 500

/**
 * 全局（合并排序后）输出段上限，防多 Agent 叠加导致载荷爆炸
 * （32 个子会话 × 500 段 = 16 000）。超出时先标记 final 段，再按时间序淘汰最早的
 * 过程段（final 段永不淘汰），丢弃数计入 `budgets.droppedOutputSegments`。
 */
export const MAX_TOTAL_OUTPUT_SEGMENTS = 2_000

/**
 * 过程段（`kind === 'process'`）正文预览裁剪阈值（字节）。
 *
 * 最终答复段不适用——它走 4KB 常规截断（`TEXT_TRUNCATE_BYTES`）。
 * 裁剪用独立字段 `previewOnly` 表达，**不参与 budgets 计算**：若计入
 * `outputsTruncated`，过程段恒为「已截断」，顶部横幅会永远为真（§1.4）。
 */
export const PROCESS_PREVIEW_BYTES = 320

/**
 * 输入条目上限（用户输入 + 系统注入合计）。§7.4 预算表未列输入条目数，
 * v1 补充该上限防极端日志拖垮载荷；超出置 inputsTruncated。
 */
export const MAX_INPUT_ITEMS = 1_000

/** 子会话并发读取的小并发池大小（§7.5）。 */
export const CHILD_SCAN_CONCURRENCY = 4

/** 已知注入文档名集合（无斜杠文件名也按路径候选，§3.5 规则 3）。 */
export const KNOWN_INJECT_DOC_NAMES: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'SKILL.md',
]

/** 基座内部前缀：候选路径命中即排除（§3.5 规则 4）。 */
export const EXCLUDED_PATH_PREFIXES: readonly string[] = ['node_modules/', '.git/']

/**
 * 无扩展名但确为文件的文件名白名单。
 *
 * extract.ts 用「末段须有扩展名」剔除裸词与目录（真实数据上挡住了 sandbox /
 * guards / Bash/formatters / src/components / @scope/pkg 五类噪声），代价是会
 * 连带漏掉这类合法的无扩展名文件，故在此显式补回。只收公认的构建/配置文件名——
 * 泛化词（如 LICENSE）不收，它在散文里出现频率高于作为路径。
 */
export const KNOWN_EXTENSIONLESS_FILENAMES: readonly string[] = [
  'Dockerfile',
  'Gemfile',
  'Jenkinsfile',
  'Justfile',
  'Makefile',
  'Procfile',
  'Rakefile',
  'Vagrantfile',
]
