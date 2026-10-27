import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, AgentSetup, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {
  ChannelStatus,
  ImChannelAdapter,
  ImGateway,
  ImGatewayConfig,
  ImInboundMessage,
} from './types'
import { ApprovalBroker } from './approval'
import { QuestionBroker, formatQuestionPrompt, formatAnswerSummary } from './questions'

import { SessionMerger } from './merge'
import { StreamThrottle } from './stream'
import { CommandHandler } from './commands'
import type { GatewayHandle } from './commands'
import { EventDispatcher } from './events'
import { prefixSessionTitle } from './session-title'
import { createTranslator, type Translator, breakChars } from './i18n'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// 引入 dsh-user-approval / dsh-user-questions 的模块增强（让 ctx.on('approval/request') 和 ctx.userQuestions 类型可用）
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// cordis reads `export const Config` as this plugin's config schema.
// Single-entry bundle: the gateway core + every channel instance live in ONE
// namespace (`im-gateway`), with `channels` as an ARRAY of instances — the
// same channel type may appear many times (multi-bot support, mirroring
// pi-desk-top's channel-instance model).
export const Config: Schema = Schema.object({
  cwd: Schema.string().default(process.cwd()),
  streamThrottleMs: Schema.number().default(800),
  slashCommands: Schema.boolean().default(true),
  approvalTimeoutSecs: Schema.number().default(120),
  questionTimeoutSecs: Schema.number().default(600),
  allowAllUsers: Schema.boolean().default(false),
  allowedUserIds: Schema.dict(Schema.array(Schema.string())).default({}),
  mergeTimeoutSecs: Schema.number().default(3),

  channels: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      type: Schema.union(['dingtalk', 'qq', 'weixin', 'feishu', 'wecom']),
      name: Schema.string().default(''),
      enabled: Schema.boolean().default(false),
      // Loose merged credential schema: all channel types' fields are
      // optional at the schema level; the runtime adapter reads only the
      // keys its own type needs (see createAdapter in src/index.ts).
      config: Schema.object({
        // dingtalk
        clientId: Schema.string().default(''),
        clientSecret: Schema.string().role('secret').default(''),
        callbackBaseUrl: Schema.string().default(''),
        // qq
        appId: Schema.string().default(''),
        botAppId: Schema.string().default(''),
        // qq — 出站引用回复（被动回复引用用户消息）
        quoteReply: Schema.boolean().default(true),
        // qq — 群策略
        groupPolicy: Schema.union(['open', 'allowlist', 'disabled']).default('open'),
        groupAllowFrom: Schema.array(Schema.string()).default([]),
        defaultRequireMention: Schema.boolean().default(true),
        groups: Schema.dict(
          Schema.object({
            requireMention: Schema.boolean(),
            ignoreOtherMentions: Schema.boolean(),
            toolPolicy: Schema.union(['full', 'restricted', 'none']),
            name: Schema.string(),
            prompt: Schema.string(),
          }),
        ).default({}),
        // qq — 出站语音（OpenAI 兼容 TTS）
        tts: Schema.object({
          enabled: Schema.boolean().default(false),
          baseUrl: Schema.string().default(''),
          apiKey: Schema.string().role('secret').default(''),
          model: Schema.string().default('tts-1'),
          voice: Schema.string().default('alloy'),
          format: Schema.string().default('mp3'),
        }).default({} as never),
        // feishu —— 复用 appId / clientSecret（见上方 qq 区块），另加平台域名；
        // quoteReply / groupPolicy / groupAllowFrom / defaultRequireMention / groups
        // 同样由飞书通道复用。
        domain: Schema.union(['feishu', 'lark']).default('feishu'),
        // weixin (iLink weixin)
        baseUrl: Schema.string().default(''),
        token: Schema.string().role('secret').default(''),
        botId: Schema.string().default(''),
        cdnBaseUrl: Schema.string().default(''),
        pollIntervalMs: Schema.number().default(3000),
        // wecom（企业微信智能机器人）—— 长连接专用密钥；groupPolicy /
        // groupAllowFrom / groups 复用上方 qq 区块的同名字段。
        secret: Schema.string().role('secret').default(''),
      }).default({} as never),
    }),
  ).default([]),
})

/**
 * Core IM gateway service.
 *
 * Responsibilities (ported from pi-desk-top/src/main/im/im-gateway.ts):
 *  - channel registry (`registerChannel`)
 *  - conversation → host session mapping
 *  - per-conversation serial queue (one agent turn at a time)
 *  - slash-command handling (/help, /reset, /clear)
 *  - agent-event → channel reply routing (streaming, tool notifications, flush)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOST API CONTRACT (verified against deepseek-harness source):
 *  - Sessions:  `ctx.sessions` is the `SessionStore` (from @deepseek-ai/dsh-session).
 *               `create(id, { meta: { cwd } })` builds an event-sourced Session.
 *               The Session object has NO `.prompt()` / `.on()` — it is a log.
 *  - Agents:    `ctx.agents` is the `AgentRegistry` (from @deepseek-ai/dsh-agent).
 *               `get(sessionId)` → Agent | undefined; `createAgent(ownerCtx, opts)`
 *               starts the agent loop on a session. Drive a turn with
 *               `agent.followup(userMessage)` (see host/apiproxy/src/api-proxy.ts:2461).
 *  - Events:    subscribe at the CONTEXT level: `ctx.on('session/event', (session, event) => …)`.
 *               Typed events (packages/core/session/src/types.ts):
 *                 'turn/start'        { turn }
 *                 'assistant/chunk'   { turn, step, chunk: StreamChunk }  // chunk.type==='text-delta' → text
 *                 'assistant/message' { turn, step, message: AssistantMessage }
 *                 'tool/call'         { turn, step, callId, name, arguments }
 *                 'turn/end'          { turn, reason }
 * ─────────────────────────────────────────────────────────────────────────
 */
export class ImGatewayService extends Service implements ImGateway {
  static inject = ['agents', 'agentPresets']

  private readonly channels = new Map<string, ImChannelAdapter>()
  private readonly convToSession = new Map<string, SessionId>() // convKey → sessionId
  private readonly sessionToConv = new Map<string, string>() // sessionId → convKey
  /** Deduplicate concurrent ensureSession calls for the same conversation. */
  private readonly sessionCreations = new Map<string, Promise<SessionId>>()
  private readonly serialQueues = new Map<string, Promise<void>>()
  /**
   * Process-level inbound dedup (5-min TTL). Catches duplicate delivers from
   * MULTIPLE adapter instances that exist simultaneously — dev HMR reloads
   * can re-create adapters before old ones fully stop, and each adapter's
   * own dedup only covers THAT instance. A single gateway-level map catches
   * everything because ImGatewayService is a singleton.
   * Key: channel-native messageId when available, else heuristic key.
   */
  private static readonly INBOUND_DEDUP_TTL_MS = 5 * 60 * 1000
  private readonly seenInbounds = new Map<string, number>()


  private readonly agentHandles = new Map<string, AgentHandle>()
  /** Per-session model-selection ref (so /model can switch without re-injecting). */
  private readonly modelRefs = new Map<string, ModelSelectionRef>()
  /** Per-session model override captured from /model (absent → fall back to globalModelOverride). */
  private readonly modelOverrides = new Map<string, { provider: string; model: string; reasoningEffort?: string }>()
  /**
   * Default model when there is no session override AND no /cwd-provided default.
   * Set by /model <name> issued BEFORE the first message of a conversation
   * (i.e. session not yet created). Survives across conversations until cleared.
   */
  private globalModelOverride?: { provider: string; model: string; reasoningEffort?: string }

  /** 设置全局默认模型覆盖（CommandHandler 通过 GatewayHandle 调用）。 */
  setGlobalModelOverride(v: { provider: string; model: string; reasoningEffort?: string } | undefined): void {
    this.globalModelOverride = v
  }

  /** 每会话工作区偏好（convKey → workspace path），由 /workspace 命令设置。 */
  private readonly workspaces = new Map<string, string>()

