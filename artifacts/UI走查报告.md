# dsh-coach 复盘页全屏 UI 走查报告

- **走查对象**：dsh-coach「复盘 / Coach」Tab
- **会话**：`session-068f8dac-8ffb-4b3a-b9c5-3fb8872b3840`（标题「跟我介绍下你的多智能体能力」，24 轮 / 103 步 / 236 次工具调用）
- **视口**：1280 × 960（Chromium headless，deviceScaleFactor=1，严格按像素度量）
- **走查方式**：Playwright 驱动真实渲染，逐抽屉点击截图 + `getComputedStyle` 实测
- **未改任何代码**，仅观察与度量

---

## 一、总体结论

| 项 | 结果 |
|---|---|
| 横向溢出（1280 视口） | ✅ 无（`documentElement.scrollWidth = 1280`） |
| 并排卡片等高 stretch | ✅ 生效（Subagents 卡 / Skill calls 卡实测均 362px） |
| 右抽屉右边框 / 全高 | ✅ 完整，贴右缘 1280 到顶到底 |
| 雷达图 / 每轮柱图 | ✅ 未拉伸变形 |
| 底部内容 padding | ✅ 滚到最底 R21 行完整可见，未被输入框吃掉 |
| 阻断性问题（P0） | 无 |

> 说明：桌面底部那条悬浮输入框（"Message or run a task…"）是宿主聊天栏，滚动时内容从其下方穿过属正常交互；实测滚到底时末行仍完整，故不计为缺陷。

---

## 二、问题清单（按严重程度排序）

### P0 — 阻断
无。

### P1 — 严重
无。

### P2 — 一般

**P2-1　时间线状态徽章未按规范「固定 56px 居中」，宽度随文字自适应、左对齐**
- 准则要求：状态徽章固定 56px、居中。
- 实测：`Initial task` 徽章宽 **74px**，`Follow-up` / `Correction` 约 64px，全部左对齐，各行徽章起点虽一致但宽度参差，谈不上「固定 56px 居中」。
- 度量：11px / `1px 8px` / 圆角 999px / nowrap（样式本身合规，仅宽度与对齐不符合规范）。
- 证据：`card_timeline.png`、`06_timeline.png`

**P2-2　Token 抽屉「输入构成」中 Tool calls 的比例条渲染为纯黑色**
- 抽屉 `Input composition` 里 `Tool calls 193,295` 一行的横向比例条呈**纯黑长条形**，与语义色（工具调用在主页图例里是绿色）不一致，看起来像异常/选中态，对比其余条目（无条/浅条）突兀。
- 证据：`02_token.png`（"Tool calls 193,295" 行的黑色长条）

**P2-3　R18 行左侧出现半透明「Intervention」幽灵徽章，与 Follow-up 重叠错位**
- 时间线 R18 左侧在实心 `Follow-up` 徽章上叠加了一个**半透明**的 `Intervention` 徽章，两者位置重叠、错位；同行右侧又有一个实心 `Intervention`。疑为重复渲染 / 悬浮态未清除。
- 证据：`07_bottom.png`（R18 行）

### P3 — 建议

**P3-1　总分卡「Fair」评级徽章样式未对齐徽章规范**
- 实测：字号 **12px**（规范 11px）、内边距 **2px 10px**（规范 `1px 8px`）、`white-space: normal`（其余徽章均 nowrap）。
- 证据：`01_main.png`（大 65 下方的蓝色 "Fair"）

**P3-2　文件树 ×1 / unused 徽章内边距差 1px**
- 实测：`×1`、`unused` 内边距为 `1px 7px`，与统一规范 `1px 8px` 差 1px，圆角/字号一致。
- 证据：`card_agents.png`（Reference analysis 列表右侧）

**P3-3　Skill 汇总卡右侧数字徽章宽度随内容变化，未对齐**
- `calls 3` = 51px、`ok 1` = 39px、`failed 2` = 56px，三个同行右对齐徽章宽度不一，视觉基线略跳；建议统一最小宽度或右对齐数字。
- 证据：`card_skills.png`（workflow 行右侧）

**P3-4　输入构成图例「数字+量词」紧贴，可读性略弱**
- `589字 21messages`、`193,295字 236calls` 中数字、量词、messages/calls 紧贴无间隔分隔，11px 下略挤。
- 证据：`card_token.png`（Input composition 图例行）

---

## 三、已走查项清单

- [x] 视口设定 1280 × 960，确认 `innerWidth/innerHeight = 1280/960`
- [x] 主页全屏截图 `01_main.png`
- [x] **Token 抽屉**（点 Token 总量 stat）截图 `02_token.png`
- [x] **上下文构成抽屉**（点图例 Tool calls）截图 `03_context.png`
- [x] **子智能体抽屉**（点 standard·ff8fd0 行）截图 `04_subagent.png`
- [x] **Skill 抽屉**（点 workflow 行）截图 `05_skill.png`
- [x] **时间线抽屉**（点 R1 轮次行）截图 `06_timeline.png`
- [x] 各卡片单独截图 `card_token.png` / `card_agents.png` / `card_skills.png` / `card_refs.png` / `card_artifacts.png` / `card_timeline.png`
- [x] 滚到底截图 `07_bottom.png`，确认末行未被遮挡
- [x] 卡片等高对齐：Subagents(362px) ≈ Skill calls(362px)，stretch 生效
- [x] 徽章不换行 / 不挤压：R12 同行 4 个徽章（Intervention/Correction/Refs 7/+1）单行容纳
- [x] 右抽屉右边框完整、全高到顶
- [x] 图表不变形：六维雷达、每轮 R1–R24 柱图比例正常
- [x] 全屏不溢出：`scrollWidth = 1280`，无横向滚动
- [x] 徽章规范抽查：时间线徽章 11px / `1px 8px` / 999px / 语义透明底（绿成功 / 红失败 / 橙干预）

---

## 四、证据截图索引

| 文件 | 内容 |
|---|---|
| `01_main.png` | 复盘主页全屏（评分卡 / 六维雷达 / 统计 / Token 柱图） |
| `02_token.png` | Token full breakdown 抽屉 |
| `03_context.png` | 上下文构成 · Tool calls 抽屉 |
| `04_subagent.png` | 子智能体 · standard·ff8fd0 抽屉 |
| `05_skill.png` | Skill · workflow 抽屉 |
| `06_timeline.png` | 时间线 · Turn detail R1 抽屉 |
| `07_bottom.png` | 滚到底（R9–R21，含 R18 幽灵徽章） |
| `card_token.png` | Token & 上下文构成卡 |
| `card_agents.png` | Subagents + Reference analysis 卡 |
| `card_skills.png` | Skill calls + Artifacts 卡 |
| `card_timeline.png` | Interaction timeline 卡 |
