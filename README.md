# dsh-coach

DeepSeek Harness 会话复盘教练插件：在主对话页新增最右侧「复盘」Tab（order 100），同屏三栏展示整个会话的 **输入｜参考｜输出**（1 : 1.2 : 1，窄屏单栏切换）。

- 不依赖 dsh-workbench-plugin 的任何代码/事件/API；不改基座一行代码；零新增外部依赖。
- host 面：消费基座 `SessionQueryEngine` 即时聚合（不落盘、无持久状态），暴露 `/ctx/api` 只读端点。
- client 面：按 `ui-trajectory` 同款惯例注册 `conversation.view` 条目（`ctx.slots.inject` 包裹，label 用 locale thunk）。

## 安装

> 下面的 `pnpm dsh ...` 都在**基座仓库（deepseek-harness）根**执行——基座 `package.json` 已定义 `dsh` 脚本，这是官方原生入口。若你的环境已把 `dsh` 加入 PATH，可简写为 `dsh ...`。
>
> 兜底：个别环境下 `pnpm dsh` 会连带触发基座根的 `postinstall`（lefthook 安装）而失败。此时改用它等价的直接调用，同样在基座仓库根执行：
>
> ```bash
> node --import tsx/esm apps/cli/src/bin.ts <子命令...>
> ```
>
> 即 `package.json` 里 `dsh` 脚本的原文，两者完全等价。

### 前置条件

- 基座仓库可用（已 `pnpm install`），且 pnpm 在 PATH 上（`dsh plugin` 要调它）；
- 本插件已构建：`lib/index.js`、`lib/client.js`、`lib/types/**` 在位（见下方「开发」一节）；
- 知道要装进哪个 profile（下文以 `<profile>` 代称；主对话页用的是 `web`）。

### 装进 profile

`dsh plugin` **没有自己的 `add` 子命令**：`add` / `remove` / `why` / `update` 都原样转发给 pnpm，并在 **profile 目录**里执行。所以包装到 `$DSH_HOME/profiles/<profile>/node_modules`（默认 `~/.dsh/profiles/<profile>/node_modules`），既不是基座仓库根，也不是当前目录。

装完后 dsh 对账依赖表：本包 `package.json` 声明了 `dsh.bundle.patch`（`./cordis.patch.yml`），于是被自动追加进 `dsh.profile.bundles`——**profile manifest 从不需要手写**。

按场景选一种 target 形式：

```bash
# 1) 本地目录 —— 开发自用：rebuild 即生效，无需反复 add
pnpm dsh plugin --profile <profile> add ../dsh-coach

# 2) tarball —— 最"交付态"：先在本插件目录打包，再装产物
(cd ../dsh-coach && npm pack)   # 产出 dsh-coach-0.1.0.tgz
pnpm dsh plugin --profile <profile> add ../dsh-coach/dsh-coach-0.1.0.tgz

# 3) 包名 —— 发布到 registry 之后的最终用户用法
pnpm dsh plugin --profile <profile> add dsh-coach
```

> 相对路径只有以 `.` / `..` 开头（含 `file:` / `link:` 前缀形式）才会按调用目录锚定为绝对路径，其余写法原样交给 pnpm。裸包名走 registry 解析——本插件尚未发布、也未挂进基座 workspace，形式 3 目前解析不到。

#### 依赖版本口径（peerDependencies）

本包 `peerDependencies` 一律是常规 semver 范围，不使用 `workspace:` 协议——后者是 pnpm workspace 的内部协议，只对挂在同一个 workspace 里的包有意义，出现在独立分发的包里会让 peer 契约变成任何版本都无法满足的死约束。

