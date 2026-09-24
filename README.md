# 手动上下文编辑器（manual-context）

DeepSeek Harness 插件。它做两件事：

1. **手动上下文自动注入** —— 自动检测「手动上下文」文件夹里的内容，
   每次对话前对照当前上下文，把**尚未出现**的条目插入到「用户本轮输入」之前、历史上下文之后。
2. **对话历史编辑** —— 在 Web 里直接编辑历史对话（系统提示词 / 用户输入 / 模型输出 / 工具调用输入输出），
   修改状态按会话保存，压缩上下文后依然保留。
3. **上下文重排** —— 拖动历史消息卡片改变模型看到的上下文顺序；一条消息里的思维链 / 正文 /
   工具调用 / 工具返回会拆成独立片段，可以分别编辑或删除。

入口在**左侧侧边栏底部**（「✎ 上下文编辑」），没有会话时也一直可见；有会话时标题栏里也会出现同一个入口。
从侧边栏打开时面板会在顶部列出宿主里的会话供你选择。

## 1. 手动上下文文件夹

默认扫描两个位置（都会自动创建）：

| 顺序 | 位置 | 用途 |
| --- | --- | --- |
| 1 | `<会话工作区>/manual-context` | 随项目走的上下文 |
| 2 | `$DSH_HOME/manual-context`（本机为 `$DSH_HOME\manual-context`） | 全局上下文 |

也可以用环境变量 `DSH_MANUAL_CONTEXT_DIRS` 覆盖（分号分隔的绝对路径）。

文件夹里每个 `*.md` / `*.txt` 文件是一个条目，文件名即标题。

### 新建位置

面板左上角的下拉框决定新条目写进哪个根目录：

| 选项 | 实际路径 | 作用范围 |
| --- | --- | --- |
| 项目（当前工作区） | `<会话工作区>/manual-context` | 只对该项目生效 |
| 全局（DSH 根目录） | `$DSH_HOME/manual-context` | 对所有项目生效 |

也可以不经 UI，直接把 `.md` / `.txt` 文件丢进这两个目录，下次对话前就会被扫描到。

新建时可以直接选**注入类型**（用户输入 / 模型输出 / 工具调用 / 工具返回），
它会写进文件头部的 frontmatter；API 上就是 `create-file` 的 `role` 字段。

### 注入类型（role）

每个条目可以在文件头部用 frontmatter 声明它注入成**什么类型的消息**，默认是「用户输入」：

```markdown
---
role: assistant
---
我已经检查过配置文件，没有问题。
```

| role | 注入方式 | 模型看到的角色 |
| --- | --- | --- |
| `user`（默认） | 写一条 `user/message` 节点（**只注入正文本身**，不带文件名与插件标记） | user |
| `assistant` | 写一条 `assistant/message` 节点 | **assistant** |
| `tool-call` | 写一条内嵌 `tool-call` 块的 `assistant/message` | **assistant** |
| `tool-result` | 写一条 `tool/result`（与前面的 tool-call 配对） | tool（v3 会话是 user） |

所有类型现在都**真正写进会话日志**，成为 surface 上的普通消息节点，因此可以像历史消息一样被编辑、
删除、拖动重排 —— 与「对话历史」标签页用的是同一套机制。

可用字段：

| 字段 | 适用 role | 说明 |
| --- | --- | --- |
| `role` | 全部 | `user` / `assistant` / `tool-call` / `tool-result` |
| `tool` | tool-call | 工具名，默认 `manual_tool` |
| `args` | tool-call | 工具参数，JSON 字符串 |
| `callId` | tool-call / tool-result | 省略时自动生成；tool-result 省略则按条目顺序与前面最近的未配对 tool-call 配对 |
| `isError` | tool-result | `true` 时标记为失败的工具结果 |
| `enabled` | 全部 | `false` 表示**不参与注入**（条目留在文件夹里但不会进上下文）；也接受 `disabled: true` |
| `weight` | 全部 | **注入权重**，默认 0。`<= 0` 排在系统提示词下方；`> 0` 排在正常对话的最后面，权重越大越靠前 |

surface 只认 `system/message` / `user/message` / `assistant/message` / `tool/result` 四种消息事件，
所以非 user 类型必须真正写进会话日志；追加发生在 pre-step 之后、本轮用户输入写入之前，
于是模型看到的顺序是「历史上下文 → 模拟的工具/模型消息 → 本轮用户输入」。

在 UI 里选中条目后，用文件名旁边的下拉框即可切换类型，保存时会写回 frontmatter。

### 片段编辑（默认视图）

选中条目后，右栏默认是 **片段** 视图 —— 一个 `.md` 文件按段标记拆成若干「片段」，
像「对话历史」那样逐段处理：