  /** 每会话 generation 计数器（/new 递增，使 sessionId 变化以避免 resume 旧会话）。 */
  private readonly sessionGenerations = new Map<string, number>()

  /** /new 时用 Date.now() 作为 generation，确保 sessionId 唯一，避免 resume 旧会话。 */
  bumpSessionGeneration(convKey: string): void {
    this.sessionGenerations.set(convKey, Date.now())
    this.persistGenerations()
  }

  /** 当前会话的工作区偏好（无则返回 undefined，调用方回退到 config.cwd）。 */
  workspaceOf(convKey: string): string | undefined {
    return this.workspaces.get(convKey)
  }

  /** 设置会话工作区偏好，持久化到 workspaces.json。 */
  setWorkspace(convKey: string, path: string): void {
    this.workspaces.set(convKey, path)
    this.persistWorkspaces()
  }

  /** 工作区偏好持久化文件路径。 */
  private workspaceStorePath(): string {
    const stateDir = join(homedir(), '.dsh', 'im-gateway')
    return join(stateDir, 'workspaces.json')
  }

  /** 加载持久化的工作区偏好（启动时调用）。 */
  private loadWorkspaces(): void {
    try {
      const raw = readFileSync(this.workspaceStorePath(), 'utf8')
      const entries = JSON.parse(raw) as Array<[string, string]>
      if (Array.isArray(entries)) {
        for (const [key, path] of entries) {
          if (typeof key === 'string' && typeof path === 'string') {
            this.workspaces.set(key, path)
          }
        }
      }
    } catch { /* file not found or invalid — start fresh */ }
  }

