/**
 * 微信(iLink) channel adapter — 个人微信渠道的实现载体。
 *
 * Ported from pi-desk-top/src/main/im/weixin/weixin-adapter.ts. WeChat is
 * single-chat only (the bot is bound to one personal account via QR scan),
 * so every inbound message maps to a direct conversation keyed by the
 * sender's user id.
 *
 * Outbound: agent text is passed through StreamingMarkdownFilter (WeChat
 * renders no markdown) and sent via sendmessage with the per-conversation
 * context_token (persisted so replies survive restarts).
 *
 * Adapter contract mapping (vs the reference project):
 *   onMessage(msg)            → ctx.imGateway.handleInbound(message)
 *   onStatusChange(ImStatus)  → statusListener(ChannelStatus)   online/offline/error
 *   sessionKey (weixin:id:uid)→ conversationId = userId
 *   ImImage {type,data,mimeType} → {mediaType, data}  (base64, no data: prefix)
 *   getAgentDir() persistence → ~/.dsh/im-gateway/weixin-<botId>.json
 */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import os from 'node:os'
import type { ChannelStatus, ImChannelAdapter, ImInboundMessage, ImImage, WeixinChannelConfig } from '../gateway/types'
import {
  getConfig,
  getUpdates,
  notifyStart,
  notifyStop,
  sendMessage,
  sendTyping,
} from './weixin-api'
import type { MessageItem, WeixinMessage } from './weixin-types'
import {
  MessageItemType,
  MessageState,
  MessageType,
  TypingStatus,
} from './weixin-types'
import { StreamingMarkdownFilter } from './markdown-filter'
import {
  DEFAULT_CDN_BASE_URL,
  downloadAndDecryptBufferBounded,
  uploadLocalFileToWeixin,
} from './weixin-media'

const LONG_POLL_TIMEOUT_MS = 35_000
const BASE_BACKOFF_DELAY = 2_000
const MAX_BACKOFF_DELAY = 30_000
const TYPING_INTERVAL_MS = 5_000
/** getupdates returns this errcode when the bot token / session expired. */
const SESSION_EXPIRED_ERRCODE = -14
/** How long to pause polling after a session-expired error. */
const SESSION_PAUSE_MS = 5 * 60_000

/** Give up on one inbound image download after this long (falls back to text). */
const INBOUND_IMAGE_TIMEOUT_MS = 15_000
/** Inbound image ciphertext cap; larger objects fall back to the [图片] note. */
const INBOUND_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** Base URL used unless the QR login returned a different one. */
export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  )
}

/** Guess the MIME type from a decrypted image's magic bytes. */
function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return 'image/png'
  if (buf.length >= 3 && buf.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))
    return 'image/jpeg'
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'GIF87a')
    return 'image/gif'
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'GIF89a')
    return 'image/gif'
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'RIFF')
    return 'image/webp'
  return 'image/jpeg'
}

/** True when a path points at a local file (drive letter, /, ~, file://). */
function isLocalPath(raw: string): boolean {
  return (
    raw.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(raw) ||
    raw.startsWith('/') ||
    raw.startsWith('~')
  )
}

/** Strip file:// / URL-encoding to get the on-disk absolute path. */
function toLocalPath(raw: string): string {
  let p = raw.startsWith('file://') ? raw.slice('file://'.length) : raw
  try {
    p = decodeURIComponent(p)
  } catch {
    /* keep as-is */
  }
  return p
}

/** Extract the plain-text body from an item list (quotes + voice-to-text). */
function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return ''
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) return text
      if (ref.message_item && isMediaItem(ref.message_item)) return text
      const parts: string[] = []
      if (ref.title) parts.push(ref.title)
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item])
        if (refBody) parts.push(refBody)
      }
      if (!parts.length) return text
      return `[引用: ${parts.join(' | ')}]\n${text}`
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}

