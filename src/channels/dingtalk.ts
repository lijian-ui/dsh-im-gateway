/**
 * DingTalk channel adapter — implements ImChannelAdapter over the stream
 * connection. Converts DingTalk bot messages into ImInboundMessage and routes
 * replies back through the sessionWebhook carried on each inbound message.
 *
 * PORTED FROM: pi-desk-top/src/main/im/dingtalk/dingtalk-adapter.ts
 * (inbound coverage: text + quote replies, picture, richText image+text,
 * audio recognition, file note). Outbound uses the per-message sessionWebhook
 * (the only channel that honors `@` in groups); single-chat replies also go
 * through it as markdown.
 *
 * PoC SCOPE: streaming via `updateCard` is intentionally NOT implemented here —
 * the gateway falls back to a single `sendText` at `turn/end`, which is enough
 * to verify the host session/event subscription seam end-to-end. AI-card
 * streaming can be layered on later (see dingtalk-card.ts in the reference).
 */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { ChannelStatus, ImChannelAdapter, ImInboundMessage, ImImage, DingtalkChannelConfig } from '../gateway/types'
import { DingtalkConnection } from './dingtalk-connection'
import {
  createDingtalkCard,
  finishDingtalkCard,
  streamDingtalkCard,
  type AICardInstance,
  type AICardTarget,
} from './dingtalk-card'

interface DingtalkMessageData {
  senderStaffId?: string
  senderId?: string
  conversationId?: string
  conversationType?: string // "1" single, "2" group
  msgtype?: string
  text?: Record<string, any> // may embed isReplyMsg/repliedMsg
  picture?: { downloadCode?: string }
  content?: unknown // JSON string or object — payload for picture/richText etc.
  msgId?: string
  isInAtList?: boolean
  senderNick?: string
  conversationTitle?: string
  /** Per-session reply webhook — group/single reply channel that honors `at`. */
  sessionWebhook?: string
}

interface PeerInfo {
  isGroup: boolean
  userId: string
  encryptedId?: string
  webhook?: string
  senderNick?: string
}

// ── inbound helpers (ported) ──────────────────────────────────────────────

function parseJsonish(raw: unknown): any | null {
  if (raw == null) return null
  if (typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* non-JSON — ignore */
    }
  }
  return null
}

/** DingTalk stream messages carry the payload in `content` (a JSON STRING). */
function resolveDingtalkContent(data: DingtalkMessageData): any | null {
  return parseJsonish(data?.content)
}

/**
 * Remove a leading `@name ` mention that DingTalk injects onto group messages.
 * Matches either "@Name " (no whitespace inside the handle) or the bracket form
 * "@[Name] " some clients emit. Returns the text unchanged if no mention lead.
 */
function stripLeadingMention(text: string): string {
  return text.replace(/^@\[?([^\]\s]+)\]?\s*/, '')
}

function extractQuotedText(container: any): string {
  const content = parseJsonish(container?.repliedMsg?.content)
  switch (container?.repliedMsg?.msgType) {
    case 'text':
      return content?.text ?? ''
    case 'picture':
      return '[图片]'
    case 'audio':
      return content?.recognition ?? '[语音消息]'
    case 'file':
      return `[文件: ${content?.fileName ?? '?'}]`
    case 'richText':
      return (content?.richText ?? []).map((i: any) => i?.text ?? '').join('')
    default:
      return ''
  }
}

function extractQuotedMedia(container: any): string[] {
  const content = parseJsonish(container?.repliedMsg?.content)
  if (container?.repliedMsg?.msgType === 'picture') {
    return content?.downloadCode ? [content.downloadCode] : []
  }
  if (container?.repliedMsg?.msgType === 'richText') {
    return (content?.richText ?? [])
      .map((i: any) => i?.downloadCode ?? '')
      .filter(Boolean)
  }
  return []
}

// ── adapter ───────────────────────────────────────────────────────────────

class DingtalkAdapter implements ImChannelAdapter {
  /** 5-minute TTL — matches pi-desktop feishu/dingtalk connection dedup. */
  private static readonly DEDUP_TTL_MS = 5 * 60 * 1000