  /** 持久化工作区偏好到 workspaces.json（`loadWorkspaces` 的逆操作）。 */
  private persistWorkspaces(): void {
    try {
      const stateDir = join(homedir(), '.dsh', 'im-gateway')
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(this.workspaceStorePath(), JSON.stringify([...this.workspaces.entries()], null, 2))
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] workspace 持久化失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 会话 generation 持久化文件路径。 */
  private generationsStorePath(): string {
    const stateDir = join(homedir(), '.dsh', 'im-gateway')
    return join(stateDir, 'generations.json')
  }

  /** 加载持久化的 generation（启动时调用）。 */
  private loadGenerations(): void {
    try {
      const raw = readFileSync(this.generationsStorePath(), 'utf8')
      const entries = JSON.parse(raw) as Record<string, number>
      if (entries && typeof entries === 'object') {
        for (const [key, val] of Object.entries(entries)) {
          if (typeof key === 'string' && typeof val === 'number') {
            this.sessionGenerations.set(key, val)
          }
        }
      }
    } catch { /* file not found or invalid — start fresh */ }
  }

  /** 持久化 generation 到 generations.json。 */
  private persistGenerations(): void {
    try {
      const stateDir = join(homedir(), '.dsh', 'im-gateway')
      mkdirSync(stateDir, { recursive: true })
      const obj = Object.fromEntries(this.sessionGenerations.entries())
      writeFileSync(this.generationsStorePath(), JSON.stringify(obj, null, 2))
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] generation 持久化失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  /** Live channel runtime status, surfaced to the settings UI via getChannelStatuses. */
  private readonly channelStatuses = new Map<string, ChannelStatus>()
  /** 审批桥：挂起 approval/request，等待 IM 侧「批准/拒绝」答复。 */
  private readonly approvalBroker = new ApprovalBroker()
  /** 提问桥：挂起 ask_user_question，等待 IM 侧回复选项编号/文字。 */
  private readonly questionBroker = new QuestionBroker()
  /** UI 批准的渠道白名单用户（重启后需重新灌入）。 */
  private readonly extraAllowlist = new Map<string, Set<string>>()
  /** 多段输入合并器：用户连续发多条消息时合并为一条。 */
  private merger?: SessionMerger
  /** 工具卸载句柄（im_send_file 等）。 */
  private readonly disposeTools: Array<() => void> = []
  /** 流式节流器：攒批 text-delta 后按间隔推送渠道。 */
  private streamThrottle?: StreamThrottle
  /** Slash 命令处理器。 */
  private commandHandler?: CommandHandler
  /** 事件分发器：把 dsh SessionEvent 翻译为 IM 渠道操作。 */
  private eventDispatcher?: EventDispatcher
  /** 翻译器（中/英文）。 */
  private t: Translator = createTranslator('zh')
  /** 恢复 ctx.userQuestions.ask 原始实现（卸载时调用）。 */
  private restoreUserQuestionsAsk?: () => void
  private unsubSessionEvent?: () => void
  private unsubAssistantStream?: () => void
  private unsubSessionActivity?: () => void
  private unsubLocaleChange?: () => void
  private unsubApproval?: () => void
  private active = false

  constructor(ctx: Context, private readonly config: ImGatewayConfig) {
    super(ctx, 'imGateway')
  }

  // ── public API (for channel plugins) ───────────────────────────────────

  registerChannel(adapter: ImChannelAdapter): void {
    if (this.channels.has(adapter.id)) {
      this.ctx.logger.warn(`[im-gateway] channel "${adapter.id}" re-registered; replacing.`)
    }
    this.channels.set(adapter.id, adapter)
    // Hook the adapter's status sink so we can surface online/offline/error
    // in the settings UI (ChannelStatus broadcast).
    adapter.statusListener = (status) => this.setChannelStatus(adapter.id, status)
    if (this.active) {
      void Promise.resolve(adapter.start()).catch((err) =>
        this.ctx.logger.error(`[im-gateway] channel "${adapter.id}" start failed`, err),
      )
    }
  }

  getChannel(id: string): ImChannelAdapter | undefined {
    return this.channels.get(id)
  }

  listChannels(): string[] {
    return [...this.channels.keys()]
  }

  /**
   * Stop every channel and clear the registry. Used by config reload
   * (mirrors the reference project's applyConfig → stopAll): after a save
   * the caller re-creates adapters from the new settings and re-registers.
   */
  async stopAll(): Promise<void> {
    const adapters = [...this.channels.values()]
    this.channels.clear()
    this.channelStatuses.clear()
    for (const adapter of adapters) {
      try {
        await adapter.stop()
      } catch (err) {
        this.ctx.logger.error(`[im-gateway] stop channel "${adapter.id}" failed`, err)
      }
    }
  }

  /** Snapshot of every channel's runtime status for the settings UI. */
  getChannelStatuses(): Record<string, ChannelStatus> {
    const out: Record<string, ChannelStatus> = {}
    for (const [id, status] of this.channelStatuses) out[id] = status
    return out
  }

  /** Record a channel's runtime status and log meaningful transitions. */
  private setChannelStatus(id: string, status: ChannelStatus): void {
    const prev = this.channelStatuses.get(id)?.status
    this.channelStatuses.set(id, { ...status, lastChange: Date.now() })
    if (prev !== status.status) {
      if (status.status === 'error') {
        this.ctx.logger.warn(`[im-gateway] channel "${id}" → error: ${status.error ?? 'unknown'}`)
      } else {
        this.ctx.logger.info(`[im-gateway] channel "${id}" → ${status.status}`)
      }
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  //
  // cordis runs a Service plugin's `[Service.init]` (symbol method) after
  // construction — a plain `start()` is NEVER called. The generator shape
  // (yield a cleanup fn, then the init body) mirrors the official pattern
  // (dsh-settings: `async *[Service.init]()`).

  async *[Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // Cleanup runs when the service/plugin unloads (the old stop() body).
    yield async () => {
      this.active = false
      this.unsubSessionEvent?.()
      this.unsubSessionEvent = undefined
      this.unsubAssistantStream?.()
      this.unsubAssistantStream = undefined
      this.unsubSessionActivity?.()
      this.unsubSessionActivity = undefined
      this.unsubLocaleChange?.()
      this.unsubLocaleChange = undefined
      this.unsubApproval?.()
      this.unsubApproval = undefined
      this.approvalBroker.dispose()
      this.restoreUserQuestionsAsk?.()
      this.restoreUserQuestionsAsk = undefined
      this.questionBroker.dispose()
      this.merger?.dispose()
      this.merger = undefined
      for (const dispose of this.disposeTools) dispose()
      this.disposeTools.length = 0
      this.streamThrottle?.dispose()
      this.streamThrottle = undefined
      this.eventDispatcher = undefined
      for (const adapter of this.channels.values()) {
        try {
          await adapter.stop()
        } catch (err) {
          this.ctx.logger.error(`[im-gateway] stop channel "${adapter.id}" failed`, err)
        }
      }
      // Tear down the agent + session we own for each IM conversation.
      for (const [, handle] of this.agentHandles) {
        await handle.dispose().catch((err) => this.ctx.logger.warn('[im-gateway] agent dispose failed', err))
      }
      this.agentHandles.clear()
      this.convToSession.clear()
      this.sessionToConv.clear()
    }

    this.active = true
    this.loadWorkspaces()
    this.loadGenerations()
    this.streamThrottle = new StreamThrottle(this.config.streamThrottleMs)
    this.t = createTranslator(this.resolveLang())
    this.questionBroker.t = this.t
    const self = this
    this.eventDispatcher = new EventDispatcher({
      ctx: this.ctx,
      get t() { return self.t },
      sessionToConv: this.sessionToConv,
      streamThrottle: this.streamThrottle,
      channelForConv: (convKey: string) => this.channelForConv(convKey),
    })
    this.commandHandler = new CommandHandler(this as unknown as GatewayHandle)
    // 监听全局语言切换（dsh 设置 → 通用设置 → 语言）
    this.unsubLocaleChange = this.ctx.root.on('settings/updated', (ns, next) => {
      if (ns !== 'locale') return
      const lang = (next as { preference?: 'zh' | 'en' })?.preference ?? 'zh'
      this.t = createTranslator(lang)
      this.questionBroker.t = this.t
    })
    // Subscribe on the ROOT context: cordis dispatches events only on the
    // ctx that emitted them (no parent/child propagation), and session events
    // are emitted on the root context by the session service. A subscription
    // on this plugin's child ctx would silently receive NOTHING.
    this.unsubSessionEvent = this.ctx.root.on('session/event', (session, event) => {
      // DIAG: 定位「重启后 resume 会话在 web UI 不渲染新消息」——确认 session/event
      // 是否真的广播到 im-gateway。若这里能打印但 UI 不显示 → UI 订阅问题；不打印 → 广播断。
      console.log(`[im-gateway] session/event id=${session.id} type=${event.type}`)
      this.eventDispatcher!.dispatch(session, event)
    })
    // 实时逐字增量。与 session/event 的关键区别：session/event 里的
    // assistant/message 要等一条消息**完成**才触发，靠它做流式只能是「憋完整段
    // 再发」；而 agent loop 在整个模型尝试过程中会持续 emit
    // `agent/assistant-stream`（web UI 的逐字渲染正是消费这条）。frame 里
    // `type:'chunk'` + `chunk.type:'text-delta'` 即为一个文本增量。
    //
    // 该事件由 agent-scoped 派发，context 过滤会拦掉普通监听器 —— 必须显式
    // 声明 `{ global: true }` 才能收到。
    this.unsubAssistantStream = this.ctx.root.on(
      'agent/assistant-stream',
      ({ agent, frame }) => {
        this.eventDispatcher!.dispatchAssistantStream(agent.session.id, frame)
      },
      { global: true },
    )
    // DIAG: 确认 host 的 api-session/activity 是否发出并转发到前端列表。
    // 官方 controller 对 user/message(source.kind=user) emit 此事件；
    // 若这里能打印 → host→remote 转发链路起点正常。
    this.unsubSessionActivity = this.ctx.root.on('api-session/activity', (sessionId, updatedAt) => {
      console.log(`[im-gateway] api-session/activity id=${String(sessionId).slice(0, 32)} updatedAt=${updatedAt}`)
    })
    // 审批桥：approval/request waterfall → 推送到会话所在 chat → 回复「批准/拒绝」→ 返回 verdict
    this.unsubApproval = this.ctx.root.on('approval/request', async (req, next) =>
      this.handleApprovalRequest(req, next),
    )
    // 提问桥：包装 ctx.userQuestions.ask，让 IM 侧也能回答 ask_user_question
    this.installQuestionBridge()
    // 多段输入合并器：超时回调里注入合并后的文本
    this.merger = new SessionMerger({
      mergeTimeoutMs: this.config.mergeTimeoutSecs * 1000,
      onFlush: (convKey, text) => this.onMergeFlush(convKey, text),
    })
    // 注册 im_send_file 工具：agent 可把工作区文件发给当前 IM 聊天
    this.registerSendFileTool()
    // 注册 im_send_voice 工具：agent 可把文本合成语音发给当前 IM 聊天
    this.registerSendVoiceTool()
    for (const adapter of this.channels.values()) {
      try {
        await adapter.start()
      } catch (err) {
        this.ctx.logger.error(`[im-gateway] start channel "${adapter.id}" failed`, err)
      }
    }
    this.ctx.logger.info(`[im-gateway] active; channels: ${this.listChannels().join(', ') || '(none)'}`)
  }

  // ── inbound → agent ────────────────────────────────────────────────────

  async handleInbound(message: ImInboundMessage): Promise<void> {
    // Process-level dedup — catches duplicates from concurrent adapter
    // instances (dev HMR, reconnect races). Adapter's own dedup only covers
    // one instance; this gateway map is singleton so nothing slips through.
    const now = Date.now()
    for (const [k, ts] of this.seenInbounds) {
      if (now - ts > ImGatewayService.INBOUND_DEDUP_TTL_MS) this.seenInbounds.delete(k)
    }
    const dedupKey = message.messageId
      ? `${message.channelId}:${message.messageId}`
      : `${message.channelId}:${message.conversationId}:${message.userId}:${message.text.slice(0, 80)}`
    if (this.seenInbounds.has(dedupKey)) {
      this.ctx.logger.debug(`[im-gateway] duplicate inbound ${dedupKey.slice(0, 60)} — skipped`)
      return
    }
    this.seenInbounds.set(dedupKey, now)

    const channel = this.channels.get(message.channelId)
    if (!channel) {
      this.ctx.logger.warn(`[im-gateway] inbound from unknown channel "${message.channelId}"`)
      return
    }
    if (channel.onInbound) {
      const handled = await channel.onInbound(message)
      if (handled) return
    }
    if (this.config.slashCommands && message.text.trimStart().startsWith('/')) {
      try {
        const handled = await this.commandHandler!.handle(channel, message)
        if (handled) return
      } catch (err) {
        // NEVER swallow slash-command failures: a broken command must reply
        // with a visible error instead of silently dying (that silent path
        // cost us hours on the /model `.catch()` bug). Send back to the same
        // conversation so the user at least sees something.
        const convKey = `${message.channelId}:${message.conversationId}`
        const convId = convOf(convKey)
        const detail = err instanceof Error ? err.message : String(err)
        this.ctx.logger.error(`[im-gateway] slash command failed: ${detail}`, err)
        await channel.sendText(convId, this.t.t('gw.cmd.failed', detail)).catch(() => undefined)
        return
      }
    }

    // 审批答复检测：用户回复「批准/拒绝」时消费 pending 审批，不转发给 agent
    const verdictText = message.text.trim().toLowerCase()
    const approveKw = this.t.t('gw.auth.approve').toLowerCase()
    const agreeKw = this.t.t('gw.auth.agree').toLowerCase()
    const rejectKw = this.t.t('gw.auth.reject').toLowerCase()
    if (verdictText === approveKw || verdictText === agreeKw || verdictText === 'yes' || verdictText === 'y' || verdictText === 'allow') {
      const handled = await this.answerApproval(channel, message, true)
      if (handled) return
    }
    if (verdictText === rejectKw || verdictText === 'no' || verdictText === 'n' || verdictText === 'reject' || verdictText === 'deny') {
      const handled = await this.answerApproval(channel, message, false)
      if (handled) return
    }

    // 提问答复检测：有 pending 提问时尝试解析为答案，不转发给 agent
    if (await this.answerQuestion(channel, message)) return


    const convKey = `${message.channelId}:${message.conversationId}`

    // 多段输入合并：用户连续发多条消息时合并为一条再提交给 agent
    const mergeResult = this.merger?.ingest(convKey, message.text)
    if (mergeResult && mergeResult.kind === 'flushed' && mergeResult.text) {
      const sessionId = await this.ensureSession(convKey)
      const parts = toContentBlocks({ ...message, text: mergeResult.text })
      // Serialize turns per conversation so a fast second message waits for the first.
      const prev = this.serialQueues.get(convKey) ?? Promise.resolve()
      const next = prev.then(() => this.runTurn(sessionId, convKey, channel, parts))
      this.serialQueues.set(convKey, next.catch(() => undefined))
    }
    // buffered / ignored: 等待后续消息或超时
  }

  /** 合并窗口超时回调：把合并后的文本注入 agent。 */
  private async onMergeFlush(convKey: string, text: string): Promise<void> {
    const channel = this.channelForConv(convKey)
    if (!channel) return
    try {
      const sessionId = await this.ensureSession(convKey)
      const parts: ContentBlock[] = [{ type: 'text', text }]
      const prev = this.serialQueues.get(convKey) ?? Promise.resolve()
      const next = prev.then(() => this.runTurn(sessionId, convKey, channel, parts))
      this.serialQueues.set(convKey, next.catch(() => undefined))
    } catch (err) {
      this.ctx.logger.error(`[im-gateway] merge flush failed for ${convKey}`, err)
    }
  }

  private async ensureSession(convKey: string): Promise<SessionId> {
    // An archived conversation can never run a turn (see
    // `reviveArchivedConversation`), so recover BEFORE handing the id back:
    // this is the only boundary that still owns it.
    await this.reviveArchivedConversation(convKey)
    const existing = this.convToSession.get(convKey)
    if (existing) return existing

    // Deduplicate concurrent inbounds for the same conversation (two messages
    // can arrive before the first session finishes materializing). Mirrors
    // dsh-host-apiproxy's `sessionCreations` map.
    let creation = this.sessionCreations.get(convKey)
    if (creation === undefined) {
      creation = this.ensureSessionInner(convKey)
      this.sessionCreations.set(convKey, creation)
      void creation
        .finally(() => this.sessionCreations.delete(convKey))
        .catch(() => undefined)
    }
    const sessionId = await creation
    // 重启后 resume 回来的旧会话不会再走官方标题链路（`first-prompt` 只在首条
    // 消息后生成一次）——补一次前缀，否则旧的 IM 会话永远没有通道标识。
    this.adoptExistingTitle(convKey, sessionId)
    return sessionId
  }

  /** The session id the current generation maps to (pure; no side effects). */
  private sessionIdFor(convKey: string): SessionId {
    const generation = this.sessionGenerations.get(convKey) ?? 0
    return SessionId(generation === 0 ? `im:${convKey}` : `im:${convKey}:${generation}`)
  }

  /**
   * Recover a conversation whose Session was archived (desktop sidebar → 归档).
   *
   * The kernel rejects an archived Session **before the first step**
   * (`archived-session-gate`), so the turn ends `blocked` without a single
   * model request: the IM message is accepted, the streaming card is opened,
   * and nothing is ever written to it. From the chat side that looks like
   * 「思考一会就停了」, and re-sending never helps because the id never changes.
   * Unarchiving is a Workspace-registry write, not a Session API, so neither
   * the agent nor the model can clear it on their own.
   *
   * Recover here, at the boundary that owns the id:
   *   1. unarchive — the conversation keeps its history;
   *   2. if the registry still reports it archived, bump the generation so the
   *      next id is a genuinely new conversation instead of a dead one.
   */
  private async reviveArchivedConversation(convKey: string): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry') as
      | {
        archivedSessionIds?: string[]
        unarchiveSession?: (sessionId: SessionId) => Promise<void>
      }
      | undefined
    if (!Array.isArray(registry?.archivedSessionIds)) return
    const unarchive = registry.unarchiveSession?.bind(registry)
    if (!unarchive) return
    const isArchived = (sessionId: SessionId): boolean =>
      registry.archivedSessionIds?.includes(sessionId) === true

    const candidates = new Set<SessionId>()
    const mapped = this.convToSession.get(convKey)
    if (mapped) candidates.add(mapped)
    candidates.add(this.sessionIdFor(convKey))

    for (const sessionId of candidates) {
      if (!isArchived(sessionId)) continue
      this.ctx.logger.warn(
        `[im-gateway] session ${sessionId} is archived — the kernel blocks every turn before the first step; unarchiving`,
      )
      try {
        await unarchive(sessionId)
      } catch (err) {
        this.ctx.logger.warn(`[im-gateway] unarchive ${sessionId} failed; rotating instead`, err)
      }
      if (!isArchived(sessionId)) continue

      this.ctx.logger.warn(`[im-gateway] session ${sessionId} is still archived → rotating ${convKey} to a new session`)
      this.releaseSession(convKey, sessionId)
      this.bumpSessionGeneration(convKey)
      await this.notifyArchivedRotation(convKey)
    }
  }

  /** Drop every in-memory binding of one Session so a fresh id can take over. */
  private releaseSession(convKey: string, sessionId: SessionId): void {
    const handle = this.agentHandles.get(sessionId)
    if (handle) {
      try { handle.agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch { /* already stopped */ }
    }
    this.agentHandles.delete(sessionId)
    this.modelRefs.delete(sessionId)
    this.modelOverrides.delete(sessionId)
    if (this.sessionToConv.get(sessionId) === convKey) this.sessionToConv.delete(sessionId)
    if (this.convToSession.get(convKey) === sessionId) this.convToSession.delete(convKey)
    this.clearConversationState(convOf(convKey))
  }

  /** Tell the user why the previous history stopped being answered. */
  private async notifyArchivedRotation(convKey: string): Promise<void> {
    const channel = this.channelForConv(convKey)
    if (!channel) return
    try {
      await channel.sendText(convOf(convKey), this.t.t('gw.session.archivedRotated'))
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] archived-rotation notice failed for ${convKey}`, err)
    }
  }

  /**
   * 给「已有标题但还没加通道前缀」的 IM 会话补前缀（幂等，见 session-title.ts）。
   *
   * 只处理已经落地标题的会话：新会话此刻还没有标题，会走 events.ts 的
   * `session/title` 链路；这里负责的是重启后 resume 的老会话。
   */
  private adoptExistingTitle(convKey: string, sessionId: SessionId): void {
    const channel = this.channelForConv(convKey)
    if (!channel) return
    const sessions = this.ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined
    const session = sessions?.get(sessionId)
    if (!session) return
    prefixSessionTitle(this.ctx, session, channel.label)
  }

  /**
   * Resolve an IM conversation to a live agent session, following the OFFICIAL
   * dsh pattern (dsh-host-apiproxy/src/api-proxy.ts `ensureSession`):
   *
   *   1. A live agent with this id already exists → reuse it.
   *   2. A persisted log exists on disk (from a previous run) → `agents.resume`
   *      the SAME id. This is the crux: IM conversations are long-lived (the
   *      DingTalk conversationId is stable across restarts), so the session id
   *      MUST be stable too. `agents.create` on a stored id would reject with
   *      "id collision" because the fresh seed does not reproduce the stored
   *      log; `agents.resume` replays the stored log AS the seed and keeps the
   *      conversation history. A random per-boot suffix would dodge the
   *      collision but silently throw history away — do NOT do that.
   *   3. Neither → genuinely new conversation: `agents.create`.
   */
  private async ensureSessionInner(convKey: string): Promise<SessionId> {
    const generation = this.sessionGenerations.get(convKey) ?? 0
    const sessionId = this.sessionIdFor(convKey)
    const wsPref = this.workspaceOf(convKey)
    // Canonicalize cwd via realpath so session header.cwd matches
    // workspaceRegistry.create's realpath-normalized path exactly. A trailing
    // slash or symlink in the raw value would otherwise land the session in a
    // different persistence directory than the workspace's attachSession check
    // expects, making the session invisible in the web sidebar.
    const rawCwd = wsPref ?? this.config.cwd
    const effectiveCwd = safeRealpath(rawCwd)
    console.log(`[im-gateway] ensureSession: convKey=${convKey} gen=${generation} sessionId=${sessionId} rawCwd="${rawCwd}" canonical="${effectiveCwd}"`)

    // 1) Live agent already exists (defensive; same-process reuse).
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      console.log(`[im-gateway] ensureSession: branch 1 (live reuse)`)
      this.convToSession.set(convKey, sessionId)
      this.sessionToConv.set(sessionId, convKey)
      return sessionId
    }

    // 2) Stored log exists → resume (keeps history, avoids id collision).
    const persistence = this.ctx.get('sessionPersistence') as
      | { list(): Promise<Array<{ id: SessionId }>> }
      | undefined
    if (persistence) {
      const stored = (await persistence.list()).find((header) => header.id === sessionId)
      if (stored) {
        console.log(`[im-gateway] ensureSession: branch 2 (resume from persistence)`)
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.currentModelFor(sessionId),
          setup: this.presetSetup(sessionId),
        })
        this.agentHandles.set(sessionId, handle)
        this.convToSession.set(convKey, sessionId)
        this.sessionToConv.set(sessionId, convKey)
        this.ctx.logger.info(`[im-gateway] resumed session ${sessionId} (history kept)`)
        await this.attachToWorkspace(sessionId, effectiveCwd)
        return sessionId
      }
    }


    // 3) Genuinely new conversation → create. ctx.agents.create() mints BOTH
    // the session and the agent loop under this shared identity
    // (CreateAgentOptions contract) — do NOT pre-create the session via
    // ctx.sessions.create, or it throws "session already exists".
    //
    // Defensive fallback: if a persisted log for this id exists but the
    // `list()` check above missed it (backend not yet loaded, timing, or a
    // stale process), create() rejects with an id collision. In that case
    // fall back to resume() so a stable IM conversation is never lost and the
    // user never sees a bare "id collision".
    console.log(`[im-gateway] ensureSession: branch 3 (create new)`)
    let handle: AgentHandle
    console.log(`[im-gateway] ensureSession: effectiveCwd="${effectiveCwd}"`)
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: effectiveCwd },
        agentOptions: this.currentModelFor(sessionId),
        setup: this.presetSetup(sessionId),
      })
    } catch (err) {
      if (isIdCollision(err)) {
        console.log(`[im-gateway] ensureSession: id collision, falling back to resume`)
        handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.currentModelFor(sessionId),
          setup: this.presetSetup(sessionId),
        })
      } else {
        throw err
      }
    }

    this.agentHandles.set(sessionId, handle)

    this.convToSession.set(convKey, sessionId)
    this.sessionToConv.set(sessionId, convKey)
    console.log(`[im-gateway] ensureSession: session created, calling attachToWorkspace`)
    await this.attachToWorkspace(sessionId, effectiveCwd)
    console.log(`[im-gateway] ensureSession: done for ${sessionId}`)
    // 仅在首次对话（generation === 0）时 bump 一次：让后续重启用带时间戳的稳定 id，
    // 避免产生 base id + 变体 id 两个 Session 对象导致 host/client 口径矛盾。
    // 如果 generation 已 > 0（持久化已生效），不要 bump —— 保持 id 稳定才能 resume 同一会话。
    if (generation === 0) {
      const bumped = Date.now()
      this.sessionGenerations.set(convKey, bumped)
      this.persistGenerations()
      console.log(`[im-gateway] ensureSession: first time — bumped gen to ${bumped} for future sessions of ${convKey}`)
    }
    return sessionId
  }

  /**
   * Associate an IM session with the workspace whose canonical path matches its
   * cwd, so the session shows up under the correct project group in the web
   * sidebar instead of the "Ungrouped" bucket.
   *
   * dsh groups the sidebar by Host Workspace: sessions created through the UI
   * attach to a workspace via `session.create(workspaceId)`. Our bare
   * `agents.create({ meta: { cwd } })` only stamps the header cwd — it does NOT
   * enter any workspace's `sessionIds` account, so the session is "stray" and
   * lands in the Ungrouped group (workspace auto-bootstrap only runs once on
   * first init, before our IM sessions exist). Explicitly resolving the cwd's
   * workspace (creating it if the user never opened it) and attaching is the
   * official path (workspaceRegistry.attachSession).
   *
   * Best-effort: workspace grouping must never block or fail an IM turn.
   */
  private async attachToWorkspace(sessionId: SessionId, cwd?: string): Promise<void> {
    try {
      const workspaceRegistry = this.ctx.get('workspaceRegistry') as
        | {
            create(path: string): Promise<{
              attachSession(id: SessionId): Promise<void>
              detachSession?(id: SessionId): Promise<void>
            }>
            list(): Array<{ path: string; sessionIds: string[] }>
          }
        | undefined
      if (!workspaceRegistry) {
        console.warn(`[im-gateway] workspaceRegistry unavailable; session ${sessionId} will be ungrouped`)
        return
      }
      const effectiveCwd = cwd ?? this.config.cwd
      console.log(`[im-gateway] attachToWorkspace: sessionId=${sessionId} cwd="${effectiveCwd}"`)

      // 备份 workspace.json 的 sessionIds（attachSession 中 mutate 会过滤掉 sessionPath 不匹配的旧会话）
      const beforeIds = this.readWorkspaceSessionIds(effectiveCwd)

      const workspace = await workspaceRegistry.create(effectiveCwd)
      // dsh 0.1.6 缺陷：attachSession 对"已 accounted 的稳定 session id"跳过 sessionPaths
      // 内存索引填充（entity.js `if (!record.sessionIds.includes(sessionId))`）。IM session
      // 跨重启 resume 同一稳定 id，进程重启后该 id 仍在 sessionIds 里但丢失内存索引，
      // 投影 `sessionPath(id)===record.path` 把它从 UI 过滤 —— workspace.json 有记录但
      // 侧边栏不渲染。先 detach 再 attach，强制走索引填充分支。
      if (workspace.detachSession) {
        await workspace.detachSession(sessionId).catch(() => undefined)
      }
      await workspace.attachSession(sessionId)
      console.log(`[im-gateway] attachToWorkspace: attachSession succeeded`)
      // DIAG: 打印这个会话在 workspace.json(raw) 与 workspaceRegistry 投影(projected)
      // 中的归属。若 raw 有但 projected 无 → 被 sessionPath 索引过滤，UI 不显示。
      void this.logWorkspaceState(`after attachToWorkspace ${String(sessionId).slice(0, 32)}`)

      // 恢复被 mutate 移除的旧会话（直接写 workspace.json，绕过 mutate 的过滤）
      const afterIds = this.readWorkspaceSessionIds(effectiveCwd)
      const removed = beforeIds.filter((id) => !afterIds.includes(id) && id !== String(sessionId))
      if (removed.length > 0) {
        console.log(`[im-gateway] attachToWorkspace: restoring ${removed.length} sessions removed by mutate: ${JSON.stringify(removed)}`)
        this.restoreWorkspaceSessionIds(effectiveCwd, removed)
      }
    } catch (err) {
      console.warn(`[im-gateway] workspace attach failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
    }
  }

  /** 读取 workspace.json 中指定 path 的 sessionIds。 */
  private readWorkspaceSessionIds(cwd: string): string[] {
    try {
      const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
      const raw = readFileSync(file, 'utf8')
      const data = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { path?: string; sessionIds?: string[] }> } }
      for (const w of Object.values(data.tables?.workspaces ?? {})) {
        if (w.path === cwd) return w.sessionIds ?? []
      }
    } catch { /* ignore */ }
    return []
  }

  /** 把被移除的 sessionIds 写回 workspace.json（直接写文件，不经过 mutate）。 */
  private restoreWorkspaceSessionIds(cwd: string, ids: string[]): void {
    try {
      const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
      const raw = readFileSync(file, 'utf8')
      const data = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { path?: string; sessionIds?: string[]; createdAt?: string; updatedAt?: string }> } }
      for (const w of Object.values(data.tables?.workspaces ?? {})) {
        if (w.path === cwd && w.sessionIds) {
          for (const id of ids) {
            if (!w.sessionIds.includes(id)) w.sessionIds.push(id)
          }
        }
      }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      console.warn(`[im-gateway] restoreWorkspaceSessionIds failed:`, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 诊断：全面记录 workspace 状态。
   * - workspace.json 原始 sessionIds（session-cleaner 用这个判断 active）
   * - workspaceRegistry.list() 投影后 sessionIds（桌面端 UI 用这个显示）
   * - ctx.sessions.list() live sessions（dispose 后会消失）
   * - sessionPersistence.list() 持久化会话（dispose 后仍存在）
   * 如果原始 ≠ 投影，说明 sessionPath 不匹配（会话从 UI 消失但 session-cleaner 仍认为 active）。
   */
  logWorkspaceState(label: string): void {
    try {
      const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
      const raw = readFileSync(file, 'utf8')
      const data = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { path?: string; sessionIds?: string[] }> } }
      const workspaces = data.tables?.workspaces ?? {}
      console.log(`[im-gateway] ${label} ── workspace.json raw sessionIds:`)
      for (const [id, w] of Object.entries(workspaces)) {
        console.log(`[im-gateway]   "${w.path}" → ${JSON.stringify(w.sessionIds)}`)
      }
    } catch { /* ignore */ }

    try {
      const workspaceRegistry = this.ctx.get('workspaceRegistry') as
        | { list(): Array<{ path: string; sessionIds: string[] }> }
        | undefined
      if (workspaceRegistry) {
        const list = workspaceRegistry.list()
        console.log(`[im-gateway] ${label} ── workspaceRegistry.list() projected sessionIds:`)
        for (const ws of list) {
          console.log(`[im-gateway]   "${ws.path}" → ${JSON.stringify(ws.sessionIds)}`)
        }
      }
    } catch { /* ignore */ }

    try {
      const sessions = this.ctx.get('sessions') as
        | { list(): Array<{ id: SessionId; header?: { cwd?: string } }> }
        | undefined
      if (sessions) {
        const live = sessions.list()
        console.log(`[im-gateway] ${label} ── live sessions (${live.length}):`)
        for (const s of live) {
          console.log(`[im-gateway]   ${s.id} cwd="${s.header?.cwd ?? '?'}"`)
        }
      }
    } catch { /* ignore */ }
  }

