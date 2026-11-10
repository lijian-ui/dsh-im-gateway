# @lijian-ui/dsh-im-gateway

[English](./README.en.md) | 简体中文

> 为 **DeepSeek Harness (dsh)** 提供多 IM 通道接入的网关插件：钉钉 / QQ / 个人微信 / 飞书 / 企业微信，支持扫码绑定、流式回复、工具审批、交互提问、长文本分片、多段合并、双语界面。

[![npm version](https://img.shields.io/npm/v/@lijian-ui/dsh-im-gateway)](https://www.npmjs.com/package/@lijian-ui/dsh-im-gateway)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## 功能特性

### 通道与核心

- **统一网关服务** — 一个插件、五个通道。所有通道都汇聚到单一的 `ctx.imGateway` 核心：会话管理、斜杠命令、流式回复、状态广播。
- **钉钉** — 出站 WebSocket 长连接，群聊 + 单聊，@ 提及过滤，**AI 卡片流式输出**（实时增量回复），斜杠命令。
- **QQ** — WebSocket 网关（官方 `qqbot-nodejs` SDK），私聊（c2c）+ 群聊，**扫码绑定机器人**（免去开放平台手动创建），**流式消息**（c2c）。
- **个人微信（iLink）** — 官方 iLink 长轮询协议，**扫码登录 + 配对码**，仅单聊，媒体（AES-128-ECB CDN）收发。
- **飞书 / Lark** — 官方 `@larksuiteoapi/node-sdk` 长连接（无需公网回调），**扫码一键创建应用**（权限与会话事件自动预填），私聊 + 群聊，**CardKit 卡片流式输出**，图片/文件收发。
- **企业微信** — 官方智能机器人 WebSocket 长连接（无需公网回调、无需消息加解密），**扫码一键创建机器人**，私聊 + 群聊，**原生流式气泡**（`replyStream` 原位替换，官方原生能力），图片/文件/语音收发。
- **多机器人实例** — 同一通道类型可配置多个实例（例如两个钉钉机器人），各自独立凭据。
- **设置页 UI** — 在官方 dsh web UI 内渲染完整的设置页（「IM 通道」），扫码绑定就在这里完成。
- **流式回复** — 钉钉 AI 卡片、QQ stream_messages、飞书 CardKit 卡片、企业微信流式气泡；渠道不支持流式时自动回退纯文本。
- **单例锁** — 通过 `DSH_HOME` 文件锁防止多个实例并发写坏 session log。

### 交互增强

- **工具审批桥** — agent 调用需要审批的工具时，在 IM 里直接回复「批准」或「拒绝」即可放行/拦截，超时自动委托回 dsh 原生审批体系。
- **交互提问桥** — agent 调用 `ask_user_question` 时，问题同步推送到 IM，用户回复选项编号/文字即可作答，与 Web 端竞速第一答生效。
- **长回复分片** — 超过渠道单条上限的回复自动按句号/换行切分，带 `（1/3）` 分段前缀，逐条发送。
- **多段输入合并** — 用户连续发多条消息时自动合并为一条（可配超时窗口）；`..` 续传合并、`!!` 立即提交。
- **文件发送工具** — agent 可调用 `im_send_file` 工具把工作区文件（图片/视频/文档）直接发送到当前 IM 会话。
- **入站图片** — 用户在微信/飞书发来的图片会注册成 dsh 附件（`{ type: 'image', attachment }`）随消息一起交给模型；宿主没有 `attachments` 服务、单张超过 10MB 或注册超时会退化为「[图片]」文本，不会丢消息。
- **双语界面** — 配置 `language: 'zh' | 'en'` 切换所有用户可见回复的语言。

### 会话管理

- **内置斜杠命令** — `/help`、`/model`、`/status`、`/new`、`/reset`、`/stop`、`/sessions`、`/continue`、`/workspaces`、`/workspace`（见下文）。
- **会话列表与继续** — `/sessions` 列出最近会话（含标题），`/continue <id>` 恢复指定会话。
- **会话标题带通道标识** — 来自 IM 的会话在 dsh 会话列表中自动显示为 `[机器人名] 智能标题`，一眼分辨会话来自哪个通道（机器人名取通道实例的 `name`，未填则回落到通道类型名）。标题沿用 dsh 官方生成的智能标题，只在前面加前缀；在 Web 端手动重命名后不再自动覆盖。
- **工作区管理** — `/workspaces` 列出所有工作区及会话数，`/workspace <路径>` 切换工作区（自动重置当前会话，下次消息在新工作区创建新会话）。
- **用户白名单** — 配置 `allowAllUsers` 或 `allowedUserIds` 精确控制谁可以使用机器人。

---

## 安装

需要 DeepSeek Harness (dsh)——本插件是标准 **dsh bundle**，通过官方插件通道安装。

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add @lijian-ui/dsh-im-gateway
```

npm 包自带预构建的 `lib/` — **无需构建授权**（不需要 `allowBuilds`）。

### 从 tarball 安装

```bash
npm pack @lijian-ui/dsh-im-gateway
dsh plugin --profile web add ./dsh-im-gateway-0.1.1.tgz
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:lijian-ui/dsh-im-gateway
```

> Git 安装拉取的是**源码**，首次安装需要批准包的 `prepare` 构建脚本（pnpm ≥ 10）。按提示把包键加进 profile 的 `pnpm-workspace.yaml` → `allowBuilds` 即可。优先用 npm / tarball 方式可跳过此步。

### 验证安装

```bash
dsh --profile web --dump-config     # 应看到 "# == @lijian-ui/dsh-im-gateway" 配置层
dsh --profile web                   # 启动后浏览器打开设置 → 「IM 通道」
```

---

## 快速上手

1. 打开 dsh web UI → **设置 → IM 通道**。
2. 点击**添加通道**。
3. 选择通道类型：
   - **QQ**：点击**扫码登录** → 手机 QQ 扫码 → 凭据自动填入 → 保存。
   - **个人微信**：点击**扫码登录** → 手机微信扫码 →（如要求则输入配对码）→ 凭据自动填入 → 保存。
   - **钉钉**：点击**扫码登录**由钉钉自动创建机器人，或手动填写 AppKey / AppSecret → 保存。
   - **飞书 / Lark**：点击**扫码登录** → 飞书 App 扫码一键创建应用（权限与会话事件已预填），或手动填写 App ID / App Secret → 保存。
   - **企业微信**：点击**扫码登录** → 企业微信扫码一键创建智能机器人，或手动填写 Bot ID / Secret → 保存。
4. 在 IM 客户端给机器人发消息 — 回复实时流式返回。

> 配置存储在 `~/.dsh/settings.yaml`（`im-gateway.channels`）。在 UI 保存配置会**热重载**通道（无需重启）。

---

## 斜杠命令

在任何 IM 通道里发给机器人：

| 命令 | 说明 |
| --- | --- |
| `/help` | 列出可用命令 |
| `/model` | 用 emoji 编号列出模型；`/model 1` 或 `/model <名称>` 切换（无会话时 → 设为下次会话默认模型） |
| `/status` | 通道 / cwd / 当前模型 / agent 状态 |
| `/new` `/reset` `/clear` | 开启全新会话 |
| `/stop` | 中止当前回复 |
| `/sessions` | 列出最近 10 个会话（标记当前会话，显示标题） |
| `/continue <会话id>` | 继续指定会话（用 `/sessions` 查看可用 id） |
| `/workspaces` | 列出所有工作区（按最近活动排序，显示会话数） |
| `/workspace <路径>` | 切换到指定工作区（重置当前会话，下次消息在新工作区创建新会话） |
| `/workspace` | 不带参数时等同于 `/workspaces` |

### 多段输入控制后缀

| 后缀 | 说明 |
| --- | --- |
| （无） | 进入合并窗口，等待后续消息（默认 3 秒超时后自动提交） |
| `..` | 续传合并：把本条加入缓冲，继续等待 |
| `!!` | 立即提交：把缓冲 + 本条合并后马上发给 agent |

### 审批回复

当 agent 调用需要审批的工具时，直接回复：

| 回复 | 效果 |
| --- | --- |
| `批准` / `同意` / `yes` / `y` / `allow` | 放行工具执行 |
| `拒绝` / `no` / `n` / `reject` / `deny` | 拦截工具执行 |

超时后自动委托回 dsh 原生审批体系。

---

## 配置

所有配置都可在设置页编辑；底层 schema 在 `~/.dsh/settings.yaml`：

```yaml
im-gateway:
  language: zh                    # 界面语言：zh（中文）| en（英文）
  approvalTimeoutSecs: 120        # 工具审批超时（秒）
  questionTimeoutSecs: 600        # 交互提问超时（秒）
  mergeTimeoutSecs: 3             # 多段输入合并窗口（秒）
  allowAllUsers: false            # 全局放行所有用户（仅开发用）
  allowedUserIds:                 # 白名单：{ channelId: string[] } 或用 '*' 匹配任意渠道
    "*":
      - user-abc
  channels:
    - id: dingtalk-main
      type: dingtalk
      name: 主机器人
      enabled: true
      config:
        clientId: "..."
        clientSecret: "..."
        # 其余字段按通道类型取用：callbackBaseUrl / appId / botAppId / baseUrl /
        # botId / cdnBaseUrl / pollIntervalMs / domain（飞书）/ secret（企业微信）/
        # groupPolicy / groupAllowFrom / groups
```

### 网关级配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `language` | `zh` | 界面语言（`zh` 中文 / `en` 英文），影响所有用户可见回复 |
| `streamThrottleMs` | `800` | 流式推送节流间隔（毫秒） |
| `slashCommands` | `true` | 是否启用斜杠命令 |
| `approvalTimeoutSecs` | `120` | 工具审批 IM 等待超时（秒），超时后委托回 dsh 原生审批 |
| `questionTimeoutSecs` | `600` | 交互提问 IM 等待超时（秒），超时后转回 Web 端 |
| `mergeTimeoutSecs` | `3` | 多段输入合并窗口（秒），用户连续发消息时合并为一条 |
| `allowAllUsers` | `false` | 全局放行所有用户（仅开发用，生产环境勿开） |
| `allowedUserIds` | `{}` | 白名单；key 为 channelId（`*` 匹配任意），value 为用户 ID 数组 |

### 通道级配置

| 字段 | 适用渠道 | 含义 |
| --- | --- | --- |
| `clientId` / `clientSecret` | dingtalk | 钉钉应用 key / secret（Stream 模式） |
| `appId` / `clientSecret` | qq | QQ 开放平台凭据（扫码绑定所得） |
| `token` / `botId` / `baseUrl` / `cdnBaseUrl` | weixin | iLink 凭据（扫码绑定所得） |
| `appId` / `clientSecret` / `domain` | feishu | 飞书 / Lark 应用凭据（扫码创建所得）；`domain`：`feishu`（中国版）或 `lark`（国际版） |
| `botId` / `secret` | wecom | 企业微信智能机器人 BotID + 长连接专用密钥（扫码创建所得） |
| `groupPolicy` / `groupAllowFrom` / `groups` | qq · feishu · wecom | 群消息策略：`open` 全响应 / `allowlist` 白名单 / `disabled` 不响应 |
| `enabled` | 全部 | 该实例是否连接 |

---

## 架构

```
IM 客户端 ──► 通道适配器 (dingtalk / qq / weixin / feishu / wecom)
                   │  ImInboundMessage
                   ▼
             ctx.imGateway（核心）
                   │  多段合并 → 白名单检查 → 审批/提问拦截 → 斜杠命令
                   │  ensureSession → agent.followup
                   ▼
            dsh harness agent（LLM 循环）
                   │  会话事件 (turn/start, assistant/message, tool/call, turn/end)
                   │  实时流   (agent/assistant-stream: text-delta 增量)
                   ▼
        EventDispatcher → 流式回复 / 分片 / 工具提示
                   │  (AI 卡片 / stream_messages / 纯文本回退)
                   ▼
                IM 客户端
```

### 模块结构

| 模块 | 职责 |
| --- | --- |
| `im-gateway.ts` | 核心服务 ImGatewayService：会话管理、消息路由、工具注册 |
| `events.ts` | EventDispatcher：SessionEvent → IM 渠道操作（流式、分片、工具提示） |
| `session-title.ts` | prefixSessionTitle：给 IM 会话标题加 `[机器人名] ` 前缀（走官方 sessionTitle.rename） |
| `commands.ts` | CommandHandler：斜杠命令处理（/help /reset /model /status /stop /sessions /continue /workspaces /workspace） |
| `stream.ts` | StreamThrottle：流式节流器，攒批 text-delta 后按间隔推送 |
| `approval.ts` | ApprovalBroker：工具审批桥，挂起 approval/request 等待 IM 回复 |
| `questions.ts` | QuestionBroker：交互提问桥，挂起 ask_user_question 等待 IM 回复 |
| `split.ts` | splitText：长文本分片，按句号/换行切分，带分段前缀 |
| `merge.ts` | SessionMerger：多段输入合并，支持 `..` / `!!` 控制后缀 |
| `i18n.ts` | Translator：中英文双语翻译表 |
| `instance-lock.ts` | acquireInstanceLock：DSH_HOME 文件锁，防止并发写坏 session log |
| `types.ts` | 接口定义：ImChannelAdapter、ImGatewayConfig、ImGateway 等 |

- **Host 半**（node）：`src/index.ts`（apply）、`src/gateway/`（核心 + 上述模块）、`src/channels/`（dingtalk / qq / weixin / feishu / wecom + 协议助手）、`src/remote.ts`（设置页的 Typert RPC）、`src/sync.ts`（保存配置后热重载通道）。
- **Client 半**（浏览器）：`src/client/` — 设置页「IM 通道」（添加/编辑弹窗 + 扫码登录 + 状态点）。
- **多机器人**：`channels` 是数组，同一 `type` 可多次出现。

### 扩展点

第三方可以不 fork 直接注册自己的通道：

```ts
import { ImChannelAdapter } from '@lijian-ui/dsh-im-gateway'   // peerDependency 引用核心

class MyChannelAdapter implements ImChannelAdapter { /* ... */ }
ctx.imGateway.registerChannel(myAdapter)
```

`ImChannelAdapter` 接口可选方法：

| 方法 | 说明 |
| --- | --- |
| `sendText(convId, text)` | **必需**。发送纯文本消息 |
| `sendMedia(convId, filePath, caption?)` | 可选。发送文件/图片/视频（im_send_file 工具使用） |
| `beginStream(convId)` | 可选。开启流式回复（首个文本增量时调用） |
| `streamText(convId, text)` | 可选。流式覆盖更新（节流推送） |
| `endStream(convId, fullText)` | 可选。结束流式回复（turn/end 时调用） |
| `updateCard(convId, text)` | 可选。遗留单次卡片更新 |
| `authorizes(userId)` | 可选。渠道本地授权检查（返回 false 拦截） |
| `maxMessageChars` | 可选。单条消息字符上限（默认 4000，用于分片） |
| `label` | 可选。渠道显示名称（用于提问回执） |

---

## 开发

```bash
git clone https://github.com/lijian-ui/dsh-im-gateway.git
cd dsh-im-gateway
npm install
npm run build          # tsdown → lib/
npm run watch          # 保存自动重编译
npm run typecheck
npm test               # node --test tests/*.test.mjs
```

本地 link 进 dsh profile：

```bash
dsh plugin --profile web add ./   # 从本目录安装（link）
```

> **Windows 注意**：dsh 子进程从 `package.json` 的 `main` 加载 `lib/index.js` — 修改 `src/` 后必须 `npm run build` 再重启 dsh 进程（它的 require 缓存会保留旧模块）。

### 测试

测试使用 Node.js 内置测试运行器（`node:test`），位于 `tests/` 目录：

| 测试文件 | 覆盖模块 | 测试数 |
| --- | --- | --- |
| `approval.test.mjs` | ApprovalBroker | 8 |
| `questions.test.mjs` | QuestionBroker + parseQuestionReply + formatQuestionPrompt | 8 |
| `split.test.mjs` | splitText | 8 |
| `merge.test.mjs` | SessionMerger + stripControlSuffix | 9 |

---

## 常见问题

- **插件没有任何日志** — cordis 默认把 `ctx.logger.*` 缓存进内存。本插件在 apply 时注册了 console exporter，日志会出现在 dsh 子进程 stderr（桌面壳会加 `[dsh]` 前缀）。
- **QQ 客户端一直显示「连接中」** — 流式开得太早或没收干净。本插件在**第一个文本增量**时才开流，并在 `turn/end` 无条件收流（0.1.x 已修复）。
- **能对话但不流式** — 渠道回退到了纯文本（例如 QQ 群聊不支持 `stream_messages`；微信本身没有流式概念）。这是设计行为。
- **回复被截断成多条** — 超过渠道 `maxMessageChars` 上限时自动分片，带 `（1/3）` 前缀。这是设计行为，不是 bug。
- **多段消息被合并了** — 默认 3 秒合并窗口内连续发的消息会合并为一条。发 `!!` 立即提交，或调大 `mergeTimeoutSecs`。
- **审批/提问超时了** — 调大 `approvalTimeoutSecs` / `questionTimeoutSecs`。超时后会自动委托回 Web 端。
- **切换英文后部分文本仍是中文** — `formatAnswerSummary` 中的分隔符（`、` `；`）和 `（空）` 目前固定中文，因为它们是格式符号而非自然语言。

---

## 许可

MIT © lijian-ui

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建 — 独立插件，与 DeepSeek 无隶属或背书关系。