| 包 | 范围 | 依据 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.1` | 基座 `vendor/cordis/package.json` 的 `version`（vendored，**不随**基座主版本线走） |
| 其余 8 个 `@deepseek-ai/*` | `^0.1.5-rc.2` | 基座 `packages/**/package.json` 的 `version`（基座全依赖包同版本锁定；0.1.5 起 Session Log V3） |

`devDependencies` 同步使用上述真实范围（本机开发靠 `node_modules` 内指向基座的符号链接解析，无 lock 文件，与这些范围无关；统一成常规 semver 只是为了让打包产物里不残留任何 `workspace:` 写法）。

> 装上之后 `pnpm peers check` 仍可能把这 8 个 `@deepseek-ai/*` 报成 `missing peer`：它们不在 profile 自己的 `node_modules` 里，而是由 `$DSH_HOME/profiles/node_modules` 这个共享安装闭包 fallback 提供（`@deepseek-ai/cordis` 就在其中，所以它能被 `^4.0.1` 命中而不报缺失）。这是**报告口径**差异，不是协议错误——运行期解析照常走该闭包，功能不受影响。

### 启动与验证

```bash
pnpm dsh --profile <profile> --dump-config | grep dsh-coach   # 只看配置，不启动
pnpm dsh web                                                    # 启动主对话页
```

`--dump-config` 打印组合后的配置树，能看到本包贡献的 bundle 层（`- id: dsh-coach`）即安装已生效。`plugin list` 只列 pnpm 依赖树，**不能**用来判断 bundle 是否激活。

> **改动后必须重启 profile**：pnpm 只改磁盘，运行中的 profile 沿用启动时的 bundle 集合——add / remove / update 之后要重启 `dsh web`。而 `cordis.patch.yml` 的编辑是热重载的，不受此限。

### 卸载

```bash
pnpm dsh plugin --profile <profile> remove dsh-coach
```

依赖与对应的 bundle 层一并移除。

## /ctx/api 端点契约（GET 只读，统一 `{ok,data|error}` 包络）

| 端点 | 用途 |
|---|---|
| `GET /ctx/api/session/:id/context` | 一次返回三段聚合 `ContextAggregate`（输入/参考/输出 + Agent 徽标 + 预算标记） |
| `GET /ctx/api/session/:id/file?path=` | 按需拉取工作区文件正文（五级安全链，512KB 截断） |
| `GET /ctx/api/session/:id/output-text?id=` | 按**段 id** 拉取文字输出全文（不截断；不受 4KB 截断与 320B 预览裁剪影响）。`?index=` 为 deprecated 兼容路径，v1.1 移除 |

错误码：`CTX_SESSION_NOT_FOUND` / `CTX_FILE_FORBIDDEN` / `CTX_FILE_NOT_FOUND` / `CTX_SEGMENT_NOT_FOUND` / `CTX_INDEX_OUT_OF_RANGE`（仅 `?index=`）/ `CTX_BAD_REQUEST` / `CTX_INTERNAL`，HTTP 状态同步映射（404/403/400/500）。

## 能力边界与数据口径

- **参考计数**：`read` / `read_image` / `str_replace_editor view` 按调用次数累计（部分读每次 +1，不按行加权）；计数源优先 `tool/result.meta.path`（绝对展示路径，聚合器按会话 `header.cwd` 相对化），缺失回落 `tool/call.arguments`。
- **write 新建兜底**（架构师修正口径）：`meta.diffs === []` → create、非空 → update；路径从 `tool/call.arguments.file_path` 解析。
- **多 Agent**：`traceSession` 取子会话谱系；子会话 header（`parentSession/origin/agentPreset`）为聚合锚点；徽标名推导链 `descriptor.label → agentPreset → id 前 8 位`；子会话扫描预算 ≤ 32 个 / 单会话 ≤ 20k 事件，超出降级为「仅徽标」。
- **注入路径提取**：`src/shared/extract.ts` 六步规则（宁缺勿错，提不出路径的注入只留在折叠区）。
- **附件**：基座 `ImageAttachmentRef` 明确「never a filesystem path」，v1 附件仅展示名。
- **安全链**（file 端点）：相对路径 → 拒 `..` → restrictPath 前缀 → realpath 反 symlink → 仅常规文件 → 512KB 截断；header 缺 `cwd` 时整体拒绝（fail-closed）。
- **实时性**：v1 为「激活时快照 + 手动刷新」。host 侧**无跨请求缓存**（每个请求即时聚合一次，保持无状态）；复用只发生在 client store（按 sessionId 保留最近一次快照，带 `generatedAt`，手动刷新绕过它）。
- **文本截断口径**：单条文本（输入/输出/注入正文）按 **UTF-8 字节**截断到 4KB，且遇代理对（emoji 等）整对取舍，不会切出半个字符；文件正文按字节截断到 512KB。
- **抽屉基础高亮**：文件正文按扩展名判定 Markdown / 代码 / 纯文本，行级分类 + 代码的注释与字符串着色；无扩展名、点文件、未知扩展一律回落纯文本。不引第三方高亮库。
- **深链焦点**：消费基座 `conversation.view` 的 `viewRequest`，`focus` 是本 Tab 自有的不透明串——`file:<工作区相对路径>` 打开该文件正文，`output:<段 id>` 打开该段全文（纯数字的旧下标深链仍兼容）；其余 focus 一律 ack 后忽略（v1 暂无生产方）。

## 变更记录

### 依赖协议修复：`workspace:` → 常规 semver（包版本仍为 0.1.0）

`d165b1f` 及之前打出的 tarball，`peerDependencies`（以及 `devDependencies` 里的同名项）写的是 `workspace:^` / `workspace:*`。这是 pnpm workspace 的内部协议，本插件并未挂进基座 workspace，装在 workspace 之外时 peer 契约不可满足——`pnpm peers check` 会把它原样报成 `Wanted: workspace:^`，任何真实版本号都匹配不上；一旦 profile 开启 peer 自动安装（或遇到严格 peer 策略），解析该协议就会直接报错。

自 `d165b1f` 之后的本次修订起，全部改为常规 semver 范围（口径见上方「依赖版本口径」表）。

**旧版本（含 `d165b1f`）若遇到该报错，临时处理**：把 `package.json` 的 `peerDependencies` 里这几项临时改成 `*` 再装——运行期 peers 由 `$DSH_HOME/profiles/node_modules` 这个共享安装闭包 fallback 解析，不影响运行。更好的做法是直接用本次修订之后打出的包，无需临时改动。

快速判断手上的 tarball 是否已修复：

```bash
tar -xzOf dsh-coach-0.1.0.tgz package/package.json | grep 'workspace:'
# 无输出 = 已修复；有输出 = 旧版，按上面的临时处理走
```

### v1.1（最终产物 / 按 Agent 分组 / 委派归属）

- **输出栏只给最终产物**：每个 Agent 各取其最终答复（该 Agent 时间序最后一段非空文本）；逐轮/逐 step 的中间过程输出默认不显示，界面提供「显示过程输出」开关（默认关闭，数据仍在响应里，切换瞬时）。文件产出口径不变。
- **输入栏按 Agent 分组**：每个 Agent 一块（主 Agent 最前），块内汇总该 Agent 的输入（用户提示词、注入文档、它收到的委派指令）。委派指令归**子 Agent**——谁收到算谁的。
- **稳定 id**：输出段 / 用户输入 / 系统注入一律带 `id = <会话id>:<seq>`；`output-text` 端点改为按 id 取全文（根除 v1.0 下标错位导致的静默取错段）。

> ⚠️ **BREAKING（仅内部）**：`/ctx/api` 是插件私有端点，host 与 client 同包同版本发布，**对外部消费者无破坏性变更**。内部三条语义变更：
> 1. `budgets.inputsTruncated` / `outputsTruncated` 语义窄化为纯「条目/段数超上限被丢弃」，**不再包含**「单条正文被 4KB 截断」（后者改由 client 基于筛选后可见集合判定，见下）；
> 2. 段预算淘汰方向由「保留最早」改为**保留最新**（否则最终答复判定在超长会话上失效）；
> 3. 空文本 `assistant/message` 不再产出段（它无资格成为最终答复，且对 UI 零贡献）。

- **截断横幅修复**：横幅分两类——全局类（条目/参考/段数超上限、子会话降级）只在「全部 Agent」视图显示；可见类（单条正文超 4KB 被截断）由 client 基于筛选后可见集合重算，任何视图都跟随。二者与栏头计数、渲染共用 `src/client/selectors.ts` 产出的同一份可见集合。
- **过程段预览裁剪**：过程段正文按 `PROCESS_PREVIEW_BYTES = 320` 字节裁剪（独立字段 `previewOnly`，**不参与 budgets**），全文经 `output-text?id=` 按 id 拉取。
- **委派兜底**：子会话 degraded / 未扫描时，从父会话 `subagent` 工具的 `tool/call.arguments` 提取委派指令，严格四条门控（仅降级启用 / `subagent/start.id` 精确相等 / 工具名或形状匹配 / 有歧义则全部放弃），条目带 `provisional` 标记，UI 以次要样式呈现。

## 开发

```bash
pnpm install     # 需先按基座 workspace 惯例挂载（node_modules 内 @deepseek-ai/* 指向基座包）
pnpm bundle      # tsdown 双面构建 + tsc types
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

日常循环：**改 `src/` → `pnpm bundle` → 重启 `dsh web` 生效**。以上述本地目录形式安装时无需重新 `add`，rebuild 出的 `lib/` 就是 profile 在用的那一份。

> 若 `pnpm bundle` 的 clean 步骤被环境的批量删除保护拦下，可用 `npx tsdown --no-clean` 等价替代。

## 测试

```bash
pnpm vitest run   # 249 个用例（14 个 spec）：工程师 4 组 + QA 独立验证 6 组 + v1.1 新增 4 组（final-answer / input-groups / delegation-fallback / selectors）

测试夹具固定落在项目内 `.tmp/`（`.gitignore` 已覆盖），不用 `os.tmpdir()`：
macOS 上后者在 `/var/folders`，收尾的递归删除会被环境批量删除保护拦下，
且该保护按整轮累计删除数计（阈值 50），反复跑必然触顶——与代码无关的误报。
需要换落点时用 `DSH_CONTEXT_TMP` 覆盖。
```
