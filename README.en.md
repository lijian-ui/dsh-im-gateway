# @lijian-ui/dsh-im-gateway

English | [简体中文](./README.md)

> A multi-channel IM gateway plugin for **DeepSeek Harness (dsh)** — connect DingTalk, QQ, WeChat (iLink), Feishu/Lark and WeCom bots to your harness agent, with QR-scan binding, streaming replies, tool approval, interactive questions, long-text splitting, multi-segment merge, and bilingual UI.

[![npm version](https://img.shields.io/npm/v/@lijian-ui/dsh-im-gateway)](https://www.npmjs.com/package/@lijian-ui/dsh-im-gateway)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## Features

### Channels & Core

- **Unified gateway service** — one plugin, five channels. Every channel routes through a single `ctx.imGateway` core: session management, slash commands, streaming, status broadcast.
- **DingTalk** — outbound WebSocket stream connection, group + single chats, @-mention filtering, **AI card streaming** (real-time incremental replies), slash commands.
- **QQ** — WebSocket gateway (official `qqbot-nodejs` SDK), private (c2c) + group chats, **QR-scan bot binding** (no manual console setup), **streaming messages** (c2c).
- **WeChat (iLink)** — official iLink long-poll protocol, **QR-scan login + pairing code**, single-chat only, media (AES-128-ECB CDN) in/out.
- **Feishu / Lark** — official `@larksuiteoapi/node-sdk` long connection (no public callback URL needed), **one-click app creation via QR scan** (scopes & event subscription pre-filled), private + group chats, **CardKit card streaming**, image/file transfer.
- **WeCom** — official AI-bot WebSocket long connection (no public callback URL, no message encryption), **one-click bot creation via QR scan**, private + group chats, **native streaming bubbles** (`replyStream`, in-place full-content replacement — a first-class platform capability), image/file/voice transfer.
- **Multi-bot instances** — the same channel type can appear many times (e.g. two DingTalk bots), each with its own credentials.
- **Settings UI** — a full web settings page ("IM 通道") rendered inside the official dsh web UI; QR-scan binding happens right there.
- **Streaming replies** — DingTalk AI Card, QQ stream_messages, Feishu CardKit cards, WeCom streaming bubbles; plain-text fallback when a channel doesn't support streaming.
- **Instance lock** — file-based `DSH_HOME` lock prevents multiple instances from corrupting the session log.

### Interaction Enhancements

- **Tool approval bridge** — when the agent calls a tool requiring approval, reply "approve" or "reject" directly in IM; timeout falls back to dsh's native approval system.
- **Interactive question bridge** — when the agent calls `ask_user_question`, the question is pushed to IM; reply with option numbers/text to answer. Races against the Web UI — first answer wins.
- **Long reply splitting** — replies exceeding the channel's single-message limit are auto-split at sentence boundaries with `（1/3）` segment prefixes, sent as separate messages.
- **Multi-segment input merge** — consecutive messages are auto-merged into one (configurable timeout window); use `..` to continue merging, `!!` to submit immediately.
- **File-sending tool** — the agent can call `im_send_file` to send workspace files (images/videos/documents) directly to the current IM session.
- **Inbound images** — images received on WeChat/Feishu are registered as dsh attachments (`{ type: 'image', attachment }`) and handed to the model with the message; when the host has no `attachments` service, a single image exceeds 10 MB, or registration times out, the turn degrades to a "[图片]" text note instead of dropping the message.
- **Bilingual UI** — set `language: 'zh' | 'en'` to switch all user-visible replies between Chinese and English.

### Session Management

- **Built-in slash commands** — `/help`, `/model`, `/status`, `/new`, `/reset`, `/stop`, `/sessions`, `/continue`, `/workspaces`, `/workspace` (see below).
- **Session list & continue** — `/sessions` lists recent sessions (with titles); `/continue <id>` resumes a specific session.
- **Channel-tagged session titles** — sessions created from IM appear in the dsh session list as `[bot name] <smart title>`, so you can tell at a glance which channel a session came from (the bot name is the channel instance's `name`, falling back to the channel type). The title keeps the smart title dsh generates and only gains a prefix; a manual rename in the Web UI is never overwritten.
- **Workspace management** — `/workspaces` lists all workspaces with session counts; `/workspace <path>` switches workspace (resets the current session; next message creates a new session in the new workspace).
- **User allowlist** — configure `allowAllUsers` or `allowedUserIds` to control who can use the bot.

---

## Installation

Requires DeepSeek Harness (dsh) — the plugin is a standard **dsh bundle** and installs through the official plugin channel.

### From npm (recommended)

```bash
dsh plugin --profile web add @lijian-ui/dsh-im-gateway
```

The npm package ships pre-built `lib/` — **no build authorization needed** (`allowBuilds` is not required).

### From tarball

```bash
npm pack @lijian-ui/dsh-im-gateway
dsh plugin --profile web add ./dsh-im-gateway-0.1.1.tgz
```

### From GitHub

```bash
dsh plugin --profile web add github:lijian-ui/dsh-im-gateway
```

> Git installs fetch **source**, so the first install requires approving the package's `prepare` build script (pnpm ≥ 10). Add the package key to the profile's `pnpm-workspace.yaml` → `allowBuilds` when prompted. Prefer npm/tarball to skip this.

### Verify installation

```bash
dsh --profile web --dump-config     # should show a "# == @lijian-ui/dsh-im-gateway" config layer
dsh --profile web                   # open Settings → "IM 通道" in the browser
```

---

## Quick Start

1. Open the dsh web UI → **Settings → IM 通道**.
2. Click **添加通道** (Add channel).
3. Pick a channel type:
   - **QQ**: click **扫码登录** → scan with mobile QQ → credentials auto-fill → save.
   - **个人微信** (WeChat): click **扫码登录** → scan with mobile WeChat → (enter the pairing code if asked) → credentials auto-fill → save.
   - **钉钉** (DingTalk): click **扫码登录** to let DingTalk create the bot, or fill in AppKey / AppSecret manually → save.
   - **飞书 / Lark** (Feishu / Lark): click **扫码登录** → scan with the Feishu app to create an app in one click (scopes & events pre-filled), or fill in App ID / App Secret manually → save.
   - **企业微信** (WeCom): click **扫码登录** → scan with WeCom to create an AI bot in one click, or fill in Bot ID / Secret manually → save.
4. Message your bot from the IM client — replies stream back in real time.

> Config is stored under `~/.dsh/settings.yaml` (`im-gateway.channels`). Saving from the UI **hot-reloads** the channels (no restart needed).

---

## Slash Commands

Sent to the bot in any IM channel:

| Command | Description |
| --- | --- |
| `/help` | List available commands |
| `/model` | List models with emoji numbers; `/model 1` or `/model <name>` to switch (no session yet → sets default for next conversation) |
| `/status` | Channel / cwd / current model / agent state |
| `/new` `/reset` `/clear` | Start a fresh conversation |
| `/stop` | Abort the current reply |
| `/sessions` | List the 10 most recent sessions (current session marked, with titles) |
| `/continue <session-id>` | Continue a specific session (use `/sessions` for IDs) |
| `/workspaces` | List all workspaces (sorted by recent activity, with session counts) |
| `/workspace <path>` | Switch to the specified workspace (resets current session; next message creates a new session in the new workspace) |
| `/workspace` | Without arguments, same as `/workspaces` |

### Multi-segment Input Suffixes

| Suffix | Effect |
| --- | --- |
| (none) | Enters the merge window, waits for more messages (auto-submits after 3s by default) |
| `..` | Continue merging: add this message to the buffer, keep waiting |
| `!!` | Submit now: merge the buffer + this message and send to the agent immediately |

### Approval Replies

When the agent calls a tool that requires approval, reply directly:

| Reply | Effect |
| --- | --- |
| `approve` / `yes` / `y` / `allow` | Allow the tool execution |
| `reject` / `no` / `n` / `deny` | Block the tool execution |

(Chinese equivalents: `批准` / `同意` for approve, `拒绝` for reject.)

After timeout, the request falls back to dsh's native approval system.

---

## Configuration

Everything is editable from the settings UI; the underlying schema lives in `~/.dsh/settings.yaml`:

```yaml
im-gateway:
  language: zh                    # UI language: zh (Chinese) | en (English)
  approvalTimeoutSecs: 120        # Tool approval timeout (seconds)
  questionTimeoutSecs: 600        # Interactive question timeout (seconds)
  mergeTimeoutSecs: 3             # Multi-segment input merge window (seconds)
  allowAllUsers: false            # Allow all users (dev only)
  allowedUserIds:                 # Allowlist: { channelId: string[] } or use '*' for any channel
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
        # callbackBaseUrl, appId, botAppId, baseUrl, botId, cdnBaseUrl, pollIntervalMs...
```

### Gateway-level Config

| Field | Default | Description |
| --- | --- | --- |
| `language` | `zh` | UI language (`zh` Chinese / `en` English); affects all user-visible replies |
| `streamThrottleMs` | `800` | Throttle interval for streaming pushes (ms) |
| `slashCommands` | `true` | Enable slash commands |
| `approvalTimeoutSecs` | `120` | Tool approval IM wait timeout (seconds); falls back to dsh native approval on timeout |
| `questionTimeoutSecs` | `600` | Interactive question IM wait timeout (seconds); falls back to Web UI on timeout |
| `mergeTimeoutSecs` | `3` | Multi-segment input merge window (seconds); consecutive messages merged into one |
| `allowAllUsers` | `false` | Allow all users (dev only; do not enable in production) |
| `allowedUserIds` | `{}` | Allowlist; key is channelId (`*` matches any), value is array of user IDs |

### Channel-level Config

| Field | Applies to | Meaning |
| --- | --- | --- |
| `clientId` / `clientSecret` | dingtalk | DingTalk app key / secret (Stream mode) |
| `appId` / `clientSecret` | qq | QQ Open Platform credentials (QR-bound) |
| `token` / `botId` / `baseUrl` / `cdnBaseUrl` | weixin | iLink credentials (QR-bound) |
| `appId` / `clientSecret` / `domain` | feishu | Feishu / Lark app credentials (QR-created); `domain`: `feishu` or `lark` |
| `botId` / `secret` | wecom | WeCom AI-bot BotID + long-connection secret (QR-created) |
| `groupPolicy` / `groupAllowFrom` / `groups` | qq · feishu · wecom | Group message policy: `open` / `allowlist` / `disabled` |
| `enabled` | all | Whether this instance connects |

---

## Architecture

```
IM client ──► channel adapter (dingtalk / qq / weixin / feishu / wecom)
                    │  ImInboundMessage
                    ▼
              ctx.imGateway (core)
                    │  multi-segment merge → allowlist check → approval/question intercept → slash commands
                    │  ensureSession → agent.followup
                    ▼
             dsh harness agent (LLM loop)
                    │  session events (turn/start, assistant/message, tool/call, turn/end)
                    │  live stream    (agent/assistant-stream: text-delta chunks)
                    ▼
         EventDispatcher → streaming reply / splitting / tool hints
                    │  (AI Card / stream_messages / CardKit / streaming bubble / plain text fallback)
                    ▼
                 IM client
```

### Module Structure

| Module | Responsibility |
| --- | --- |
| `im-gateway.ts` | Core service ImGatewayService: session management, message routing, tool registration |
| `events.ts` | EventDispatcher: SessionEvent → IM channel operations (streaming, splitting, tool hints) |
| `session-title.ts` | prefixSessionTitle: tag IM session titles with `[bot name] ` (via the official sessionTitle.rename) |
| `commands.ts` | CommandHandler: slash commands (/help /reset /model /status /stop /sessions /continue /workspaces /workspace) |
| `stream.ts` | StreamThrottle: batch text-delta and push at intervals |
| `approval.ts` | ApprovalBroker: tool approval bridge, holds approval/request pending IM reply |
| `questions.ts` | QuestionBroker: interactive question bridge, holds ask_user_question pending IM reply |
| `split.ts` | splitText: long-text splitting at sentence boundaries with segment prefixes |
| `merge.ts` | SessionMerger: multi-segment input merge, supports `..` / `!!` control suffixes |
| `i18n.ts` | Translator: Chinese/English bilingual translation table |
| `instance-lock.ts` | acquireInstanceLock: DSH_HOME file lock, prevents concurrent session log corruption |
| `types.ts` | Interface definitions: ImChannelAdapter, ImGatewayConfig, ImGateway, etc. |

- **Host half** (node): `src/index.ts` (apply), `src/gateway/` (core + above modules), `src/channels/` (dingtalk / qq / weixin / feishu / wecom + protocol helpers), `src/remote.ts` (Typert RPC for the settings UI), `src/sync.ts` (channel reload on config save).
- **Client half** (browser): `src/client/` — settings page "IM 通道" (add/edit modal + QR-scan login + status dots).
- **Multi-bot**: `channels` is an array; the same `type` may appear multiple times.

### Extension Points

Third parties can register their own channel without forking:

```ts
import { ImChannelAdapter } from '@lijian-ui/dsh-im-gateway'   // peerDependency on the core

class MyChannelAdapter implements ImChannelAdapter { /* ... */ }
ctx.imGateway.registerChannel(myAdapter)
```

`ImChannelAdapter` interface optional methods:

| Method | Description |
| --- | --- |
| `sendText(convId, text)` | **Required**. Send a plain-text message |
| `sendMedia(convId, filePath, caption?)` | Optional. Send a file/image/video (used by im_send_file tool) |
| `beginStream(convId)` | Optional. Open a streaming reply (called on first text delta) |
| `streamText(convId, text)` | Optional. Streaming overwrite update (throttled) |
| `endStream(convId, fullText)` | Optional. Close a streaming reply (called on turn/end) |
| `updateCard(convId, text)` | Optional. Legacy single-shot card update |
| `authorizes(userId)` | Optional. Channel-local authorization check (return false to block) |
| `maxMessageChars` | Optional. Max chars per message (default 4000, used for splitting) |
| `label` | Optional. Channel display name (used in question receipts) |

---

## Development

```bash
git clone https://github.com/lijian-ui/dsh-im-gateway.git
cd dsh-im-gateway
npm install
npm run build          # tsdown → lib/
npm run watch          # rebuild on save
npm run typecheck
npm test               # node --test tests/*.test.mjs
```

Local link into a dsh profile:

```bash
dsh plugin --profile web add ./   # install from this directory (link)
```

> **Windows note**: the dsh subprocess loads `lib/index.js` from `package.json` `main` — after editing `src/`, always `npm run build` then restart the dsh process (its require cache keeps the old module).

### Tests

Tests use Node.js's built-in test runner (`node:test`), in the `tests/` directory:

| Test file | Module covered | Tests |
| --- | --- | --- |
| `approval.test.mjs` | ApprovalBroker | 8 |
| `questions.test.mjs` | QuestionBroker + parseQuestionReply + formatQuestionPrompt | 8 |
| `split.test.mjs` | splitText | 8 |
| `merge.test.mjs` | SessionMerger + stripControlSuffix | 9 |

---

## Troubleshooting

- **No logs from the plugin** — cordis buffers `ctx.logger.*` in memory by default. The plugin registers a console exporter on apply, so logs appear in the dsh subprocess stderr (desktop shells prefix them with `[dsh]`).
- **QQ client shows "连接中" (connecting) forever** — streaming was opened too early or never closed. This plugin opens the stream on the first assistant text delta and always closes it on `turn/end` (fixed in 0.1.x).
- **Chat works but replies are not streaming** — the channel fell back to plain text (e.g. QQ group chats don't support `stream_messages`; WeChat has no streaming concept). This is by design.
- **Replies split into multiple messages** — auto-splitting kicks in when text exceeds the channel's `maxMessageChars` limit, with `（1/3）` prefixes. This is by design, not a bug.
- **Multiple messages got merged** — consecutive messages within the 3s merge window are combined into one. Send `!!` to submit immediately, or increase `mergeTimeoutSecs`.
- **Approval/question timed out** — increase `approvalTimeoutSecs` / `questionTimeoutSecs`. On timeout, the request automatically falls back to the Web UI.
- **Some text still in Chinese after switching to English** — separators in `formatAnswerSummary` (`、` `；`) and `（空）` are intentionally fixed as they are format symbols, not natural language.

---

## License

MIT © lijian-ui

Built for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — independent plugin, not affiliated with or endorsed by DeepSeek.