| 控件 | 作用 |
| --- | --- |
| 左下拉「文件」 | 选 `.md` 文件（与左侧列表联动，条目名后面括注片段数） |
| 右下拉「片段」 | 选这个文件里的某一段，选项显示 `#序号 · 角色 · 工具名 — 前 26 字` |
| 片段条 | 与「对话历史」的片段行同一套样式，列出全部片段，点一行即可切换 |
| 「该片段注入为」 | 这一段落地成什么角色（用户输入 / 模型输出 / 思维链 / 工具调用 / 工具返回） |
| 拖动片段行 | 直接拖到目标位置即可重排（写回文件，文件里的顺序就是注入顺序） |
| 上移 / 下移 | 与相邻片段交换位置，键盘/无鼠标场景的等价操作 |
| ＋ 新增片段 | 在当前片段下方插入一个空片段：带上段标记，写盘后不会和上一段黏在一起 |
| 删除片段 | 删掉当前片段（至少保留一段） |
| 保存片段 | 只把当前片段的正文与角色写回文件 |

片段之间靠 `<!-- role: xxx -->` 这类标记行分隔 —— **标记行就是分界点**：
删掉标记行，两段就并成一段；在正文里写一行标记，就等于再拆一段。
宿主侧的 `segmentsToBody` 与 `parseSegments` 严格对称，所以「解析 → 重组」是幂等的。

#### 片段会自动合并成一条消息

连续的「思维链 / 模型输出 / 工具调用」片段会合并成**一条** `assistant` 消息，
内容块依次是 `reasoning` → `text` → `tool-call` —— 这正是真实回复的形状
（一段思维链 + 一段正文 + 一个工具调用本来就属于同一条 assistant 消息）。
片段行上带 **「合」** 标记的即为同一组，拖动改顺序后合并组会跟着重算。

| 片段角色 | 落地成什么 |
| --- | --- |
| 思维链 / 模型输出 / 工具调用（连续） | **一条** `assistant/message`，多内容块 |
| 用户输入 | 独立的 `user/message`，会把合并组切开 |
| 工具返回 | 独立的 `tool/result`（v4 是 `role:'tool'` 的一等消息），同样切开合并组 |

所以：把思维链、正文、工具调用按顺序排在一起，模型看到的就是一条带 reasoning 块与 tool-call 块的消息；
中间夹一个用户输入，它就变成两条。

### 整篇视图（文本 / JSON）

右上角切到 **整篇** 后，可以直接改文件原文，编辑框上方在 **文本** 与 **JSON** 之间切换：

| 方式 | 编辑内容 |
| --- | --- |
| 文本 | 整个文件（含 frontmatter），改完由宿主按 `role` 同步 |
| JSON | 结构化字段，保存时由宿主组装 frontmatter |

JSON 模式的形状：

```json
{
  "role": "tool-call",
  "tool": "read_file",
  "args": "{\"path\":\"config.json\"}",
  "callId": "",
  "isError": false,
  "body": "我来读取配置文件"
}
```

- `role` 为 `user`、`isError` 为 `false`、空字符串都会被省略，写出的文件与文本模式完全一致；
- frontmatter 键**大小写不敏感**：`callId` / `callid` / `CALL_ID` 解析后都归一成 `callId`；
- JSON 解析失败或顶层不是对象时会在面板报错，不写文件。

### 一个文件里混排多种角色（段标记）