  private conn: DingtalkConnection | null = null
  private active = false
  private token: { value: string; expiresAt: number } | null = null
  /**
   * peer → reply context. The userId (senderStaffId) drives group replies: we
   * @ the last user who talked to the bot in that conversation. encryptedId
   * (senderId) is the encrypted form some @ channels need. The webhook is the
   * group/single reply channel that actually honors `at`.
   */
  private peerInfo = new Map<string, PeerInfo>()
  /** Runtime-status sink, assigned by the gateway on registration (ChannelStatus broadcast). */
  statusListener?: (status: ChannelStatus) => void
  /** Active AI card per conversation — one streaming card at a time per peer. */
  private cards = new Map<string, AICardInstance | null>()
  /** Seen message ids → timestamp — adapter-level dedup as a belt-and-braces guard. */
  private readonly seenMsgIds = new Map<string, number>()

  constructor(
    private readonly ctx: Context,
    private readonly config: DingtalkChannelConfig,
    /** Instance id (e.g. 'dingtalk-main') — unique per bot, registry key. */
    readonly id: string,
    /** Display label (instance name or the channel type name). */
    readonly label: string,
  ) {}

  isActive(): boolean {
    return this.active
  }

  async start(): Promise<void> {
    if (!this.config.clientId || !this.config.clientSecret) {
      this.ctx.logger.warn(`[im-channel-dingtalk:${this.id}] clientId/clientSecret missing; not connecting`)
      this.statusListener?.({ status: 'offline', lastChange: Date.now() })
      return
    }
    this.conn = new DingtalkConnection({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      onMessage: (rawData, headers) => void this.handleRaw(rawData, headers),
      onStatusChange: (connected) => {
        this.active = connected
        this.statusListener?.({ status: connected ? 'online' : 'offline', lastChange: Date.now() })
        this.ctx.logger.info(`[im-channel-dingtalk] ${connected ? 'connected' : 'disconnected'}`)
      },
    })
    try {
      await this.conn.connect()
      this.active = true
    } catch (err) {
      this.active = false
      this.statusListener?.({ status: 'error', error: String(err), lastChange: Date.now() })
      this.ctx.logger.error('[im-channel-dingtalk] connect failed', err)
      throw err
    }
  }

  async stop(): Promise<void> {
    await this.conn?.stop()
    this.conn = null
    this.active = false
  }

  // ── inbound → normalized message ──

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