/** client_id for outbound messages — random per message. */
function generateClientId(): string {
  return `pi-weixin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Per-bot state directory: ~/.dsh/im-gateway (survives restarts). */
function stateDir(): string {
  return join(os.homedir(), '.dsh', 'im-gateway')
}

class WeixinAdapter implements ImChannelAdapter {
  /** 5-minute TTL — matches pi-desktop feishu/dingtalk connection dedup. */
  private static readonly DEDUP_TTL_MS = 5 * 60 * 1000

  private token: string
  private botId: string
  private baseUrl: string
  private cdnBaseUrl: string
  private stopped = true
  private active = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private typingTimer: ReturnType<typeof setTimeout> | null = null
  private typingTarget: string | null = null
  /** Seen message ids → timestamp — deduplicates poller replay of old frames. */
  private readonly seenMsgIds = new Map<string, number>()

  /** get_updates_buf cursor — persisted for restart continuity. */
  private updatesBuf = ''
  /** Per-conversation context tokens (persisted). */
  private contextTokens = new Map<string, string>()
  /** Per-user typing_ticket from getconfig (needed for sendTyping). */
  private typingTickets = new Map<string, string>()

  /** Runtime-status sink, assigned by the gateway on registration. */
  statusListener?: (status: ChannelStatus) => void

  constructor(
    private readonly ctx: Context,
    config: WeixinChannelConfig,
    /** Instance id (e.g. 'weixin-main') — unique per bot, registry key. */
    readonly id: string,
    /** Display label (instance name or the channel type name). */
    readonly label: string,
  ) {
    this.token = config.token ?? ''
    this.botId = config.botId ?? ''
    this.baseUrl = config.baseUrl?.trim() || DEFAULT_WEIXIN_BASE_URL
    this.cdnBaseUrl = config.cdnBaseUrl?.trim() || DEFAULT_CDN_BASE_URL
  }

  isActive(): boolean {
    return this.active
  }

  private setStatus(s: 'online' | 'offline' | 'error', error?: string): void {
    this.statusListener?.({ status: s, error, lastChange: Date.now() })
  }

  private stateFilePath(name: string): string {
    return join(stateDir(), `weixin-${name}-${this.botId || 'unbound'}.json`)
  }

  private restoreState(): void {
    try {
      const bufPath = this.stateFilePath('syncbuf')
      if (existsSync(bufPath)) {
        const parsed = JSON.parse(readFileSync(bufPath, 'utf-8'))
        if (typeof parsed.buf === 'string') this.updatesBuf = parsed.buf
      }
    } catch {
      /* corrupt state — start fresh */
    }
    try {
      const tokPath = this.stateFilePath('context-tokens')
      if (existsSync(tokPath)) {
        const parsed = JSON.parse(readFileSync(tokPath, 'utf-8')) as Record<string, string>
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v) this.contextTokens.set(k, v)
        }
      }
    } catch {
      /* ignore */
    }
  }

  private persistBuf(): void {
    try {
      mkdirSync(stateDir(), { recursive: true })
      writeFileSync(
        this.stateFilePath('syncbuf'),
        JSON.stringify({ buf: this.updatesBuf }),
        'utf-8',
      )
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-weixin:${this.id}] persist syncbuf failed: ${String(err)}`)
    }
  }

  private persistContextTokens(): void {
    try {
      mkdirSync(stateDir(), { recursive: true })
      writeFileSync(
        this.stateFilePath('context-tokens'),
        JSON.stringify(Object.fromEntries(this.contextTokens)),
        'utf-8',
      )
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-weixin:${this.id}] persist context tokens failed: ${String(err)}`)
    }
  }

  private contextTokenKey(userId: string): string {
    return `${this.botId}:${userId}`
  }

  async start(): Promise<void> {
    if (!this.token) {
      this.ctx.logger.warn(`[im-channel-weixin:${this.id}] token missing — scan the QR code first`)
      this.setStatus('error', 'token missing — scan the QR code first')
      return
    }
    this.stopped = false
    this.restoreState()
    try {
      await notifyStart({ baseUrl: this.baseUrl, token: this.token, timeoutMs: 10_000 }).catch(
        () => undefined,
      )
    } catch {
      /* notifyStart is best-effort */
    }
    this.active = true
    this.setStatus('online')
    this.schedulePoll(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.stopTyping()
    try {
      await notifyStop({ baseUrl: this.baseUrl, token: this.token, timeoutMs: 10_000 }).catch(
        () => undefined,
      )
    } catch {
      /* best-effort */
    }
    this.active = false
    this.setStatus('offline')
  }

  // ── Polling loop ──

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return
    this.pollTimer = setTimeout(() => void this.pollOnce(), delayMs)
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) return
    try {
      const resp = await getUpdates({
        baseUrl: this.baseUrl,
        token: this.token,
        get_updates_buf: this.updatesBuf,
        timeoutMs: LONG_POLL_TIMEOUT_MS,
      })
      this.reconnectAttempts = 0
      if (!this.active) {
        this.active = true
        this.setStatus('online')
      }

      // Success responses may omit `ret` entirely — only treat a PRESENT
      // non-zero ret/errcode as an API error (mirrors the official connector).
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0)
      if (isApiError) {
        const expired =
          resp.errcode === SESSION_EXPIRED_ERRCODE ||
          resp.ret === SESSION_EXPIRED_ERRCODE
        this.ctx.logger.warn(
          `[im-channel-weixin:${this.id}] getUpdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}` +
            (expired ? ' — session expired, pausing' : ''),
        )
        // Session expired (token invalid): pause instead of hammering the API
        // and surface an "error" status so the UI can prompt a re-scan.
        if (expired) this.setStatus('error', 'session expired — re-scan the QR code')
        this.schedulePoll(expired ? SESSION_PAUSE_MS : 2_000)
        return
      }
      if (resp.get_updates_buf && resp.get_updates_buf !== this.updatesBuf) {
        this.updatesBuf = resp.get_updates_buf
        this.persistBuf()
      }
      for (const msg of resp.msgs ?? []) {
        try {
          await this.handleMessage(msg)
        } catch (err) {
          this.ctx.logger.warn(`[im-channel-weixin:${this.id}] handleMessage failed: ${String(err)}`)
        }
      }
      // Long-poll returns quickly when idle — small delay to avoid busy loop.
      this.schedulePoll(resp.msgs?.length ? 100 : 300)
    } catch (err) {
      const attempt = this.reconnectAttempts
      this.reconnectAttempts += 1
      const backoff = Math.min(
        MAX_BACKOFF_DELAY,
        BASE_BACKOFF_DELAY * 2 ** Math.min(attempt, 5),
      )
      this.active = false
      this.setStatus('error', `poll error: ${String(err)}`)
      this.ctx.logger.warn(`[im-channel-weixin:${this.id}] poll error (${attempt}), retry in ${backoff}ms: ${String(err)}`)
      this.schedulePoll(backoff)
    }
  }

  /**
   * Forward an inbound message to the gateway service. Resolved via
   * `ctx.get('imGateway')` — NOT property access — because the adapter's ctx
   * is NOT within imGateway's inject scope. Property access throws
   * `cannot get property "imGateway" without inject` once the message handler
   * runs outside the boot fiber (see the sync.ts design note). Matches the
   * pattern already used in remote.ts:saveConfig.
   */
  private deliver(msg: ImInboundMessage): Promise<void> {
    const gw = this.ctx.get('imGateway') as { handleInbound(m: ImInboundMessage): Promise<void> } | undefined
    return gw ? gw.handleInbound(msg) : Promise.resolve()
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    const fromUserId = msg.from_user_id ?? ''
    if (!fromUserId) return
    // Only inbound USER messages (ignore our own echoes).
    if (msg.message_type === MessageType.BOT) return

    // ── Dedup guard: long-poll may replay buffered frames on reconnect ──
    const msgId = msg.message_id ?? msg.seq ?? msg.client_id
    if (msgId != null) {
      const msgKey = String(msgId)
      const now = Date.now()
      for (const [k, ts] of this.seenMsgIds) {
        if (now - ts > WeixinAdapter.DEDUP_TTL_MS) this.seenMsgIds.delete(k)
      }
      if (this.seenMsgIds.has(msgKey)) {
        this.ctx.logger.debug(`[im-channel-weixin:${this.id}] duplicate message ${msgKey} — skipped`)
        return
      }
      this.seenMsgIds.set(msgKey, now)
    }
    const text = bodyFromItemList(msg.item_list)
    if (msg.context_token) {
      this.contextTokens.set(this.contextTokenKey(fromUserId), msg.context_token)
      this.persistContextTokens()
    }
    // Download + decrypt any inbound images so the agent sees them
    // (multi-modal). Other media types are ignored for now.
    const images: ImImage[] = []
    // Set when an image could not be downloaded/decrypted: the message must
    // still reach the agent as a `[图片]` note instead of being dropped.
    let imageFailed = false
    for (const item of msg.item_list ?? []) {
      if (item.type !== MessageItemType.IMAGE || !item.image_item) continue
      const img = item.image_item
      if (!img.media) continue
      try {
        const aesKeyBase64 = img.aeskey
          ? Buffer.from(img.aeskey, 'hex').toString('base64')
          : img.media.aes_key
        if (!aesKeyBase64) continue
        const buf = await downloadAndDecryptBufferBounded({
          encryptedQueryParam: img.media.encrypt_query_param ?? '',
          aesKeyBase64,
          cdnBaseUrl: this.cdnBaseUrl,
          label: 'weixin image',
          fullUrl: img.media.full_url,
          timeoutMs: INBOUND_IMAGE_TIMEOUT_MS,
          maxBytes: INBOUND_IMAGE_MAX_BYTES,
        })
        images.push({
          mediaType: sniffImageMime(buf),
          data: buf.toString('base64'),
        })
      } catch (err) {
        imageFailed = true
        this.ctx.logger.warn(
          `[im-channel-weixin:${this.id}] image download/decrypt failed —— 退回 [图片] 文本: ${String(err)}`,
        )
      }
    }
    // 纯图消息（没配文字）以前会因为 text 为空被整条丢掉；这里给它一句兜底文本，
    // 让网关至少能把「有人发了一张图」这件事交给 agent。
    const bodyText = text || (imageFailed && images.length === 0 ? '[图片]' : '')
    if (!bodyText && images.length === 0) return
    const message: ImInboundMessage = {
      channelId: this.id,
      conversationId: fromUserId,
      userId: fromUserId,
      text: bodyText,
      images: images.length ? images : undefined,
      messageId: String(msg.message_id ?? msg.seq ?? msg.client_id ?? ''),
    }
    void this.deliver(message).catch((err) =>
      this.ctx.logger.error(`[im-channel-weixin:${this.id}] handleInbound failed`, err),
    )
  }

  // ── Outbound ──

  async sendText(conversationId: string, text: string): Promise<void> {
    // `conversationId` is the from_user_id.
    const contextToken = this.contextTokens.get(this.contextTokenKey(conversationId))
    const enriched = await this.sendMediaForText(conversationId, text, contextToken)
    const filter = new StreamingMarkdownFilter()
    const filtered = filter.feed(enriched) + filter.flush()
    if (!filtered.trim()) return
    const req = {
      msg: {
        from_user_id: '',
        to_user_id: conversationId,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: filtered } }],
        context_token: contextToken ?? undefined,
      },
    }
    await sendMessage({
      baseUrl: this.baseUrl,
      token: this.token,
      timeoutMs: 15_000,
      body: req,
    })
    this.stopTyping()
  }

  async sendImage(conversationId: string, image: ImImage): Promise<void> {
    // Reference used a temp-file write for media; keep it minimal: write the
    // base64 to a temp file then run the same upload path as sendMediaForText.
    const tmpPath = join(os.tmpdir(), `weixin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.img`)
    try {
      writeFileSync(tmpPath, Buffer.from(image.data, 'base64'))
      const contextToken = this.contextTokens.get(this.contextTokenKey(conversationId))
      await this.sendLocalMedia(conversationId, tmpPath, contextToken)
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-weixin:${this.id}] sendImage failed: ${String(err)}`)
    }
  }

  async sendMedia(conversationId: string, filePath: string, caption?: string): Promise<void> {
    if (!existsSync(filePath)) {
      this.ctx.logger.warn(`[im-channel-weixin:${this.id}] sendMedia: path does not exist: ${filePath}`)
      return
    }
    if (caption) {
      await this.sendText(conversationId, caption)
    }
    const contextToken = this.contextTokens.get(this.contextTokenKey(conversationId))
    await this.sendLocalMedia(conversationId, filePath, contextToken)
  }

  /**
   * Detect local image/file paths in a reply, upload each to the CDN and
   * send it as a standalone media message (IMAGE / FILE). Returns the text
   * with the references replaced by short notes.
   */
  private async sendMediaForText(
    conversationId: string,
    text: string,
    contextToken?: string,
  ): Promise<string> {
    let result = text
    // 1. markdown image syntax: ![alt](<local path>)
    for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      const [full, alt, p] = m
      if (!isLocalPath(p)) continue
      const filePath = toLocalPath(p)
      if (!existsSync(filePath)) continue
      await this.sendLocalMedia(conversationId, filePath, contextToken)
      result = result.replace(full, alt ? `[${alt}]` : '[图片]')
    }
    // 2. bare absolute paths that exist on disk (the AI often writes
    //    "saved to C:\x\a.png" without any marker).
    const bareFile =
      /(?:file:\/\/)?[A-Za-z]:[\\/][^\s"'()<>]+|(?:\/(?:Users|home|tmp|var|private|root)\/[^\s"'()<>]+)/g
    for (const m of result.matchAll(bareFile)) {
      const filePath = toLocalPath(m[0])
      if (!existsSync(filePath)) continue
      const ok = await this.sendLocalMedia(conversationId, filePath, contextToken)
      if (ok) {
        const isImg = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath)
        result = result.replace(m[0], isImg ? '[图片]' : `[文件已发送：${basename(filePath)}]`)
      }
    }
    return result
  }

  /** Upload one local file and send it as an IMAGE/FILE media message. */
  private async sendLocalMedia(
    conversationId: string,
    filePath: string,
    contextToken?: string,
  ): Promise<boolean> {
    try {
      const isImage = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath)
      const uploaded = await uploadLocalFileToWeixin({
        filePath,
        toUserId: conversationId,
        mediaType: isImage ? 1 : 3, // IMAGE | FILE
        baseUrl: this.baseUrl,
        token: this.token,
        cdnBaseUrl: this.cdnBaseUrl,
      })
      const media: MessageItem = isImage
        ? {
            type: MessageItemType.IMAGE,
            image_item: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: Buffer.from(uploaded.aeskey, 'hex').toString('base64'),
                encrypt_type: 1,
              },
              mid_size: uploaded.fileSizeCiphertext,
            },
          }
        : {
            type: MessageItemType.FILE,
            file_item: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: Buffer.from(uploaded.aeskey, 'hex').toString('base64'),
                encrypt_type: 1,
              },
              file_name: basename(filePath),
              len: String(uploaded.fileSize),
            },
          }
      await sendMessage({
        baseUrl: this.baseUrl,
        token: this.token,
        timeoutMs: 15_000,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: conversationId,
            client_id: generateClientId(),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [media],
            context_token: contextToken ?? undefined,
          },
        },
      })
      return true
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-weixin:${this.id}] media send failed (${filePath}): ${String(err)}`)
      return false
    }
  }

  /**
   * Fetch (and cache) the per-user typing_ticket from getconfig — required
   * by sendtyping. Mirrors the official connector's per-user config cache.
   */
  private async ensureTypingTicket(userId: string): Promise<string | undefined> {
    const cached = this.typingTickets.get(userId)
    if (cached) return cached
    try {
      const ctxToken = this.contextTokens.get(this.contextTokenKey(userId))
      const resp = await getConfig({
        baseUrl: this.baseUrl,
        token: this.token,
        ilinkUserId: userId,
        contextToken: ctxToken,
      })
      if (resp.typing_ticket) {
        this.typingTickets.set(userId, resp.typing_ticket)
        return resp.typing_ticket
      }
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-weixin:${this.id}] getConfig (typing ticket) failed: ${String(err)}`)
    }
    return undefined
  }

  async sendTyping(conversationId: string): Promise<void> {
    this.typingTarget = conversationId
    if (this.typingTimer) return
    const ticket = await this.ensureTypingTicket(conversationId)
    if (!ticket) return
    const fire = () => {
      if (!this.typingTarget) return
      sendTyping({
        baseUrl: this.baseUrl,
        token: this.token,
        timeoutMs: 10_000,
        body: {
          ilink_user_id: this.typingTarget,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        },
      }).catch(() => undefined)
      this.typingTimer = setTimeout(fire, TYPING_INTERVAL_MS)
    }
    fire()
  }

  /** Stop the keepalive and send the cancel typing status (status=2). */
  private stopTyping(): void {
    const target = this.typingTarget
    if (this.typingTimer) clearTimeout(this.typingTimer)
    this.typingTimer = null
    this.typingTarget = null
    const ticket = target ? this.typingTickets.get(target) : undefined
    if (target && ticket) {
      sendTyping({
        baseUrl: this.baseUrl,
        token: this.token,
        timeoutMs: 10_000,
        body: {
          ilink_user_id: target,
          typing_ticket: ticket,
          status: TypingStatus.CANCEL,
        },
      }).catch(() => undefined)
    }
  }
}

/** Export the adapter class for the single-entry bundle to instantiate. */
export { WeixinAdapter }