文件正文可以用 \`<!-- role: xxx -->\` 切成多段，每段各自决定角色：

\`\`\`markdown
这段没有标记，继承 frontmatter 的 role

<!-- role: user -->
请始终用中文回答

<!-- role: assistant -->
好的，我会用中文。

<!-- role: tool-call -->
<!-- tool: read_file -->
<!-- args: {"path":"config.json"} -->
我来读取配置文件

<!-- role: tool-result -->
{"port": 3080}
\`\`\`

规则：

- 连续的多行标记组成一个「段头」，其后到下一个段头之间的正文属于该段；
- 段头里可以写 \`role\` / \`tool\` / \`args\` / \`callId\` / \`isError\`，**段标记优先，其次继承文件级 frontmatter**；
- 没有任何标记时整篇就是一段，老写法完全兼容；
- 整篇视图的编辑框上方有五个按钮（用户输入 / 模型输出 / 思维链 / 工具调用 / 工具返回），会在**光标处**插入对应的 \`<!-- role: xxx -->\`；
  片段视图不必手写标记：用「＋ 新增片段」分段、用角色下拉选类型即可。

注入时按段展开：同一个文件里 user 段会合并成一条 user 消息，
其余段各自落地成对应角色的真实消息。实例：

\`\`\`text
user      │ 看看配置
assistant │ 好的，我会用中文。                        ← <!-- role: assistant -->
assistant │ 我来读取配置文件 + [tool-call read_file]   ← <!-- role: tool-call -->
user      │ [tool-result manual-call-…]                ← <!-- role: tool-result -->
user      │ 请始终用中文回答                            ← 两个 user 段合成
user      │ 看看配置                                    ← 本轮真实输入
\`\`\`

### 注入时机与去重

- 只在每个 turn 的**第一个 step**（`agent/pre-step`）排队一次同步，真正写入发生在
  `agent/request`（step 已经打开、请求组装之前）—— 否则会写出 v4 无法接受的日志。
- 判断依据是会话当前的**模型可见历史**：消息 `id` 等于 `manual-context:r2:<条目 hash>[:<段号>]`
  的节点就是该条目的同步结果；内容变了（hash 变）就等于旧节点作废、新节点写入。
- **同步是幂等的**：条目没动就不写任何事件；条目被停用或删除，对应节点会被空 system 消息遮蔽掉。
- 位置：`weight <= 0` 的条目排在系统提示词正下方，`weight > 0` 的排在对话末尾（权重降序）。
  需要插到系统提示词下方、而对话又已经很长时，会走一次「遮蔽 + 重放」式重排（超过 300 条会放弃并记录警告）。
- 面板上的 **「同步到会话」** 按钮可以立即触发一次同步；写不进去的部分会自动排队，下一轮请求自动应用。
- **什么时候能立即注入**（实测结论，2026-09 校准）：

  | 会话格式 | 空闲时（上一次对话已结束 / 新建还没说话） | 依据 |
  | --- | --- | --- |
  | **v4**（dsh 0.1.7 起新建的会话） | **可以直接写入**，模型输出 / 思维链 / 工具调用都能写 | v4 的加载校验（迁移 + surface 折叠 + 存储校验）**不检查** turn 关系；实测 turn 外的 `user/message`、多块 `assistant/message`、遮蔽节点、`tool/result` 全部通过 |
  | **v0–v3**（升级前的老会话） | 只有 `user/message` 能立即写，其余排队等下一轮 | v3→v4 迁移器要求 `system/message`、`assistant/message`、`tool/call` 匹配**开放 turn + step**，写进去会让会话打不开 |

  空闲时写的 `assistant/message` 用**日志里最后一次出现的 turn/step** 当坐标（v4 不校验，只影响面板上的步骤归属）。
- **新建对话、还没发第一句话时就能注入**：系统提示词走 `request/header` 事件、**不是** surface 节点，
  所以注入的上下文天然占据 surface 最前面 —— 也就是排在你的第一句话之前。

### 注入总开关

面板上的「注入：开 / 关」是一个**全局**开关（存在 `$DSH_HOME/manual-context/settings.json`）：

- **开**：按上面的规则正常注入，也可以随时点「同步到会话」手动触发一次。
- **关**：不再写入新内容，并且**把已经注入的节点一并遮蔽掉** —— 否则"关了开关"只是不再新增，旧内容还留在模型的上下文里。切换开关时会顺手同步一次，不用再点「同步到会话」。

条目文件、编辑记录、待应用的队列都保留；重新打开开关再点一次「同步到会话」即可恢复。

### 单个条目的开关

**每个 `.md` 条目都能单独控制**，不用动总开关（存在文件 frontmatter 的 `enabled` 字段里）：

- 条目列表每一项左边有「注入中 / 已停用」开关，点一下切换。停用后**同步时它的节点会被移除**，文件本身保留、随时可以再打开。
- 多选模式下有「启用选中 / 停用选中」，可以一次处理多个条目。
- 也可以直接写 frontmatter：`enabled: false`（或 `disabled: true`）表示停用，`enabled: true` / `1` / `yes` / `on` 表示启用，**删掉该行即恢复默认（启用）**。

它和上面的总开关是**相乘**的关系：总开关关掉时，不管条目开没开都不注入；总开关打开时，只有「注入中」的条目会被写进上下文。

## 2. 历史编辑

点击会话头部的 **「✎ 上下文编辑」** 按钮打开面板，第二个标签页列出当前模型可见的全部消息。

编辑一条消息时，插件追加一个**带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 的事件**，
遮蔽原节点 —— 这与 Harness 内置压缩使用完全相同的机制，因此：

- 模型之后的请求立即看到编辑后的内容；
- 编辑本身是会话日志的一部分，可被压缩、可被 replay；
- 不需要也不允许写入自定义的事件类型（外部插件事件无法通过持久化读取校验，会造成会话无法重建）。

**写入必须严格符合会话日志的形状规则**，否则重启后整个会话会打不开（详见下面的「会损坏会话的写法」）。

| 目标节点 | 写法 | 说明 |
| --- | --- | --- |
| 用户输入 | 同类型 `user/message` 原位替换 | role 保持 `user` |
| 工具输出 | 同类型 `tool/result` 原位替换 | role 保持 `user`，`toolCallId` 与 `source.callId` 都保留 |
| 系统提示词（非头部） | 同类型 `system/message` 原位替换 | source 必须是 `{kind:'plugin'}` |
| 模型输出 | **遮蔽原节点 + 尾部重放** | 位置与顺序都不变，只是这些节点换成了新 seq |
| 系统提示词（头部） | — | **不可改写**，见下 |

### 会损坏会话的写法（踩过的坑）

`dsh-session` 在**重启加载会话时**才执行 `assertMessageEventShape`：

| 事件类型 | message.role 必须 | 额外要求 |
| --- | --- | --- |
| `user/message` | `user` | source.kind 非空 |
| `assistant/message` | `assistant` | source 为 `model` + provider/model；data 有 turn/step/stream；**不能带 `sourceEventSeqs`** |
| `tool/result` | `user` | source 为 `tool` + callId；content 恰好一个 `tool-result` 块且 `toolCallId` 与之一致 |
| `system/message` | `system` | source 为 `plugin` |

运行时写一条不合规的事件**不会立刻报错**，但下次打开这个会话就是：

```
stored session "session-…" is corrupt: stored session "session-…" failed validation:
Error: session event at seq 21 message must have role "user"
```

已经写坏的会话可以用 [`tools/repair-sessions.mjs`](tools/repair-sessions.mjs) 原地修回来
（事件数量与 seq 都不变，只会让被遮蔽的原始内容重新可见，并留下一份 `.corrupt-bak` 备份）：

```powershell
node tools/repair-sessions.mjs "$env:DSH_HOME\sessions"
```

DSH 0.1.7 之后请改用 [`tools/repair-migration.mjs`](tools/repair-migration.mjs)：它覆盖上表的坏法，
还额外处理 v4 迁移的新拒绝（见下节）。先不带 `--apply` 是只扫描预览：

```powershell
node tools/repair-migration.mjs --apply "$env:DSH_HOME\sessions"
```

脚本能处理三类坏法：role 与事件类型不匹配、`turn`/`step` 不是正整数、
旧格式事件带了迁移器不认识的字段。修 role 时**保留原事件的 `surfaceOp` 与 `sourceEventSeqs`**，
只把消息换成内容为空的 user 消息 —— 既不投影任何消息，surface 拓扑也完全不变
（若改成 `append`，原本被遮蔽的节点会重新出现，后续 replace 就会报
`sourceEventSeqs must include every shadowed surface node`）。

落盘前会用 DSH 真实链路完整验证一遍：

| 关卡 | 要求 |
| --- | --- |
| 帧结构 | 会话日志是分帧 zstd，**第一帧必须恰好只装 header 那一行**；重写文件时若把 header 和事件压进同一帧，会得到 `corrupt Zstandard session log: first frame is not exactly one header line` |
| 迁移解码 | `createRestore` + `decodeRow` + `finish`（v0/v1/v2 会自动迁移到 v3） |
| surface fold | surface 折叠（`sourceEventSeqs` 必须覆盖被遮蔽的每个节点） |
| 形状校验 | `validateStoredEvents`（role / source / content / toolCallId 等） |

脚本因此**保留原有帧划分**，只重新压缩内容有变化的帧。

### 表面事件的 turn/step 约束（**只对 v0–v3 老会话生效**）

> **实测校准（重要）**：v4 会话**加载时不检查** turn 关系 —— turn 之外写
> `user/message`、多块 `assistant/message`、遮蔽节点、`tool/result` 全部能通过
> 迁移 + surface 折叠 + 存储校验（证据见 `tools/experiment-turn-gate.mjs`）。
> 下面的约束只在**会话仍是 v0–v3**、加载时要跑 v3→v4 迁移时才生效。
> 新建会话（0.1.7 起）一律是 v4，所以空闲、甚至还没发第一句话时都能直接注入。

v4 迁移器（`dsh-session-format-v3-to-v4`）对表面事件的要求：

| 事件 | 要求 |
| --- | --- |
| `system/message`、`developer/message`、`assistant/attempt`、`assistant/message`、`tool/call` | 必须匹配**开放**的 turn 与 step |
| `tool/result`（`surfaceOp:'append'`） | 匹配开放 step，并结算一个已声明的工具调用 |
| `tool/result`（`surfaceOp:{op:'replace'}`） | 只要求存在开放 turn |
| `user/message` | 无要求 |

面板在**空闲时**（上一次 `turn/end` 之后）编辑/拖动/删除，事件会借用原节点的 turn/step 坐标写进日志；
`dsh-session` 的 `append` 只做事件本地校验（其文档明写 "history relations are not checked"），
所以 v3 时代一直不报错。升级到 0.1.7 后这些会话就变成：

```
Session migration from v3 to v4 refuses the transformed artifact:
system/message does not match an open turn and step
```

`tools/repair-migration.mjs` 会把这类 **turn 外的表面事件降级为不透明可忽略事件**
`{type:'manual-context-orphan', ignorable:true}`：迁移器把它命名成 `plugin:manual-context-orphan`
并保留载荷与坐标，于是它不再参与关系校验。**事件 seq 与日志帧结构完全不变**（无需重编号），
代价是这一次编辑不再生效（节点回到编辑前的表面状态），原始内容与编辑记录都不会丢。

同一脚本还会就地改正「事件类型与消息角色不匹配」（`message must have role "user"`）——
只改 role 一个字段，内容与 surface 拓扑原样保留。

### 插件侧的生命周期守卫与排队

- 每次写日志前，插件都会读会话日志判断当前是否存在**开放的 turn/step**（`openCoordinates`）。
- **v4 会话不需要这个窗口**：空闲时直接写，坐标回退到日志里最后一次出现的 turn/step（见上一节的实测结论）。
- **v0–v3 老会话**必须有开放 turn/step：`user/message` 例外（任意时刻都能写），
  其余在空闲时抛 `SessionWritePendingError`。
- **同步逐条容错**：写不进去的片段记进 `deferred`，能写的（user 段）先写下去，
  再由 HTTP 层把这次同步排进队列（`$DSH_HOME/manual-context-edits/<sessionId>.queue.json`）。
  面板顶部会显示「⏳ 排队中：N 项改动等下一次对话开始时自动应用」——状态每 2.5 秒轮询刷新。
- `agent/request` 钩子（发生在 `step/start` 之后、请求组装之前）会取出队列，用**当前** turn/step 写入；
  目标已被压缩、内容已变化等则丢弃并记一条警告。`agent/pre-step` 不能当写入窗口
  —— 那时 step 还没打开。
- 非 user 的注入段（assistant / reasoning / tool-call / tool-result）同样走这条队列，
  排队时就把 tool 轨迹的 callId 定死，保证 tool-call 与 tool-result 严格配对。
- 重放 / 重排**工具轨迹**（`tool/result` 节点，或含 `tool-call` 块的消息）：
  - **v4 会话允许**（实测：遮蔽之后照原 callId 整组重放 tool-call / tool/result 都能通过加载校验）；
  - **v0–v3 老会话拒绝** —— 它们加载时要跑迁移器，`tool/call` 不是表面事件、不在 surface 上，
    重放表面节点时天然缺它，写出来就是打不开的日志。这类会话请改用「删除」。
- 事件来源统一写成 v4 的「生产者归属」`plugin:@dsh-external/manual-context`
  （v4 拒绝裸 `kind:'plugin'`，迁移器也会把 v3 的 plugin 来源提升成这个形状）；
  v4 会话里的 `tool/result` 写成一等 `role:'tool'` 消息，v3 会话仍是 user + tool-result 包装。

早期版本用 `user/message` 承载 `role:'assistant'` 的消息来做原位替换 —— 运行时看着正常，
重启后会话直接打不开。**现在插件每次写日志前都会自检**（`assertWritableEvent`），不合规就抛错，绝不落盘。

因为 `assistant/message` 做不了 surface 替换，改模型输出只能「遮蔽原节点 + 把这一段按原顺序重新追加」：
可见顺序完全一致，编辑过的那条换成新内容。尾部超过 300 条时会拒绝，
提示改用别的方式（避免一次编辑重写整段历史）。

> **为什么系统提示词改不了**：`agent-loop` 的 `SystemPromptProjection` 会在每次请求组装时
> 把 surface 头节点重新写回渲染结果，任何替换下一轮都会被覆盖。
> 面板里因此不再提供该按钮。想长期生效，请把手动上下文条目的 role 设为 `user`，它每轮都会注入。


### 一条消息里的片段（模型输出 ≠ 工具调用）

真实的模型输出经常把 **思维链 + 正文 + 一个或多个工具调用** 压在**同一条** assistant 消息里，
例如 `content` 同时含 `reasoning` / `text` / `tool-call` 三种块。

早期版本把这种消息整条当作「模型输出」，工具调用只能埋在正文里、无法单独操作；
工具返回的正文更是完全显示不出来 —— 它的文本藏在 `tool-result` 块**嵌套的** `content` 里
（`{ type:"tool-result", toolCallId, content:[{ type:"text", text }] }`），只扫顶层 `type === "text"` 会得到空串。
两处都已修好，现在列表按**片段**拆开显示：

| 片段 | 类别 | 编辑方式 | 删除 |
| --- | --- | --- | --- |
| `reasoning` | 思维链 | 纯文本 | 单独删 |
| `text` | 模型输出 / 用户输入 / 系统提示词 | 纯文本 | 单独删 |
| `tool-call` | 工具调用 | JSON（`type` / `id` / `name` / `arguments`） | 单独删 |
| `tool-result` | 工具返回 | 纯文本（写回嵌套的 `content`） | 单独删 |

- 每个片段行右侧有 **✎**（编辑该片段）与 **✕**（只删该片段）；
- 点片段行可以只查看该片段，详情页顶部有「整条 / 模型输出 1 / 工具调用 2 …」切换条；
- 编辑片段只改这一个块，同一条消息里的其他块原样保留（走 `save-edit` 的 `content` 数组通道）；
- 片段删到 `content` 为空时整条消息会被遮蔽掉，等于删除整条。

### 拖动改变上下文顺序

消息卡片左侧的 **⠿** 是拖动柄，拖到另一条消息上松开，就能调整它在**模型可见上下文**里的先后顺序。

surface 节点的顺序来自日志、改不了，所以插件走「遮蔽 + 重新追加」：

1. 先求目标顺序与原顺序的**最长公共前缀** —— 这一段原地不动；
2. 其余消息用空 `system/message` 遮蔽原节点（位置留空、不再投影消息）；
3. 再按目标顺序把它们的**副本** `append` 到末尾。

最终可见顺序 = 公共前缀（原位）+ 其余（目标顺序）。所有事件都在动日志之前构建完毕，
构建失败就整体放弃，不会擦一半留一半。系统提示词固定在 surface 第 0 位，不参与拖动。

> **注意**：重排会改变 `tool-call` 与 `tool-result` 的相邻关系。某些 provider 要求工具调用后面紧跟对应的工具结果，
> 顺序拖乱之后模型请求可能报错 —— 把顺序拖回去即可恢复。
### 两种编辑方式

编辑框上方可以在 **文本** 与 **JSON** 之间切换：

| 方式 | 内容 | 适合 |
| --- | --- | --- |
| 文本 | 消息的纯文本；工具调用等非文本块自动保留 | 改措辞 |
| JSON | 直接编辑 `content` blocks 数组 | 增删工具调用、改工具名与参数、构造精确结构 |

JSON 模式的 `content` 必须是数组，保存时按原样写入；角色与 source 仍然保持。
JSON 解析失败会在面板里直接报错，不会写入会话。

### 保持原位

替换会生成一个新节点（surface 用"遮蔽"而不是"删除"），但：

- 用户 / 工具 / 系统消息：新节点在 surface 里的**位置与原节点相同**，顺序不变；
- 模型输出：整段重放后**顺序也完全一致**（只是从那条开始往后的节点都换成了新 seq），
  面板会自动把选中项切到新的 seq 上；
- 面板保存后会自动把选中项切到新节点上（接口返回 `replacedSeq`），列表位置和选中状态都不跳。

### 删除消息

列表项右侧的 **✕** 可以把一条消息从模型可见上下文里移除；点工具栏的 **多选** 会出现复选框，
勾选后 **删除选中** 可批量删除。

实现上是用一条 **空内容的 `system/message`** 遮蔽目标节点 —— 空内容不会投影出任何消息
（`deriveEventMessage` 对空 content 返回 null），从而达到删除效果，且不破坏节点顺序。
surface 第 0 个系统提示词不允许删除。

想只删掉一条消息里的某个片段（例如只扔掉工具调用、留下正文），用片段行右侧的 ✕，
它会重写这条消息的 `content`，其余块不受影响。

手动上下文条目同样支持单条 ✕ 删除与多选批量删除。

### 思维链（reasoning）

模型输出的 \`reasoning\` 块与正文是分开的，面板会单独展示：

- 详情里显示「思维链（reasoning 块）」区块；
- 进入文本编辑态会多出一个思维链输入框，可以**单独改写**；
- **只改正文时思维链原样保留**（早期版本会把它丢掉，已修）；
- JSON 模式下 \`{"type":"reasoning","text":"…"}\` 就是普通块，可任意增删。

手动上下文侧，段标记支持 \`<!-- role: reasoning -->\`，注入成一条带 \`reasoning\` 块的 assistant 消息。

### 主对话流不会变（重要）

编辑通过 surface 遮蔽实现：新节点在 surface 里的**位置**与原节点相同，
但**主对话流的消息列表是按原始事件日志渲染的**，不应用 surface 遮蔽
（\`dsh-client-ui-conversation\` 只在重建系统提示词时读 surface）。

| 视图 | 看到的内容 |
| --- | --- |
| 主对话流 | 原始内容 |
| 本面板的历史列表 | **编辑后的内容**，也是模型实际看到的 |
| 模型请求 | **编辑后的内容** |

判断改动是否生效，以本面板和模型的实际回答为准，不要看主对话流。

### 修改状态保存位置

`$DSH_HOME/manual-context-edits/<会话ID>.json`

按会话保存，记录了每个被编辑节点的 `seq`、替换节点 `seq`、原类型与编辑后的文本。
面板上的「已编辑 / 清除标记」即读写这份档案，因此**压缩上下文后修改状态不会丢失**。

## 安装 / 启用

插件通过 profile 的 patch 层挂载：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: manual-context
      name: '@dsh-external/manual-context'
```

