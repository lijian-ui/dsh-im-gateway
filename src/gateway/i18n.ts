/**
 * 国际化模块：提供中英文翻译。
 *
 * 用法：
 *   const t = createTranslator('en')
 *   t('cmd.reset.success')           // → "Session reset."
 *   t('evt.tool.calling', 'grep')    // → "🔧 Calling tool: grep …"
 *
 * 翻译表用扁平 key（点分命名空间），参数用 {0} {1} … 占位。
 *
 * @module im-gateway/i18n
 */

export type Lang = 'zh' | 'en'

type Dict = Record<string, string>

const zh: Dict = {
  // ── commands.ts ──────────────────────────────────────────────
  'cmd.help.title': '**可用指令**',
  'cmd.help.help': '- `/help` — 显示本帮助',
  'cmd.help.reset': '- `/reset` · `/clear` · `/new` — 重置当前会话（开启新一轮）',
  'cmd.help.model': '- `/model` — 列出可用模型；`/model <编号|模型名|provider/model>` 切换',
  'cmd.help.status': '- `/status` — 查看当前渠道、工作目录与模型',
  'cmd.help.stop': '- `/stop` — 中止当前正在生成的回答',
  'cmd.help.sessions': '- `/sessions` — 列出最近的 DSH 会话',
  'cmd.help.continue': '- `/continue <会话id>` — 继续指定会话（用 /sessions 查看可用 id）',
  'cmd.reset.success': '✅ 会话已重置，下一句将开启新一轮。',
  'cmd.model.none': '⚠️ 暂无可用的模型（未配置 provider）。',
  'cmd.model.labelAlias': '{0}（{1}）',
  'cmd.model.currentMark': ' ← 当前',
  'cmd.model.listTitle': '**可用模型**（输入 `/model <emoji|模型名|provider/model>` 切换——emoji 即列表左侧的 1️⃣2️⃣ 等；无会话时切换将设为默认模型，下次建立会话生效）',
  'cmd.model.notFound': '⚠️ 未找到模型「{0}」。输入 /model 查看可用列表。',
  'cmd.model.setGlobal': '✅ 已设置默认模型：`{0}` [`{1}`]（下次建立会话时生效，下一次发送消息后立即应用）',
  'cmd.model.switched': '✅ 已切换模型：`{0}` [`{1}`]（下一句生效）',
  'cmd.status.title': '**当前状态**',
  'cmd.status.channel': '- 📡 渠道：`{0}`',
  'cmd.status.cwd': '- 📁 工作目录：`{0}`',
  'cmd.status.model': '- 🤖 当前模型：`{0} / {1}`',
  'cmd.status.modelUnknown': '- 🤖 当前模型：未知',
  'cmd.status.sessionYes': '- 💬 会话：已建立',
  'cmd.status.sessionNo': '- 💬 会话：未建立',
  'cmd.status.globalModel': '- 🌐 全局默认模型（预选）：`{0} / {1}`',
  'cmd.status.agentStatus': '- ⚙️ 运行状态：`{0}`',
  'cmd.stop.noSession': '⚠️ 当前没有进行中的会话。',
  'cmd.stop.done': '🛑 已中止当前轮次。',
  'cmd.stop.failed': '⚠️ 中止失败，请稍后重试。',
  'cmd.sessions.unavailable': '⚠️ 会话查询服务不可用。',
  'cmd.sessions.empty': '暂无会话记录。',
  'cmd.sessions.title': '**最近会话**（输入 `/continue <会话id>` 继续）',
  'cmd.sessions.noTitle': '（无标题）',
  'cmd.sessions.currentMark': ' ← 当前',
  'cmd.sessions.item': '- {0}`{1}` {2}{3}',
  'cmd.sessions.total': '…共 {0} 个会话',
  'cmd.sessions.failed': '⚠️ 列表查询失败，请稍后重试。',
  'cmd.continue.usage': '用法：`/continue <会话id>`（用 `/sessions` 查看可用 id）',
  'cmd.continue.success': '✅ 已继续会话 `{0}`，直接发消息即可继续对话。',
  'cmd.continue.failed': '❌ 继续会话失败：{0}',
  'cmd.help.workspaces': '- `/workspaces` — 列出所有工作区',
  'cmd.help.workspace': '- `/workspace <路径>` — 切换工作区（后续 /new 生效）',
  'cmd.workspaces.unavailable': '⚠️ 会话查询服务不可用。',
  'cmd.workspaces.empty': '暂无工作区记录。',
  'cmd.workspaces.title': '📁 工作区（{0} 个）：',
  'cmd.workspaces.item': '• {0}（{1} 会话）',
  'cmd.workspaces.total': '…共 {0} 个工作区',
  'cmd.workspaces.hint': '用 `/workspace <路径>` 切换；`/sessions` 查看会话。',
  'cmd.workspaces.failed': '⚠️ 列表查询失败，请稍后重试。',
  'cmd.workspaces.unknown': '（未知工作区）',
  'cmd.workspace.current': '当前工作区：`{0}`\n用法：`/workspace <路径>` 切换（后续 /new 生效）',
  'cmd.workspace.notDir': '⚠️ 不是目录：`{0}`',
  'cmd.workspace.notFound': '⚠️ 目录不存在：`{0}`',
  'cmd.workspace.switched': '✅ 工作区已切换：`{0}`\n发送 `/new` 在此工作区开启新会话。',

  // ── events.ts ────────────────────────────────────────────────
  'evt.turn.noOutput': '✅ 已完成（无文本输出）',
  'evt.turn.errorUnknown': '未知错误',
  'evt.turn.failed': '⚠️ 处理失败：{0}',

  // ── im-gateway.ts ────────────────────────────────────────────
  'gw.cmd.failed': '⚠️ 命令执行失败：{0}',
  'gw.auth.approve': '批准',
  'gw.auth.agree': '同意',
  'gw.auth.reject': '拒绝',
  'gw.auth.denied': '⛔ 未授权：请在 dsh 设置 → IM 网关中批准你的访问请求。',
  'gw.session.notReady': '⚠️ 会话未就绪，请稍后重试。',
  'gw.followup.failed': '⚠️ 处理失败，请稍后重试。',
  'gw.session.archivedRotated': 'ℹ️ 这个会话此前已在桌面端被「归档」，内核会直接拦截它的每一轮（所以只看到"思考"、没有回复）。已为你开启新会话，刚才那条消息已在新会话里继续；旧历史不会延续。',
  'gw.sendFile.desc1': '把工作区文件发送给当前 IM 会话的用户（微信/QQ/钉钉等渠道）。',
  'gw.sendFile.desc2': '支持图片、视频和任意文档；caption 为可选附言。',
  'gw.sendFile.pathDesc': '要发送的文件路径（相对或绝对）',
  'gw.sendFile.captionDesc': '附言文本（可选，先于文件发送）',
  'gw.sendFile.noSession': '无法确定当前会话（仅 IM 发起的会话可用此工具）',
  'gw.sendFile.noChat': '当前会话没有关联的 IM 聊天',
  'gw.sendFile.noChannel': '关联渠道不可用',
  'gw.sendFile.sent': '已发送 {0}',
  'gw.sendFile.fallbackText': '[文件] {0}（该渠道不支持直接发送文件）',
  'gw.sendFile.fallbackDetail': '已通知 {0}（渠道不支持 sendMedia，降级为文本）',
  'gw.sendFile.failed': '发送失败：{0}',
  'gw.sendVoice.desc': '把文本用 TTS 合成语音发送给当前 IM 会话的用户（需在 QQ 渠道配置中启用 TTS）。',
  'gw.sendVoice.textDesc': '要合成语音的文本内容',
  'gw.sendVoice.captionDesc': '附言文本（可选，先于语音发送）',
  'gw.sendVoice.noSession': '无法确定当前会话（仅 IM 发起的会话可用此工具）',
  'gw.sendVoice.noChat': '当前会话没有关联的 IM 聊天',
  'gw.sendVoice.noChannel': '关联渠道不可用',
  'gw.sendVoice.unsupported': '该渠道未启用语音输出，已改为发送文本',
  'gw.sendVoice.ttsFailed': 'TTS 合成失败，已改为发送文本',
  'gw.sendVoice.sent': '语音已发送',
  'gw.sendVoice.failed': '语音发送失败：{0}',
  'gw.approval.title': '⚠️ 批准请求（{0}s 内回复「批准」或「拒绝」）',
  'gw.approval.tool': '工具：{0}',
  'gw.approval.reason': '原因：{0}',
  'gw.approval.hint': '回复「批准」或「拒绝」，超时转回本机批准体系。',
  'gw.approval.approved': '已批准 ✅',
  'gw.approval.rejected': '已拒绝 ❌',
  'gw.question.answeredWeb': '✅ 已在网页端回答：{0}',
  'gw.question.answeredIM': '✅ 已选择：{0}\n回答端：{1}',
  'gw.question.timeout': '⌛ IM 回答窗口已结束，请在网页端继续选择。',
  'gw.question.invalid': '⚠️ 无法识别这个选择：{0}',

  // ── questions.ts ─────────────────────────────────────────────
  'q.remember.im': '该提问已由 {0} 回答：{1}',
  'q.remember.web': '该提问已在网页端回答：{0}',
  'q.prompt.title': '❓ 需要你的选择（{0}s 内可在网页或任一绑定渠道回答，第一答生效）',
  'q.prompt.questionNum': '问题 {0}',
  'q.prompt.multiHint': '（可多选，用逗号分隔，如 1,3）',
  'q.prompt.freeHint': '（直接回复你的答案）',
  'q.prompt.singleReply': '回复选项编号/文字；也可以直接回复自定义答案。',
  'q.prompt.multiReply': '请每行回答一个问题，格式为「问题序号: 答案」，例如：',
  'q.summary.empty': '（空）',
  'q.parse.empty': '答案不能为空。',
  'q.parse.countMismatch': '请回答全部 {0} 个问题，每行使用「问题序号: 答案」，例如「1: 2」。',
  'q.parse.questionError': '问题 {0}：{1}',

  // ── split.ts ────────────────────────────────────────────────
  'split.prefix': '（{0}/{1}）',

  // ── instance-lock.ts ────────────────────────────────────────
  'lock.conflict1': 'im-gateway 检测到另一个进程（PID {0}）正在使用 DSH_HOME "{1}"。',
  'lock.conflict2': '多个实例共享会话目录会并发写坏 session log。',
  'lock.failed': '无法获取实例锁：{0}',
}