  /** Compute the initial model selection for a session (override → global → deployment default). */
  currentModelFor(sessionId: SessionId): { provider?: string; model?: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId> } | undefined {
    const override = this.modelOverrides.get(sessionId) ?? this.globalModelOverride
    if (override) {
      return {
        provider: override.provider,
        model: override.model,
        ...(override.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(override.reasoningEffort) }),
      }
    }
    const defaults = this.ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider?: string; model?: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId> } | undefined }
      | undefined
    return defaults?.currentSelection()
  }

  /**
   * Agent setup callback: mount the 'standard' preset (tools, prompt sections,
   * skills) and install model selection into the agent's prompt assembly.
   * Called by agents.create/agents.resume BEFORE the agent is published, so
   * the first prompt assembly has all tools and {{provider}}/{{model}} variables.
   */
  presetSetup(sessionId: SessionId): AgentSetup {
    const gateway = this
    return async (agentCtx: Context) => {
      const presets = gateway.ctx.get('agentPresets') as
        | { mount(agentCtx: Context, id?: string): Promise<unknown> }
        | undefined
      if (presets) {
        await presets.mount(agentCtx, 'standard')
      } else {
        console.warn('[im-gateway] agentPresets not available, agent will have no tools')
      }
      gateway.installModelSelection(agentCtx, sessionId)
    }
  }

  /**
   * Wire the agent-default-model selection into one agent's prompt assembly
   * (mirrors dsh-host-apiproxy selectionFor). Listeners live on the agent's
   * scoped ctx and are torn down with it.
   *
   * The `current` getter returns this session's /model override when set,
   * otherwise the deployment default (`agentDefaultModel`). The setter records
   * an override — that is exactly how the official `session.selectModel`
   * switches the model for one conversation. We keep the ref alive in
   * `modelRefs` so `/model` can mutate `current` on the same object the prompt
   * assembly reads.
   */
  private installModelSelection(agentCtx: Context, sessionId: SessionId): void {
    const gateway = this
    const defaults = this.ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } | undefined }
      | undefined
    const ref: ModelSelectionRef = {
      get current(): ModelSelection | undefined {
        const override = gateway.modelOverrides.get(sessionId) ?? gateway.globalModelOverride
        const base = defaults?.currentSelection() as ModelSelection | undefined
        if (!override) return base ?? undefined
        return {
          provider: override.provider,
          model: override.model,
          ...(override.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(override.reasoningEffort) }),
        }
      },
      set current(next) {
        if (next) {
          gateway.modelOverrides.set(sessionId, {
            provider: next.provider,
            model: next.model,
            ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
          })
        } else {
          gateway.modelOverrides.delete(sessionId)
        }
      },
      assembled: undefined,
    }
    installModelSelection(agentCtx, ref)
    this.modelRefs.set(sessionId, ref)
  }

  private async runTurn(
    sessionId: SessionId,
    convKey: string,
    channel: ImChannelAdapter,
    parts: ContentBlock[],
  ): Promise<void> {
    const convId = convOf(convKey)
    const agent = this.ctx.agents.get(sessionId)
    if (!agent) {
      this.ctx.logger.warn(`[im-gateway] no agent for session ${sessionId}`)
      await channel.sendText(convId, this.t.t('gw.session.notReady'))
      return
    }
    const userMessage: UserMessage = createUserMessage({ content: parts, source: { kind: 'user' } })
    try {
      // `followup` enqueues a user turn; the agent loop produces session events
      // that we receive via ctx.on('session/event').
      agent.followup(userMessage)
    } catch (err) {
      this.ctx.logger.error(`[im-gateway] followup failed for ${convKey}`, err)
      await channel.sendText(convId, this.t.t('gw.followup.failed'))
    }
  }

  /** 清理指定会话的事件状态（CommandHandler /reset 调用）。 */
  clearConversationState(convId: string): void {
    this.eventDispatcher?.disposeConversation(convId)
  }

  /**
   * 从 dsh 全局设置读取界面语言（locale.preference）。
   * 与「设置 → 通用设置 → 语言」联动；settings 不可用时回退中文。
   */
  private resolveLang(): 'zh' | 'en' {
    try {
      const settings = this.ctx.get('settings') as
        | { get(ns: unknown): { preference?: string } | undefined }
        | undefined
      if (!settings) return 'zh'
      const section = settings.get('locale')
      const pref = section?.preference
      return pref === 'en' ? 'en' : 'zh'
    } catch {
      return 'zh'
    }
  }

  // ── im_send_file 工具 ────────────────────────────────────────────────

  /** 注册 im_send_file 工具：agent 把工作区文件发给当前 IM 会话的用户。 */
  private registerSendFileTool(): void {
    const tools = this.ctx.get('tools') as
      | {
          register(def: {
            name: string
            description: string
            parameters: Record<string, unknown>
            output: {
              schema: Record<string, unknown>
              render: (args: unknown, value: unknown) => unknown[]
            }
            execute: (args: unknown, exec: { agent?: { id: SessionId } }) => Promise<unknown>
          }): () => void
        }
      | undefined
    if (!tools?.register) return
    try {
      const disposer = tools.register({
        name: 'im_send_file',
        description:
          this.t.t('gw.sendFile.desc1') +
          this.t.t('gw.sendFile.desc2'),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: this.t.t('gw.sendFile.pathDesc') },
            caption: { type: 'string', description: this.t.t('gw.sendFile.captionDesc') },
          },
          required: ['path'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              detail: { type: 'string' },
            },
            required: ['ok', 'detail'],
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const { path, caption } = args as { path: string; caption?: string }
          const sessionId = exec.agent?.id
          return this.sendFileToChat(path, caption, sessionId ? String(sessionId) : undefined)
        },
      })
      this.disposeTools.push(disposer)
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] im_send_file 工具注册失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 把文件发送到会话关联的渠道（im_send_file 工具的执行体）。 */
  async sendFileToChat(
    filePath: string,
    caption?: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    if (!sessionId) {
      return { ok: false, detail: this.t.t('gw.sendFile.noSession') }
    }
    const convKey = this.sessionToConv.get(sessionId)
    if (!convKey) {
      return { ok: false, detail: this.t.t('gw.sendFile.noChat') }
    }
    const channel = this.channelForConv(convKey)
    if (!channel) {
      return { ok: false, detail: this.t.t('gw.sendFile.noChannel') }
    }
    const convId = convOf(convKey)
    try {
      if (caption) await channel.sendText(convId, caption).catch(() => undefined)
      if (channel.sendMedia) {
        await channel.sendMedia(convId, filePath, caption)
        return { ok: true, detail: this.t.t('gw.sendFile.sent', filePath) }
      }
      // 渠道不支持发送文件 → 降级为文本说明
      await channel.sendText(convId, this.t.t('gw.sendFile.fallbackText', filePath))
      return { ok: true, detail: this.t.t('gw.sendFile.fallbackDetail', filePath) }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, detail: this.t.t('gw.sendFile.failed', detail) }
    }
  }

  // ── im_send_voice 工具 ──────────────────────────────────────────────

  /** 注册 im_send_voice 工具：agent 把文本用 TTS 合成语音发给当前 IM 会话。 */
  private registerSendVoiceTool(): void {
    const tools = this.ctx.get('tools') as
      | {
          register(def: {
            name: string
            description: string
            parameters: Record<string, unknown>
            output: {
              schema: Record<string, unknown>
              render: (args: unknown, value: unknown) => unknown[]
            }
            execute: (args: unknown, exec: { agent?: { id: SessionId } }) => Promise<unknown>
          }): () => void
        }
      | undefined
    if (!tools?.register) return
    try {
      const disposer = tools.register({
        name: 'im_send_voice',
        description: this.t.t('gw.sendVoice.desc'),
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: this.t.t('gw.sendVoice.textDesc') },
            caption: { type: 'string', description: this.t.t('gw.sendVoice.captionDesc') },
          },
          required: ['text'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              detail: { type: 'string' },
            },
            required: ['ok', 'detail'],
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const { text, caption } = args as { text: string; caption?: string }
          const sessionId = exec.agent?.id
          return this.sendVoiceToChat(text, caption, sessionId ? String(sessionId) : undefined)
        },
      })
      this.disposeTools.push(disposer)
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] im_send_voice 工具注册失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 把文本合成为语音发送到会话关联的渠道（im_send_voice 工具的执行体）。
   * 渠道不支持语音 / TTS 未配置 / 合成失败时一律降级为纯文本，保证内容送达。
   */
  async sendVoiceToChat(
    text: string,
    caption?: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    if (!sessionId) {
      return { ok: false, detail: this.t.t('gw.sendVoice.noSession') }
    }
    const convKey = this.sessionToConv.get(sessionId)
    if (!convKey) {
      return { ok: false, detail: this.t.t('gw.sendVoice.noChat') }
    }
    const channel = this.channelForConv(convKey)
    if (!channel) {
      return { ok: false, detail: this.t.t('gw.sendVoice.noChannel') }
    }
    const convId = convOf(convKey)
    const textFallback = async (detail: string): Promise<{ ok: boolean; detail: string }> => {
      if (caption) await channel.sendText(convId, caption).catch(() => undefined)
      await channel.sendText(convId, text).catch(() => undefined)
      return { ok: true, detail }
    }
    if (!channel.synthesizeVoice || !channel.sendVoice) {
      return textFallback(this.t.t('gw.sendVoice.unsupported'))
    }
    try {
      const voice = await channel.synthesizeVoice(text)
      if (!voice) return textFallback(this.t.t('gw.sendVoice.ttsFailed'))
      if (caption) await channel.sendText(convId, caption).catch(() => undefined)
      await channel.sendVoice(convId, voice)
      return { ok: true, detail: this.t.t('gw.sendVoice.sent') }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, detail: this.t.t('gw.sendVoice.failed', detail) }
    }
  }

  // ── 审批桥 ────────────────────────────────────────────────────────────

  /**
   * 处理 approval/request 事件：把审批请求推送到绑定该会话的 IM chat，
   * 等待用户回复「批准/拒绝」。超时或无绑定 chat 时委托回下游（next()）。
   */
  private async handleApprovalRequest(
    req: { agent: { session: { id: string } }; toolName: string; reason?: string; signal?: AbortSignal },
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const sessionId = String(req.agent.session.id)
    const convKey = this.sessionToConv.get(sessionId)
    if (!convKey) return next() // 非 IM 会话 → 委托下游
    const channel = this.channelForConv(convKey)
    if (!channel) return next()
    const convId = convOf(convKey)
    const timeoutMs = this.config.approvalTimeoutSecs * 1000
    const text = [
      this.t.t('gw.approval.title', this.config.approvalTimeoutSecs),
      this.t.t('gw.approval.tool', req.toolName),
      req.reason ? this.t.t('gw.approval.reason', req.reason) : '',
      this.t.t('gw.approval.hint'),
    ].filter(Boolean).join('\n')

    // 结构化审批：渠道支持内联键盘时渲染可点击按钮（点击后 button_data = 按钮 id
    // 经 handleInbound 回传，被识别为 verdict 关键字消费本审批）；否则退回纯文本提示。
    if (channel.sendApprovalRequest) {
      await channel
        .sendApprovalRequest(convId, {
          title: this.t.t('gw.approval.title', this.config.approvalTimeoutSecs),
          body: [
            this.t.t('gw.approval.tool', req.toolName),
            req.reason ? this.t.t('gw.approval.reason', req.reason) : '',
            this.t.t('gw.approval.hint'),
          ]
            .filter(Boolean)
            .join('\n'),
          timeoutSecs: this.config.approvalTimeoutSecs,
          actions: [
            { id: 'allow', label: this.t.t('gw.auth.approve'), style: 1 },
            { id: 'reject', label: this.t.t('gw.auth.reject'), style: 0 },
          ],
        })
        .catch((err) =>
          this.ctx.logger.warn(
            `[im-gateway] sendApprovalRequest failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
    } else {
      await channel.sendText(convId, text).catch(() => undefined)
    }
    const verdict = await this.approvalBroker.wait(sessionId, timeoutMs, req.signal)
    if (verdict === 'allow') return 'allowed-once'
    if (verdict === 'reject') return 'rejected'
    return next()
  }

  /** IM 侧答复审批。有 pending 则消费并回复确认，无 pending 返回 false。 */
  private async answerApproval(channel: ImChannelAdapter, message: ImInboundMessage, allow: boolean): Promise<boolean> {
    const convKey = `${message.channelId}:${message.conversationId}`
    const sessionId = this.convToSession.get(convKey)
    if (!sessionId) return false
    const answered = this.approvalBroker.answer(String(sessionId), allow)
    if (answered) {
      const convId = convOf(convKey)
      await channel.sendText(convId, allow ? this.t.t('gw.approval.approved') : this.t.t('gw.approval.rejected')).catch(() => undefined)
    }
    return answered
  }

  // ── 提问桥 ────────────────────────────────────────────────────────────

  /**
   * 包装 ctx.userQuestions.ask：当 agent 提问时，把问题推送到绑定该会话的 IM chat，
   * 与 Web 端竞速，第一答生效。无绑定 IM 会话时委托回原始 ask。
   */
  private installQuestionBridge(): void {
    const service = this.ctx.get('userQuestions') as
      | { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }
      | undefined
    if (!service?.ask) return

    const originalAsk = service.ask.bind(service)
    const gateway = this

    const wrappedAsk = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
      const sessionId = request.agent ? String(request.agent.session.id) : ''
      const convKey = sessionId ? gateway.sessionToConv.get(sessionId) : undefined
      if (!sessionId || !convKey) return originalAsk(request)

      const channel = gateway.channelForConv(convKey)
      if (!channel) return originalAsk(request)

      const convId = convOf(convKey)
      const timeoutSecs = Math.max(1, gateway.config.questionTimeoutSecs)
      const timeoutMs = timeoutSecs * 1000
      const webAbort = new AbortController()
      const forwardAbort = () => webAbort.abort(request.signal?.reason)
      request.signal?.addEventListener('abort', forwardAbort, { once: true })

      const imWait = gateway.questionBroker.wait(sessionId, request.questions, timeoutMs, request.signal)
      await channel
        .sendText(convId, formatQuestionPrompt(request.questions, timeoutSecs, this.t))
        .catch(() => undefined)
      gateway.ctx.logger.info(`[im-gateway] 提问已同步到 ${convKey}（${request.questions.length} 个问题）`)

      const webWait = originalAsk({ ...request, signal: webAbort.signal }).then(
        (answer) => ({ kind: 'web' as const, answer }),
        (error: unknown) => ({ kind: 'web-error' as const, error }),
      )

      const finishWeb = async (): Promise<AskUserQuestionAnswer> => {
        const web = await webWait
        if (web.kind === 'web-error') throw web.error
        gateway.questionBroker.finishFromWeb(sessionId, web.answer)
        await channel
          .sendText(convId, this.t.t('gw.question.answeredWeb', formatAnswerSummary(request.questions, web.answer)))
          .catch(() => undefined)
        return web.answer
      }

      try {
        const first = await Promise.race([webWait, imWait])
        if (first.kind === 'web') {
          gateway.questionBroker.finishFromWeb(sessionId, first.answer)
          await channel
            .sendText(convId, this.t.t('gw.question.answeredWeb', formatAnswerSummary(request.questions, first.answer)))
            .catch(() => undefined)
          return first.answer
        }
        if (first.kind === 'web-error') {
          gateway.questionBroker.cancel(sessionId)
          throw first.error
        }
        if (first.kind === 'answered') {
          webAbort.abort()
          void webWait
          await channel
            .sendText(
              convId,
              this.t.t('gw.question.answeredIM', formatAnswerSummary(request.questions, first.answer), first.source.label ?? first.source.channelId),
            )
            .catch(() => undefined)
          return first.answer
        }
        if (first.kind === 'external') return first.answer
        if (first.kind === 'timeout') {
          await channel.sendText(convId, this.t.t('gw.question.timeout')).catch(() => undefined)
        }
        // cancelled / busy / timeout：Web provider 仍是最终兜底
        return finishWeb()
      } finally {
        request.signal?.removeEventListener('abort', forwardAbort)
      }
    }

    service.ask = wrappedAsk
    this.restoreUserQuestionsAsk = () => {
      if (service.ask === wrappedAsk) service.ask = originalAsk
    }
  }

  /** IM 侧答复提问。有 pending 则尝试解析，成功/无效/已答过都消费（不转发 agent）。 */
  private async answerQuestion(channel: ImChannelAdapter, message: ImInboundMessage): Promise<boolean> {
    const convKey = `${message.channelId}:${message.conversationId}`
    const sessionId = this.convToSession.get(convKey)
    if (!sessionId) return false
    const sid = String(sessionId)
    const questions = this.questionBroker.questionsFor(sid)
    const result = this.questionBroker.answer(sid, message.text, {
      channelId: message.channelId,
      conversationId: message.conversationId,
      label: channel.label,
    })
    if (result.kind === 'not-pending') return false
    const convId = convOf(convKey)
    if (result.kind === 'invalid') {
      await channel.sendText(convId, this.t.t('gw.question.invalid', result.message)).catch(() => undefined)
      return true
    }
    if (result.kind === 'already-answered') {
      await channel.sendText(convId, `ℹ️ ${result.message}`).catch(() => undefined)
      return true
    }
    if (questions) {
      this.ctx.logger.info(`[im-gateway] 提问由 ${convKey} 回答：${formatAnswerSummary(questions, result.answer)}`)
    }
    return true
  }

  // ── 白名单 ────────────────────────────────────────────────────────────

  /** 检查用户是否在白名单中。渠道本地授权优先，其次全局白名单和 UI 批准。 */
  private authorized(channelId: string, userId?: string): boolean {
    if (this.config.allowAllUsers) return true
    if (!userId) return false
    const perChannel = this.config.allowedUserIds[channelId]
    if (perChannel && perChannel.includes(userId)) return true
    // 扁平兜底：keys 为 '*' 时按全局名单
    const global = this.config.allowedUserIds['*']
    if (global && global.includes(userId)) return true
    // UI 批准的渠道白名单
    const extra = this.extraAllowlist.get(channelId)
    if (extra && extra.has(userId)) return true
    return false
  }

  /** 添加 UI 批准的白名单用户（manager 同步调用；重启后需重新灌入）。 */
  addAuthorizedUser(channelId: string, userId: string): void {
    let set = this.extraAllowlist.get(channelId)
    if (!set) {
      set = new Set()
      this.extraAllowlist.set(channelId, set)
    }
    set.add(userId)
  }


  // ── helpers ────────────────────────────────────────────────────────────

  private channelForConv(convKey: string): ImChannelAdapter | undefined {
    const channelId = convKey.slice(0, convKey.indexOf(':'))
    return this.channels.get(channelId)
  }
}

/** convKey = `channelId:conversationId` → conversationId (supports ':' inside it). */
function convOf(convKey: string): string {
  return convKey.slice(convKey.indexOf(':') + 1)
}

/**
 * Build dsh ContentBlock[] from a normalized inbound message.
 *
 * PoC is TEXT-ONLY. Real multimodal requires registering raw bytes with the
 * `@deepseek-ai/dsh-attachment` service to obtain an `ImageAttachmentRef`
 * (the actual `ImageBlock` shape is `{ type: 'image'; attachment }`, NOT inline
 * base64). That is a tracked seam: inbound images currently arrive as the
 * "[图片]" text note the channel adapter emits. Wire `ctx.attachments` before
 * enabling vision.
 */
function toContentBlocks(message: ImInboundMessage): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (message.text) {
    // In group chats, attribute who spoke so the agent can tell members apart
    // (pi-desk-top prefixes the sender in multi-user conversations).
    const text = message.isGroup && message.senderNick ? `[@${message.senderNick}] ${message.text}` : message.text
    blocks.push({ type: 'text', text })
  }
  return blocks
}


/**
 * Whether an error is a session-persistence id collision. The persistence
 * coordinator throws several distinct collision messages; match on the
 * stable substring instead of the error class (which can be duplicated when a
 * dependency is inlined into the bundle).
 */
function isIdCollision(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes('id collision')
    || message.includes('already has a persisted log')
    // SessionPersistence-jsonl 后端对已存在 session 的精确报错
    || message.includes('already exists')
  )
}

/**
 * Canonicalize a filesystem path via `realpathSync`. Returns the realpath
 * result when the path exists, otherwise the input as-is (with trailing
 * slashes stripped if possible). The workspace registry and session
 * persistence both expect canonical paths — passing a raw value that differs
 * only by a trailing separator or symlink makes attachSession reject and the
 * session disappears from the web sidebar.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    // Path may not exist yet (workspace registry create validates existence
    // itself). Still strip trailing separators to match what realpath would
    // produce on an existing directory.
    return p.replace(/[\\/]+$/, '')
  }
}