包名需要在 profile 的 `node_modules` 下可解析。本机用 junction 指向本目录：

```powershell
New-Item -ItemType Junction \
  -Path "$env:DSH_HOME\profiles\web\node_modules\@dsh-external\manual-context" \
  -Target "<插件目录>"
```

新增 bundle 需要**重启 dsh web** 才会进入客户端模块图。

## HTTP 接口

浏览器端通过同源路由 `/manual-context` 与宿主通信：

| 方法 | 参数 | 作用 |
| --- | --- | --- |
| GET | `?op=status&sessionId=` | 目录、条目列表、注入状态、编辑档案 |
| GET | `?op=file&sessionId=&id=` | 读取单个条目 |
| GET | `?op=history&sessionId=` | 当前模型可见的历史消息 |
| GET | `?op=export-session&sessionId=` | 导出当前对话（含手动上下文节点）为一份 JSON |
| POST | `{op:'save-file'}` / `{op:'create-file', root:0\|1}` / `{op:'delete-file'}` | 条目写操作（`root` 选根目录） |
| POST | `{op:'save-edit', seq, text?, content?, reasoning?, expectedText?}` | 编辑一条消息；传 `content` 数组可精确改写块（片段编辑走这条路） |
| POST | `{op:'delete-part', seq, index}` | 只删掉消息里的第 `index` 个片段（删空则整条遮蔽） |
| POST | `{op:'reorder-messages', order:[seq,…]}` | 按 `order` 重排模型可见历史（遮蔽 + 重新追加，返回 `replaced` 映射） |
| POST | `{op:'delete-messages', seqs}` / `{op:'forget-edit', seq}` / `{op:'clear-edits'}` | 批量删除与编辑档案维护 |
| POST | `{op:'append-message', kind, text, toolName?, toolInput?, callId?, isError?}` | 追加新消息（`kind`: user / assistant / tool-call / tool-result） |
| POST | `{op:'import-session', messages:[…]}` | 从导出的 JSON 导入对话，按 `message.id` 去重后**追加**到当前会话末尾 |
| POST | `{op:'sync-context'}` | 立即把手动上下文条目同步进会话（空闲时排队，下一轮请求自动应用） |
| POST | `{op:'save-segments', id, meta?, segments:[{meta,text},…]}` | 片段级保存：宿主用 `segmentsToBody` 把片段数组重组成正文写盘 |