  private async handleRaw(rawData: string, headers: Record<string, string>): Promise<void> {
    let data: DingtalkMessageData
    try {
      data = JSON.parse(rawData)
    } catch {
      return // ignore non-JSON frames
    }
    const msgtype = data.msgtype
    const supported =
      msgtype === 'text' ||
      msgtype === 'picture' ||
      msgtype === 'richText' ||
      msgtype === 'audio' ||
      msgtype === 'file'
    if (!supported) return
    if (data.conversationType !== '1' && data.conversationType !== '2') return

    // ── Dedup guard: double-check even though dingtalk-connection already dedups ──
    const msgId = data.msgId ?? headers.messageId
    if (msgId) {
      const msgKey = `${msgtype}:${msgId}`
      const now = Date.now()
      for (const [k, ts] of this.seenMsgIds) {
        if (now - ts > DingtalkAdapter.DEDUP_TTL_MS) this.seenMsgIds.delete(k)
      }
      if (this.seenMsgIds.has(msgKey)) {
        this.ctx.logger.debug(`[im-channel-dingtalk:${this.id}] duplicate message ${msgKey} — skipped`)
        return
      }
      this.seenMsgIds.set(msgKey, now)
    }

    const isGroup = data.conversationType === '2'
    const peer = isGroup ? data.conversationId ?? '' : data.senderStaffId ?? data.senderId ?? ''
    const userId = data.senderStaffId ?? data.senderId ?? ''
    if (!peer) return

    // Group messages must @ the bot; ignore otherwise (avoids noise).
    if (isGroup && !data.isInAtList) return

    this.peerInfo.set(peer, {
      isGroup,
      userId,
      encryptedId: data.senderId,
      webhook: data.sessionWebhook,
      senderNick: data.senderNick,
    })

    const content = resolveDingtalkContent(data)
    const downloadCodes: string[] = []
    let text = ''

    if (msgtype === 'text') {
      text = data.text?.content ?? ''
      const quoted = extractQuotedText(data.text)
      if (quoted) text = `[引用] ${quoted}\n\n${text}`
      downloadCodes.push(...extractQuotedMedia(data.text))
    } else if (msgtype === 'picture') {
      text = '[图片]'
      const code = content?.downloadCode ?? data.picture?.downloadCode ?? ''
      if (code) downloadCodes.push(code)
    } else if (msgtype === 'richText') {
      const richList: any[] = content?.richText ?? (data as any)?.richText?.richTextList ?? []
      const parts: string[] = []
      for (const item of richList) {
        if (typeof item?.text === 'string') parts.push(item.text)
        if (item?.downloadCode) downloadCodes.push(item.downloadCode)
      }
      const quoted = extractQuotedText(content)
      if (quoted) parts.unshift(`[引用] ${quoted}`)
      downloadCodes.push(...extractQuotedMedia(content))
      text = parts.join('\n')
      if (!text) text = downloadCodes.length ? '[图片]' : '[富文本消息]'
    } else if (msgtype === 'audio') {
      text = content?.recognition || '[语音消息]'
    } else if (msgtype === 'file') {
      const fileName = content?.fileName || '文件'
      const code = content?.downloadCode ?? ''
      text = code ? `[文件: ${fileName}]` : `[文件: ${fileName}]`
    }
    if (!text && downloadCodes.length === 0) return

    // DingTalk prepends an `@bot` mention to group messages (e.g. "@机器人 /model").
    // The gateway's slash detection matches `text.startsWith('/')`, so strip a
    // leading `@name` (+ optional whitespace) here — otherwise every slash
    // command in a group chat silently falls through to the LLM. Sender
    // attribution for group chats is preserved separately via `senderNick`.
    text = stripLeadingMention(text)

    // Multimodal seam: `downloadCodes` identifies picture/richText attachments.
    // The gateway can now register `ImImage[]` as real ImageBlocks (see
    // `ImGatewayService.buildImageBlocks`); DingTalk still has to download these
    // via the robot media API and fill `images` — until then the text note above
    // ("[图片]") is what the agent sees.
    const message: ImInboundMessage = {
      channelId: this.id,
      conversationId: peer,
      userId,
      text,
      senderNick: data.senderNick,
      isGroup,
      messageId: String(data.msgId ?? headers.messageId ?? ''),
    }
    void this.deliver(message).catch((err) =>
      this.ctx.logger.error('[im-channel-dingtalk] handleInbound failed', err),
    )
  }

  // ── outbound ──

  async sendText(conversationId: string, text: string): Promise<void> {
    const info = this.peerInfo.get(conversationId) ?? { isGroup: true, userId: '' }
    if (!info.webhook) {
      this.ctx.logger.warn(
        `[im-channel-dingtalk] no sessionWebhook for peer ${conversationId}; cannot reply (single-chat fallback not implemented in PoC)`,
      )
      return
    }
    const body: Record<string, any> = {
      msgtype: 'markdown',
      // Card title = the bot's display name (instance name), not a DingTalk agentId.
      markdown: { title: this.label || 'AI 助手', text: info.senderNick ? `@${info.senderNick} ${text}` : text },
    }
    if (info.isGroup) {
      body.at = {}
      if (info.userId) body.at.atUserIds = [info.userId]
      if (info.encryptedId) body.at.atDingtalkIds = [info.encryptedId]
    }
    try {
      const res = await fetch(info.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        this.ctx.logger.warn(`[im-channel-dingtalk] webhook reply failed: HTTP ${res.status}`)
      }
    } catch (err) {
      this.ctx.logger.error('[im-channel-dingtalk] webhook reply error', err)
    }
  }