const en: Dict = {
  // ── commands.ts ──────────────────────────────────────────────
  'cmd.help.title': '**Available commands**',
  'cmd.help.help': '- `/help` — Show this help',
  'cmd.help.reset': '- `/reset` · `/clear` · `/new` — Reset current session (start a new round)',
  'cmd.help.model': '- `/model` — List available models; `/model <number|model|provider/model>` to switch',
  'cmd.help.status': '- `/status` — Show current channel, working directory and model',
  'cmd.help.stop': '- `/stop` — Abort the current generation',
  'cmd.help.sessions': '- `/sessions` — List recent DSH sessions',
  'cmd.help.continue': '- `/continue <session-id>` — Continue a specific session (use /sessions for IDs)',
  'cmd.reset.success': '✅ Session reset. Next message starts a new round.',
  'cmd.model.none': '⚠️ No models available (provider not configured).',
  'cmd.model.labelAlias': '{0} ({1})',
  'cmd.model.currentMark': ' ← current',
  'cmd.model.listTitle': '**Available models** (type `/model <emoji|model|provider/model>` to switch — emoji is the 1️⃣2️⃣ on the left; switching without a session sets the default model)',
  'cmd.model.notFound': '⚠️ Model "{0}" not found. Type /model to see available models.',
  'cmd.model.setGlobal': '✅ Default model set: `{0}` [`{1}`] (applies to new sessions on next message)',
  'cmd.model.switched': '✅ Model switched: `{0}` [`{1}`] (effective next message)',
  'cmd.status.title': '**Current status**',
  'cmd.status.channel': '- 📡 Channel: `{0}`',
  'cmd.status.cwd': '- 📁 Working directory: `{0}`',
  'cmd.status.model': '- 🤖 Model: `{0} / {1}`',
  'cmd.status.modelUnknown': '- 🤖 Model: unknown',
  'cmd.status.sessionYes': '- 💬 Session: established',
  'cmd.status.sessionNo': '- 💬 Session: not established',
  'cmd.status.globalModel': '- 🌐 Global default model (preset): `{0} / {1}`',
  'cmd.status.agentStatus': '- ⚙️ Agent status: `{0}`',
  'cmd.stop.noSession': '⚠️ No active session.',
  'cmd.stop.done': '🛑 Current turn aborted.',
  'cmd.stop.failed': '⚠️ Abort failed, please retry later.',
  'cmd.sessions.unavailable': '⚠️ Session query service unavailable.',
  'cmd.sessions.empty': 'No session records.',
  'cmd.sessions.title': '**Recent sessions** (type `/continue <session-id>` to continue)',
  'cmd.sessions.noTitle': '(no title)',
  'cmd.sessions.currentMark': ' ← current',
  'cmd.sessions.item': '- {0}`{1}` {2}{3}',
  'cmd.sessions.total': '…{0} sessions total',
  'cmd.sessions.failed': '⚠️ List query failed, please retry later.',
  'cmd.continue.usage': 'Usage: `/continue <session-id>` (use `/sessions` for IDs)',
  'cmd.continue.success': '✅ Continued session `{0}`, just send a message to resume.',
  'cmd.continue.failed': '❌ Failed to continue session: {0}',
  'cmd.help.workspaces': '- `/workspaces` — List all workspaces',
  'cmd.help.workspace': '- `/workspace <path>` — Switch workspace (effective on next /new)',
  'cmd.workspaces.unavailable': '⚠️ Session query service unavailable.',
  'cmd.workspaces.empty': 'No workspace records.',
  'cmd.workspaces.title': '📁 Workspaces ({0}):',
  'cmd.workspaces.item': '• {0} ({1} sessions)',
  'cmd.workspaces.total': '…{0} workspaces total',
  'cmd.workspaces.hint': 'Use `/workspace <path>` to switch; `/sessions` to view sessions.',
  'cmd.workspaces.failed': '⚠️ List query failed, please retry later.',
  'cmd.workspaces.unknown': '(unknown workspace)',
  'cmd.workspace.current': 'Current workspace: `{0}`\nUsage: `/workspace <path>` to switch (effective on next /new)',
  'cmd.workspace.notDir': '⚠️ Not a directory: `{0}`',
  'cmd.workspace.notFound': '⚠️ Directory not found: `{0}`',
  'cmd.workspace.switched': '✅ Workspace switched: `{0}`\nSend `/new` to start a new session in this workspace.',

  // ── events.ts ────────────────────────────────────────────────
  'evt.turn.noOutput': '✅ Done (no text output)',
  'evt.turn.errorUnknown': 'unknown error',
  'evt.turn.failed': '⚠️ Processing failed: {0}',

  // ── im-gateway.ts ────────────────────────────────────────────
  'gw.cmd.failed': '⚠️ Command failed: {0}',
  'gw.auth.approve': 'approve',
  'gw.auth.agree': 'agree',
  'gw.auth.reject': 'reject',
  'gw.auth.denied': '⛔ Unauthorized: please approve your access in dsh settings → IM Gateway.',
  'gw.session.notReady': '⚠️ Session not ready, please retry later.',
  'gw.followup.failed': '⚠️ Processing failed, please retry later.',
  'gw.session.archivedRotated': 'ℹ️ This conversation had been archived in the desktop app, and the kernel blocks every turn of an archived session before the model ever runs. I started a new session for you; the message you just sent continues there, but the old history does not carry over.',
  'gw.sendFile.desc1': 'Send a workspace file to the current IM session user (WeChat/QQ/DingTalk etc.).',
  'gw.sendFile.desc2': 'Supports images, videos and any document; caption is optional.',
  'gw.sendFile.pathDesc': 'File path to send (relative or absolute)',
  'gw.sendFile.captionDesc': 'Caption text (optional, sent before the file)',
  'gw.sendFile.noSession': 'Cannot determine current session (only IM-initiated sessions can use this tool)',
  'gw.sendFile.noChat': 'Current session has no associated IM chat',
  'gw.sendFile.noChannel': 'Associated channel unavailable',
  'gw.sendFile.sent': 'Sent {0}',
  'gw.sendFile.fallbackText': '[File] {0} (this channel does not support direct file sending)',
  'gw.sendFile.fallbackDetail': 'Notified {0} (channel does not support sendMedia, fell back to text)',
  'gw.sendFile.failed': 'Send failed: {0}',
  'gw.sendVoice.desc': 'Synthesize `text` into speech (TTS) and send it to the current IM session user (TTS must be enabled in the QQ channel config).',
  'gw.sendVoice.textDesc': 'Text to synthesize into speech',
  'gw.sendVoice.captionDesc': 'Caption text (optional, sent before the voice)',
  'gw.sendVoice.noSession': 'Cannot determine current session (only IM-initiated sessions can use this tool)',
  'gw.sendVoice.noChat': 'Current session has no associated IM chat',
  'gw.sendVoice.noChannel': 'Associated channel unavailable',
  'gw.sendVoice.unsupported': 'Voice output is not enabled for this channel; sent as text instead',
  'gw.sendVoice.ttsFailed': 'TTS synthesis failed; sent as text instead',
  'gw.sendVoice.sent': 'Voice message sent',
  'gw.sendVoice.failed': 'Voice send failed: {0}',
  'gw.approval.title': '⚠️ Approval request (reply "approve" or "reject" within {0}s)',
  'gw.approval.tool': 'Tool: {0}',
  'gw.approval.reason': 'Reason: {0}',
  'gw.approval.hint': 'Reply "approve" or "reject"; timeout falls back to local approval.',
  'gw.approval.approved': 'Approved ✅',
  'gw.approval.rejected': 'Rejected ❌',
  'gw.question.answeredWeb': '✅ Answered on web: {0}',
  'gw.question.answeredIM': '✅ Selected: {0}\nAnswered by: {1}',
  'gw.question.timeout': '⌛ IM answer window closed, please continue on the web.',
  'gw.question.invalid': '⚠️ Cannot recognize this choice: {0}',

  // ── questions.ts ─────────────────────────────────────────────
  'q.remember.im': 'Question answered by {0}: {1}',
  'q.remember.web': 'Question answered on web: {0}',
  'q.prompt.title': '❓ Your input needed (answer on web or any bound channel within {0}s, first answer wins)',
  'q.prompt.questionNum': 'Question {0}',
  'q.prompt.multiHint': '(multi-select, comma-separated, e.g. 1,3)',
  'q.prompt.freeHint': '(reply with your answer)',
  'q.prompt.singleReply': 'Reply with option number/text; or reply with a custom answer.',
  'q.prompt.multiReply': 'Answer one question per line, format "question-number: answer", e.g.:',
  'q.summary.empty': '(empty)',
  'q.parse.empty': 'Answer cannot be empty.',
  'q.parse.countMismatch': 'Please answer all {0} questions, one per line using "question-number: answer", e.g. "1: 2".',
  'q.parse.questionError': 'Question {0}: {1}',

  // ── split.ts ────────────────────────────────────────────────
  'split.prefix': '({0}/{1})',

  // ── instance-lock.ts ────────────────────────────────────────
  'lock.conflict1': 'im-gateway detected another process (PID {0}) using DSH_HOME "{1}".',
  'lock.conflict2': 'Multiple instances sharing the session directory will corrupt the session log.',
  'lock.failed': 'Failed to acquire instance lock: {0}',
}

const dicts: Record<Lang, Dict> = { zh, en }

export class Translator {
  constructor(readonly lang: Lang) {}

  t(key: string, ...args: (string | number)[]): string {
    const dict = dicts[this.lang] ?? zh
    let s = dict[key] ?? zh[key] ?? key
    for (let i = 0; i < args.length; i++) {
      s = s.replaceAll(`{${i}}`, String(args[i]))
    }
    return s
  }
}

export function createTranslator(lang: Lang): Translator {
  return new Translator(lang)
}

/** 中文断点字符集（句号、问号、叹号、省略号、分号）。 */
export const breakChars: Record<Lang, string> = {
  zh: '。！？…；',
  en: '.!?…;',
}