## 排查

### 一键修复打不开的对话

面板上的「修复对话」按钮会扫描 `$DSH_HOME/sessions/**/*.jsonl.zstd`，把插件旧版写坏的**非法遮蔽事件**修好，并报告扫描 / 修复 / 跳过的数量。

判据很窄：`system/message` 事件的来源是 `plugin:@dsh-external/manual-context`（旧版用它做遮蔽节点，见下面「为什么会一片空白」）。修复只改这一个字段为 `system-prompt` —— 内容仍为空、位置与遮蔽关系完全不变，模型看到的内容不会有任何变化。原文件先备份成 `*.corrupt-bak`，正在运行的会话会跳过（免得和 dsh 内存里的日志打架）。

命令行等价物：[tools/fix-mask-events.mjs](tools/fix-mask-events.mjs)（先跑 dsh 真实加载校验确认失败，再动手）。

### 为什么会一片空白

对话点开后**一片空白、而且前后端都不报错**，通常是会话**加载**就失败了：

```
stored session "…" failed validation:
Error: session event at seq N message must have system-prompt source
```

插件删除 / 重排节点时会写一条空 `system/message` 把原节点遮蔽掉。这一步必须用 `system/message`（只有它能带 `sourceEventSeqs` 这个遮蔽标记，换成 `assistant/message` 会被拒绝：`assistant/message embeds its source stream and cannot carry sourceEventSeqs`），但**来源必须是 `system-prompt`**。旧版把来源写成了插件自己，于是整份日志校验失败 —— 一条不合格就让整个会话打不开。