  async sendImage(conversationId: string, image: ImImage): Promise<void> {
    const info = this.peerInfo.get(conversationId)
    if (!info?.webhook) {
      this.ctx.logger.warn(`[im-channel-dingtalk] no sessionWebhook for peer ${conversationId}; skipping image`)
      return
    }
    try {
      const token = await this.getToken()
      const buf = Buffer.from(image.data, 'base64')
      const form = new FormData()
      form.append('media', new Blob([buf], { type: image.mediaType }), 'image')
      const up = await fetch(
        `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=image`,
        { method: 'POST', body: form },
      )
      const upJson = (await up.json()) as any
      if (upJson.errcode) {
        this.ctx.logger.warn(`[im-channel-dingtalk] media upload failed: ${upJson.errcode} ${upJson.errmsg}`)
        return
      }
      await fetch(info.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'image', image: { media_id: upJson.media_id } }),
      })
    } catch (err) {
      this.ctx.logger.error('[im-channel-dingtalk] sendImage error', err)
    }
  }

  async sendMedia(conversationId: string, filePath: string, caption?: string): Promise<void> {
    const info = this.peerInfo.get(conversationId)
    if (!info?.webhook) {
      this.ctx.logger.warn(`[im-channel-dingtalk:${this.id}] sendMedia: no sessionWebhook for peer ${conversationId}`)
      return
    }
    if (!info.isGroup) {
      // DingTalk 机器人 webhook 只支持群聊发文件/图片，单聊 webhook 不支持 media msgtype
      this.ctx.logger.warn(`[im-channel-dingtalk:${this.id}] sendMedia: webhook single-chat does not support file/image — skipping ${basename(filePath)}`)
      return
    }
    if (!existsSync(filePath)) {
      this.ctx.logger.warn(`[im-channel-dingtalk:${this.id}] sendMedia: path does not exist: ${filePath}`)
      return
    }
    let size: number
    try {
      size = statSync(filePath).size
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-dingtalk:${this.id}] sendMedia: cannot stat ${filePath}: ${String(err)}`)
      return
    }
    const fileName = basename(filePath)
    const ext = extname(filePath).toLowerCase()
    const isImage = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath)
    const MAX_IMAGE = 10 * 1024 * 1024 // 10MB
    const MAX_FILE = 20 * 1024 * 1024 // 20MB
    const maxSize = isImage ? MAX_IMAGE : MAX_FILE
    if (size > maxSize) {
      this.ctx.logger.warn(
        `[im-channel-dingtalk:${this.id}] sendMedia: file too large (${size} bytes, limit ${maxSize}): ${fileName}`,
      )
      return
    }
    if (caption) {
      await this.sendText(conversationId, caption)
    }
    try {
      const token = await this.getToken()
      const buf = readFileSync(filePath)
      const blobType = isImage ? mimeByExt(ext) : 'application/octet-stream'
      const form = new FormData()
      form.append('media', new Blob([buf], { type: blobType }), fileName)
      const up = await fetch(
        `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${isImage ? 'image' : 'file'}`,
        { method: 'POST', body: form },
      )
      const upJson = (await up.json()) as any
      if (upJson.errcode) {
        this.ctx.logger.warn(
          `[im-channel-dingtalk:${this.id}] sendMedia upload failed: ${upJson.errcode} ${upJson.errmsg}`,
        )
        return
      }
      const webhookBody: Record<string, any> = isImage
        ? { msgtype: 'image', image: { media_id: upJson.media_id } }
        : { msgtype: 'file', file: { media_id: upJson.media_id } }
      await fetch(info.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookBody),
      })
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-dingtalk:${this.id}] sendMedia error: ${String(err)}`)
    }
  }

  // ── AI Card streaming (beginStream / streamText / endStream) ────────────
  // Gateway contract: beginStream → streamText (throttled, many) → endStream.
  // Ported from pi-desk-top dingtalk-adapter; protocol lives in dingtalk-card.ts.

  private cardTarget(conversationId: string): AICardTarget {
    const info = this.peerInfo.get(conversationId)
    const isGroup = info?.isGroup ?? true
    return isGroup ? { type: 'group', targetId: conversationId } : { type: 'user', targetId: conversationId }
  }

  async beginStream(conversationId: string): Promise<void> {
    // A new turn: drop any previous card for this peer (defensive — the
    // gateway normally calls beginStream only once per reply cycle).
    if (this.cards.has(conversationId)) {
      this.cards.delete(conversationId)
    }
    const card = await createDingtalkCard(this.config, this.cardTarget(conversationId))
    this.cards.set(conversationId, card ?? null)
    if (!card) {
      // Card creation failed — fall back to a "thinking…" text so the user
      // gets some feedback; streamText will be a no-op until endStream.
      this.ctx.logger.warn(`[im-channel-dingtalk:${this.id}] beginStream: card create FAILED for ${conversationId}; falling back to text`)
      await this.sendText(conversationId, '⏳ 正在思考…').catch(() => {})
    } else {
      this.ctx.logger.info(`[im-channel-dingtalk:${this.id}] beginStream: card ${card.cardInstanceId} created for ${conversationId}`)
    }
  }

  async streamText(conversationId: string, text: string, finished = false): Promise<void> {
    const card = this.cards.get(conversationId)
    if (!card) return // no active card — ignore (plain text fallback at end)
    try {
      await streamDingtalkCard(card, text, finished, this.config)
    } catch (err) {
      // Streaming failed (network / QPS) — drop the card so endStream won't
      // try to finalize a broken instance.
      this.ctx.logger.warn(
        `[im-channel-dingtalk:${this.id}] streamText failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      this.cards.delete(conversationId)
    }
  }

  async endStream(conversationId: string, text: string): Promise<void> {
    const card = this.cards.get(conversationId)
    this.cards.delete(conversationId)
    if (!card) {
      // No card was created (or it failed) — fall back to plain text so the
      // reply is never lost (sendText @s the asker in groups via webhook).
      this.ctx.logger.warn(`[im-channel-dingtalk:${this.id}] endStream: no card for ${conversationId}; plain-text fallback`)
      await this.sendText(conversationId, text)
      return
    }
    const info = this.peerInfo.get(conversationId)
    const isGroup = info?.isGroup ?? true
    // Group chats: prefix a plain "@昵称 " so the user knows this reply
    // answers THEIR message (DingTalk can't render a real @ inside the card
    // for enterprise robots, but the text mention routes it clearly).
    const final = isGroup && info?.senderNick ? `@${info.senderNick} ${text}` : text
    try {
      // Single card holds the final answer. Long texts skip the streaming
      // finalize frame (the ~1K per-frame advice) and go straight to the
      // FINISHED PUT with the full content.
      const long = final.length > CARD_STREAM_FRAME_LIMIT
      await finishDingtalkCard(card, final, this.config, long)
      this.ctx.logger.info(
        `[im-channel-dingtalk:${this.id}] endStream: card ${card.cardInstanceId} FINISHED for ${conversationId} (${final.length} chars)`,
      )
    } catch (err) {
      // Finalize failed — send the full reply as a markdown message.
      this.ctx.logger.warn(
        `[im-channel-dingtalk:${this.id}] endStream finalize failed: ${err instanceof Error ? err.message : String(err)}; fallback to text`,
      )
      await this.sendText(conversationId, text).catch(() => {})
    }
  }

  // ── DingTalk access token + media (for inbound image download / outbound) ──

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(
      this.config.clientId,
    )}&appsecret=${encodeURIComponent(this.config.clientSecret)}`
    const res = await fetch(url)
    const json = (await res.json()) as any
    if (json.errcode) throw new Error(`dingtalk gettoken: ${json.errcode} ${json.errmsg}`)
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000,
    }
    return this.token.value
  }

}

/** DingTalk card streaming API caps a single content frame at ~1K. */
const CARD_STREAM_FRAME_LIMIT = 1000

/** Minimal ext → MIME for image upload Blob type. */
function mimeByExt(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    case '.webp': return 'image/webp'
    default: return 'application/octet-stream'
  }
}

/** Export the adapter class for the single-entry bundle to instantiate. */
export { DingtalkAdapter }

