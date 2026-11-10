/**
 * Weixin CDN media helpers — ported from
 * pi-desk-top/src/main/im/weixin/weixin-media.ts (itself ported from the
 * official connector). AES-128-ECB encrypt/decrypt + presigned CDN upload.
 */
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** Default CDN base URL (falls back when the login response omits it). */
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

// ── AES-128-ECB ──

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

// ── MIME ──

const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

export function getMimeFromFilename(filename: string): string {
  return EXT_TO_MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

// ── CDN URL ──

export function buildCdnDownloadUrl(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string
  uploadParam: string
  filekey: string
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`
}

// ── Key parsing ──

/**
 * Parse a base64 aes_key into the raw 16-byte AES key. Two encodings exist:
 * base64(raw 16 bytes) for images; base64(hex string of 16 bytes) for
 * file/voice/video.
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(
    `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  )
}

// ── Inbound: download + decrypt ──

async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${label}: CDN download ${res.status} ${res.statusText}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * CDN download bounded by a wall-clock timeout and a hard ciphertext byte cap.
 * Used by inbound media so one slow or oversized object cannot stall the poll
 * loop; the caller falls back to a text note on failure.
 */
async function fetchCdnBytesBounded(
  url: string,
  label: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    throw new Error(`${label}: CDN download ${res.status} ${res.statusText}`)
  }
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `${label}: CDN object declares ${declared} bytes, over the ${maxBytes} limit`,
    )
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) {
    throw new Error(
      `${label}: CDN object is ${buf.length} bytes, over the ${maxBytes} limit`,
    )
  }
  return buf
}

/** `downloadAndDecryptBuffer` with the inbound timeout + size caps applied. */
export async function downloadAndDecryptBufferBounded(params: {
  encryptedQueryParam: string
  aesKeyBase64: string
  cdnBaseUrl: string
  label: string
  fullUrl?: string
  timeoutMs: number
  maxBytes: number
}): Promise<Buffer> {
  const { encryptedQueryParam, aesKeyBase64, cdnBaseUrl, label, fullUrl, timeoutMs, maxBytes } = params
  const key = parseAesKey(aesKeyBase64, label)
  const url =
    fullUrl ?? buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
  return decryptAesEcb(await fetchCdnBytesBounded(url, label, timeoutMs, maxBytes), key)
}

/** Download + AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer. */
export async function downloadAndDecryptBuffer(params: {
  encryptedQueryParam: string
  aesKeyBase64: string
  cdnBaseUrl: string
  label: string
  fullUrl?: string
}): Promise<Buffer> {
  const { encryptedQueryParam, aesKeyBase64, cdnBaseUrl, label, fullUrl } = params
  const key = parseAesKey(aesKeyBase64, label)
  const url =
    fullUrl ?? buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
  const encrypted = await fetchCdnBytes(url, label)
  return decryptAesEcb(encrypted, key)
}

// ── Outbound: encrypt + upload ──

const UPLOAD_MAX_RETRIES = 3

/** Upload a ciphertext buffer to the CDN; returns the download param. */
export async function uploadBufferToCdn(params: {
  buf: Buffer
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
  cdnBaseUrl: string
  label: string
  aeskey: Buffer
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params
  const ciphertext = encryptAesEcb(buf, aeskey)
  const cdnUrl =
    uploadFullUrl?.trim() ||
    (uploadParam
      ? buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey })
      : undefined)
  if (!cdnUrl) {
    throw new Error(`${label}: CDN upload URL missing`)
  }

  let downloadParam: string | undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text())
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`)
      }
      if (res.status !== 200) {
        throw new Error(
          `CDN upload server error: ${res.headers.get('x-error-message') ?? `status ${res.status}`}`,
        )
      }
      downloadParam = res.headers.get('x-encrypted-param') ?? undefined
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header')
      }
      break
    } catch (err) {
      lastError = err
      if (err instanceof Error && err.message.includes('client error')) throw err
      if (attempt < UPLOAD_MAX_RETRIES) continue
    }
  }
  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`)
  }
  return { downloadParam }
}

export type UploadedFileInfo = {
  filekey: string
  /** Fill into media.encrypt_query_param. */
  downloadEncryptedQueryParam: string
  /** AES key, hex-encoded (convert to base64 for media.aes_key). */
  aeskey: string
  /** Plaintext size in bytes. */
  fileSize: number
  /** Ciphertext size in bytes (AES-128-ECB + PKCS7). */
  fileSizeCiphertext: number
}

export type UploadMediaTypeValue = 1 | 2 | 3 | 4 // IMAGE | VIDEO | FILE | VOICE

/**
 * Upload a local file to the Weixin CDN with AES-128-ECB encryption.
 * Shared by image / video / file attachment paths.
 */
export async function uploadLocalFileToWeixin(params: {
  filePath: string
  toUserId: string
  mediaType: UploadMediaTypeValue
  baseUrl: string
  token: string
  cdnBaseUrl?: string
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, mediaType, baseUrl, token, cdnBaseUrl } = params
  const plaintext = await readFile(filePath)
  const rawsize = plaintext.length
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = crypto.randomBytes(16).toString('hex')
  const aeskey = crypto.randomBytes(16)

  const rawText = await postJson(baseUrl, 'ilink/bot/getuploadurl', token, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
    base_info: { channel_version: '2.4.3', bot_agent: 'dsh-desktop' },
  })
  const resp = JSON.parse(rawText) as {
    upload_full_url?: string
    upload_param?: string
  }
  if (!resp.upload_full_url?.trim() && !resp.upload_param) {
    throw new Error('getuploadurl returned no upload URL')
  }

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: resp.upload_full_url,
    uploadParam: resp.upload_param,
    filekey,
    cdnBaseUrl: cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
    aeskey,
    label: 'uploadLocalFileToWeixin',
  })

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  }
}

/** Shared POST helper with the iLink headers (kept local to media module). */
async function postJson(
  baseUrl: string,
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(
        String(Math.floor(Math.random() * 4_000_000_000)),
        'utf-8',
      ).toString('base64'),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132099',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`${endpoint} ${res.status}: ${raw.slice(0, 300)}`)
  }
  return raw
}