新版本已经改成 `source: { kind: 'system-prompt' }`；同时排序不再搬动系统提示词节点（重放会改写它的来源，等于再写坏一次），若某次排序必须移动系统提示词就直接放弃。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板报 `Unexpected end of JSON input` | 宿主没注册路由，响应体为空 —— 通常是插件尚未加载，或 HTTP 服务名写错 | 见下：dsh 注册路由的服务叫 **`webServer`**；确认 patch 条目存在后重启 dsh web |
| 面板报 `宿主插件未挂载 /manual-context 路由（HTTP 404）` | 同上 | 同上 |
| 改了插件源码后页面文案更新了、接口仍 404 | **刷新页面只重读磁盘上的浏览器 bundle，宿主进程里的插件模块不会重载** | 必须重启 dsh web 进程（Ctrl+C 后重新运行），不是刷新页面 |
| 条目全部显示「未注入」 | 该会话没有工作区（`cwd`），只扫描到了 `$DSH_HOME/manual-context` | 在项目目录里开会话 |
| 编辑历史时提示「已被压缩」 | 目标节点已不在当前 surface 上 | 属预期：被压缩掉的消息无法再被替换 |
| 编辑模型输出时提示「需要重放整段历史」 | `assistant/message` 做不了 surface 替换，只能遮蔽 + 重放，而这一段超过 300 条 | 改更靠后的消息，或先删掉它再在末尾追加 |
| **重启后某个会话打不开**：`… message must have role "user"` | 旧版插件用 `user/message` 承载了 `role:'assistant'` 的消息（运行时看不出问题） | 已修复写入路径；坏掉的会话用 `node tools/repair-migration.mjs --apply` 原地修回来 |
| **升级到 dsh 0.1.7 后某个会话打不开**：`Session migration from v3 to v4 refuses the transformed artifact: system/message does not match an open turn and step` | 旧版插件在 `turn/end` 之后（面板空闲编辑）写入了借用旧坐标的表面事件，v3 不校验、v4 迁移直接拒绝 | 用 `node tools/repair-migration.mjs --apply` 修回；写入侧现在**按会话版本区分**：v4 空闲也允许写（实测安全），v0–v3 仍排队到 `agent/request` 窗口 |
| **升级 dsh / 用插件管理器装过别的插件后，面板入口整条消失**，日志里没有插件的 `已加载` 行 | 本插件是**手工 junction** 挂在 profile 的 `node_modules/@dsh-external/manual-context`；profile 用 pnpm（`nodeLinker: hoisted`），`pnpm install` 会 prune 掉不在 lockfile 里的顶层包，junction 就这样被清掉了（`cordis.patch.yml` 里的 insert 行还在） | 跑 `node tools/relink.mjs` 重建挂载，然后**重启 dsh** |
| 面板顶部出现「⏳ 排队中：N 项改动等下一次对话开始时自动应用」 | 会话是 **v4 之前**的旧格式，且现在没有开放的 turn/step | 预期行为：下一次给模型发消息时自动应用。**v4 会话（dsh 0.1.7 起新建的）不再排队，空闲也能直接注入** |
| 编辑/拖动时提示「含工具调用（tool-call）…已拒绝」 | 会话是 **v4 之前**的旧格式：重放会缺配套的 tool/call，写出来就是打不开的日志 | 预期行为：改用「删除」，或先把该会话用一次（打开并对话）让它升级成 v4 —— v4 会话可以正常编辑/重排工具轨迹 |

> **注意**：dsh 0.1.6 注册 HTTP 路由的服务名是 `ctx.webServer`（`@deepseek-ai/dsh-host-webserver`）。
> 代码里若写 `ctx.inject(['httpServer', …])`，回调永远不会执行且没有任何报错，表现为路由 404。

## 开发

无需构建步骤：宿主与浏览器端都是可直接运行的 ES 模块／CommonJS bundle。

```powershell
node --check src/index.js          # 逐文件语法检查
node --test tests/store.test.mjs tests/host.test.mjs tests/client.test.mjs
```

### 文件

| 文件 | 职责 |
| --- | --- |
| `src/index.js` | 插件入口，挂载注入钩子与 HTTP 路由 |
| `src/store.js` | 手动上下文文件夹的发现、创建与读写 |
| `src/inject.js` | `agent/pre-step` 注入 |
| `src/history.js` | surface 替换编辑、片段拆分与删除、消息重排，以及按会话的修改状态存储 |
| `src/http.js` | `/manual-context` 路由 |
| `src/client.js` | 浏览器端面板（`window.__ModuleLoader__` bundle） |
| `src/freeze.js` | 消息冻结与文本 / 思维链 / 工具调用 / 工具结果提取 |
| `tools/relink.mjs` | 把插件重新挂载进 dsh profile 的 `node_modules`（`pnpm install` 会 prune 掉手工 junction） |
| `tools/smoke-load.mjs` | 用 dsh 自带的 cordis 加载宿主插件，冒烟验证新版本 dsh 下的兼容性 |
| `tools/repair-migration.mjs` | 修复被 v4 迁移拒绝的历史会话日志（turn 外表面事件、消息角色不匹配） |
| [`docs/会话格式与手动上下文-经验总结.md`](docs/会话格式与手动上下文-经验总结.md) | v4 会话格式约束、坏日志修复、守卫与排队、四项新功能的完整经验总结 |
| `tools/repair-sessions.mjs` | 旧版修复脚本（role、turn/step 正整数、未知字段三类坏法） |
