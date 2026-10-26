/**
 * outbound — 出站帧与出站载荷的**构造器**。
 *
 * 为什么要有这个文件（复核 R7、§5.2）：旧实现（以及我第一版新代码）都是在各处
 * 手搓 `{ t:'paired', sessionId, hostId }` 这样的字面量。这有两个后果：
 *
 * 1. 字段名散落在十几个调用点里，改一个就得改全部，而小程序只会**静默地**显示不出来；
 * 2. "禁止出现的字段"这种约束根本没有防线——比如 `ev.keep_awake_state` 与
 *    `ev.session_changed` 按契约**不带** `sessionId`（F11），但拼装模式下
 *    谁都可能顺手加一个，而 zod 默认会把未知键**剥掉**而不是报错，
 *    于是连测试都看不出差别。
 *
 * 这里把每条出站帧/载荷收成一个函数：参数表就是允许出现的字段集合，
 * 没有的参数**类型上不存在**。`outbound.test.mjs` 再对产物断言键集，
 * 这样 F4（必发帧的必填项）、F11（禁止字段）、F3（sessionId 逐字不变）
 * 才从"文档要求"变成"跑一下就红"。
 */
import {
  MAX_CIPHERTEXT_BYTES,
  PROTOCOL_VERSION,
  type EndpointFrame,
  type ErrorCode,
  type FeedbackItem,
  type RelayFrame,
  type StatusDigest,
} from './frames.js'
import { RELAY_CAPABILITIES } from './registry.js'
import {
  type ChoiceOption,
  type EvKeepAwakeState,
  type EvMessageDelta,
  type EvModel,
  type EvPermissionRequest,
  type EvPermissionResolved,
  type EvQuestionRequest,
  type EvQuestionResolved,
  type EvResult,
  type EvRunState,
  type EvSessionChanged,
  type EvTodo,
  type TodoItem,
  type EvRetry,
  type EvCompaction,
  type EvHostInfo,
  type EvSessionHistory,
  type EvToolEvent,
  type HistoryItem,
  type ModelOption,
  type QuestionItem,
  type SessionSummary,
  PAYLOAD_TYPES,
} from './payloads.js'

// ── 中继 → 端点 的控制面 ─────────────────────────────────────────────

export interface RelayOutbound {
  t: string
  [key: string]: unknown
}

/**
 * hello-ok 的可选下发面（M-C / M2）。
 *
 * `capabilities` 缺省 = `RELAY_CAPABILITIES` 全量（中继声明它实现的面）；
 * `summary` 只在会话条目上真有摘要时带上（M2 的回放面）。
 */
export interface HelloOkExtras {
  capabilities?: readonly string[]
  summary?: StatusDigest
}

export function helloOkForClient(clientId: string, protocol?: number, extras: HelloOkExtras = {}): RelayOutbound {
  return {
    t: 'hello-ok',
    role: 'client',
    clientId,
    // 缺省补 PROTOCOL_VERSION（与 `helloForHost` 同款）：`hello-ok` 的 schema 里
    // `protocol` 是**必填**，省略这个键会造出一张对侧静默丢掉的帧（2026-10-24 审计）。
    ...(protocol === undefined ? { protocol: PROTOCOL_VERSION } : { protocol }),
    capabilities: [...(extras.capabilities ?? RELAY_CAPABILITIES)],
    ...(extras.summary === undefined ? {} : { summary: extras.summary }),
  }
}

export function helloOkForHost(hostId: string, protocol?: number, extras: HelloOkExtras = {}): RelayOutbound {
  return {
    t: 'hello-ok',
    role: 'host',
    hostId,
    // 同上：缺省补 PROTOCOL_VERSION，构造器不许造出 schema 会拒的帧。
    ...(protocol === undefined ? { protocol: PROTOCOL_VERSION } : { protocol }),
    capabilities: [...(extras.capabilities ?? RELAY_CAPABILITIES)],
    ...(extras.summary === undefined ? {} : { summary: extras.summary }),
  }
}

/** 服务端权威 TTL。**ttlMs 必须是正整数**：主机要靠它改写本地过期时间（旧实现的第一起事故）。 */
export function pairReady(pairingToken: string, ttlMs: number): RelayOutbound {
  // 构造器守自己 schema 的那条约束（2026-10-06 审计）：schema 是 `positive()`，
  // 而这里原来只管把值塞进去 —— 造出一张对侧会静默丢掉的帧，比抛错难查得多。
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`pair-ready 的 ttlMs 必须是正整数，收到 ${String(ttlMs)}`)
  }
  return { t: 'pair-ready', pairingToken, ttlMs }
}

export function paired(sessionId: string, hostId: string): RelayOutbound {
  return { t: 'paired', sessionId, hostId }
}

/**
 * 中继 → 主机：有人拿着一张码来认领，并带了一枚一次性公钥（2026-10-21）。
 *
 * 中继只做搬运：它不校验公钥是否"像真的"，也不参与密钥协商。
 */
export function pairRequest(
  pairingToken: string,
  clientPub: string,
  sessionId: string,
  hostId?: string,
): Extract<RelayFrame, { t: 'pair-request' }> {
  return {
    t: 'pair-request',
    pairingToken,
    clientPub,
    sessionId,
    ...(hostId === undefined ? {} : { hostId }),
  }
}

/**
 * 主机 → 中继 → 手机：psk 的密文（2026-10-21）。
 *
 * 带 `sessionId` 而不是 token：中继认领时就把 token 消费掉了，
 * 而主机在 `peer-joined` 里已经拿到会话号（见 frames.ts 里那段注释）。
 */
export function pairGrant(
  sessionId: string,
  hostPub: string,
  nonce: string,
  wrappedPsk: string,
): Extract<EndpointFrame, { t: 'pair-grant' }> {
  if (sessionId === '') throw new Error('pair-grant 的 sessionId 不能为空')
  if (nonce === '' || wrappedPsk === '') throw new Error('pair-grant 的密文与 nonce 不能为空')
  return { t: 'pair-grant', sessionId, hostPub, nonce, wrappedPsk }
}

/**
 * `pair-fail`：**能带 token 就带**（2026-10-07 补）。
 *
 * 不带时主机侧只能作废"当前展示的那张"，而多码并存时那会作废错的那张
 * （详见 `frames.ts` 里 `pairFailFrame.pairingToken` 的注释）。
 * 缺省即不发这个字段：中继点不出名字时接线方按"当前展示的那张"兜底。
 */
export function pairFail(
  reason: 'invalid_or_expired' | 'already_used' | 'host_offline' | 'bad_token',
  pairingToken?: string,
): RelayOutbound {
  return { t: 'pair-fail', reason, ...(pairingToken === undefined ? {} : { pairingToken }) }
}

/** 发给主机的加入通知必须带 pairingToken（主机按它取 PSK）；发给客户端的不带。 */
export function peerJoinedForHost(sessionId: string, clientId: string, pairingToken: string): RelayOutbound {
  return { t: 'peer-joined', sessionId, clientId, pairingToken }
}

/**
 * `peer-left` 只有一个合法触发：**主机离开**。
 * 参数表里刻意没有"告诉某个客户端别人走了"的形态——那种帧会让别的手机无辜丢配对（F5）。
 */
export function peerLeft(sessionId: string, clientId: string, unpaired?: boolean): RelayOutbound {
  // unpaired 缺省就是「没这个字段」而不是 false：**没带 = 断线**，
  // 显式 false 反而会让它以为这是一次被判定过的断线。
  return { t: 'peer-left', sessionId, clientId, ...(unpaired ? { unpaired: true } : {}) }
}

/**
 * 构造一条错误帧。
 *
 * `retryAfterMs` 只给"等一等就好"的码（限流、表满）。规范 §12.2 E1 有一条硬要求：
 * 发给 **client** 的错误必须带中文 `message`——协议层管不了文案（那是部署方与产品的事），
 * 但它可以在这里把"带不带文案"变成一个签名上的选择：`message` 缺省时**不发这个字段**，
 * 于是调用方想省掉文案是一件显眼的事，而不是 `undefined` 悄悄被 JSON 丢掉。
 */
export function makeError(code: ErrorCode, message?: string, retryAfterMs?: number): RelayOutbound {
  if (retryAfterMs !== undefined && (!Number.isInteger(retryAfterMs) || retryAfterMs <= 0)) {
    throw new Error(`error 的 retryAfterMs 必须是正整数，收到 ${String(retryAfterMs)}`)
  }
  return {
    t: 'error',
    code,
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

export function pong(ts?: number): RelayOutbound {
  return { t: 'pong', ...(ts === undefined ? {} : { ts }) }
}

/**
 * `hello.resume` 补不出来时的回执（P1-3）。构造器守 schema 的 `reason` 值域 ——
 * 与 `makeError` 的 `retryAfterMs` 同一条纪律：造出一张对侧会静默丢掉的帧
 * 比抛错难查得多（小程序对认不出的帧名走 default 静默忽略）。
 */
/**
 * 中继 → 小程序：这个客户端自己的反馈列表。
 *
 * **只给它自己的**（中继按 clientId 过滤，见 relay/src/feedback.ts）——
 * 反馈是明文，所以"谁能看到谁的反馈"必须在中继这一侧就定死，
 * 不能靠客户端自觉只渲染自己的那份。
 */
export function feedbackList(items: readonly FeedbackItem[]): RelayOutbound {
  return { t: 'feedback-list', items: [...items] }
}

export function resumeGap(sessionId: string, reason: 'overflow' | 'reset'): RelayOutbound {
  if (reason !== 'overflow' && reason !== 'reset') {
    throw new Error(`resume-gap 的 reason 只能是 overflow|reset，收到 ${JSON.stringify(reason)}`)
  }
  return { t: 'resume-gap', sessionId, reason }
}

/** 数据面：`sessionId` 逐字来自入帧或配对结果，这里不做任何加工（F3）。 */
export function encToClient(sessionId: string, seq: number, ciphertext: string): RelayOutbound {
  // 与 schema 同源的守门（2026-10-06 审计）：超过上限的密文会让对侧静默丢帧，
  // 而中继在转发前只按字符集把关、不看长度 —— 现象是"发出去没回音"。
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error(`密文 ${ciphertext.length} 字节超过上限 ${MAX_CIPHERTEXT_BYTES}`)
  }
  return { t: 'enc', sessionId, seq, ciphertext }
}

export function encBatchToClient(sessionId: string, items: Array<{ seq: number; ciphertext: string }>): RelayOutbound {
  if (items.length === 0) throw new Error('enc-batch 至少要带一项')
  for (const item of items) {
    if (item.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      throw new Error(`密文 ${item.ciphertext.length} 字节超过上限 ${MAX_CIPHERTEXT_BYTES}`)
    }
  }
  return { t: 'enc-batch', sessionId, items }
}

// ── endpoint → relay 的控制面 ─────────────────────────────────────────
//
// 补上的这一半（2026-10-07）：此前本文件只有"中继 → 端点"与"host → client 载荷"两段，
// 于是 endpoint → relay 的那七个帧——恰好是中继唯一会**解析**的那一组——全靠调用方手写字面量。
// 详见 helloForHost 的注释。

/**
 * 注册：host。
 *
 * **这个函数存在的原因**（2026-10-07）：宿主插件的七个出站控制帧全部是手写字面量
 * （`dsh-remote-control/packages/plugin/src/transport/relay.ts:230,273,301,356,392,433,623`），
 * 而**只有入站**帧过 `parseRelayFrameText`。于是给 `hello` / `enc` / `resync` 改字段
 * 对它没有任何编译期信号：中继收到了形状不对的帧，回一句 `bad_frame`，
 * 而插件这边一切正常。这是 F4 那条纪律（"参数表就是允许出现的字段集合"）的另一半，
 * 此前只对 payload 生效。
 *
 * `protocol` 恒为 `PROTOCOL_VERSION`（除非判据显式注入另一个值来造"版本对不上"）。
 */
export function helloForHost(args: {
  token?: string
  hostId?: string
  label?: string
  protocol?: number
  /**
   * 本端软件版本（2026-10-22）：**缺省就不带这个键**（不是带空串）。
   * 现状（2026-10-23 裁决后）：插件**无条件**上报、小程序上传时默认开（`DRC_REPORT_VERSION`
   * 只关不猜）、中继无条件记 —— 注释里的"默认不带"已是历史。
   */
  softwareVersion?: string
}): EndpointFrame {
  return {
    t: 'hello',
    role: 'host',
    ...(args.protocol === undefined ? { protocol: PROTOCOL_VERSION } : { protocol: args.protocol }),
    ...(args.token === undefined ? {} : { token: args.token }),
    ...(args.hostId === undefined ? {} : { hostId: args.hostId }),
    ...(args.label === undefined ? {} : { label: args.label }),
    // ⚠️ **缺省就不带这个键**（不是带空串）⇒ 不开开关的部署发出去的帧**逐字节相同**。
    ...(args.softwareVersion === undefined ? {} : { softwareVersion: args.softwareVersion }),
  }
}

/**
 * 注册：client。
 *
 * `protocol` **必填**（单版本制）：这里恒写出来，不做"缺省就省掉"那种事。
 */
export function helloForClient(args: {
  clientId?: string
  clientMeta?: { platform?: string; label?: string }
  protocol?: number
  /**
   * 本端软件版本（2026-10-22）：**缺省就不带这个键**（不是带空串）。
   * 现状（2026-10-23 裁决后）：插件**无条件**上报、小程序上传时默认开（`DRC_REPORT_VERSION`
   * 只关不猜）、中继无条件记 —— 注释里的"默认不带"已是历史。
   */
  softwareVersion?: string
}): EndpointFrame {
  return {
    t: 'hello',
    role: 'client',
    ...(args.protocol === undefined ? { protocol: PROTOCOL_VERSION } : { protocol: args.protocol }),
    ...(args.clientId === undefined ? {} : { clientId: args.clientId }),
    ...(args.clientMeta === undefined ? {} : { clientMeta: args.clientMeta }),
    ...(args.softwareVersion === undefined ? {} : { softwareVersion: args.softwareVersion }),
  }
}

/** host 发布一次性配对码（不含 PSK——D1 的执行点）。 */
export function pairBegin(pairingToken: string): EndpointFrame {
  return { t: 'pair-begin', pairingToken }
}

/**
 * client 认领配对码。小程序从不提交 PSK。
 *
 * `clientPub`（2026-10-21 加，schema 可选）：小程序码路线里手机拿不到 psk，
 * 认领时带一枚一次性 X25519 公钥，主机比对完 6 位确认码后用它把 psk 送回来。
 * 3.2 起所有客户端都带它；构造器留可选与 schema 同款（帧形状本身不依赖它）。
 * 参数表补上它是 2026-10-24 审计：此前公共 API 构造不出"今天每个客户端都发的帧"。
 */
export function pairClaim(pairingToken: string, clientPub?: string): EndpointFrame {
  return { t: 'pair-begin-client', pairingToken, ...(clientPub === undefined ? {} : { clientPub }) }
}

/**
 * 心跳。**生产路径不用它**（规范 §4.4：保活靠 WS 层 ping，应用层 ping 会周期性
 * 踢掉空闲客户端）。它在这里是为了让"插件自发探活那条路径"也有一个受 schema 约束的构造器，
 * 而不是像今天这样手写 `{t:'ping', ts}`。
 */
export function ping(ts?: number): EndpointFrame {
  return { t: 'ping', ...(ts === undefined ? {} : { ts }) }
}

/**
 * endpoint → relay 的数据面帧。
 *
 * 与 `encToClient` 的唯一区别是方向命名，因为两边的**长度守门是同一条**：
 * 超过上限的密文会让对侧静默丢帧，而中继在转发前只看字符集、不看长度。
 *
 * ## `clientId` 为什么在这里（2026-10-07 补）
 *
 * schema 里的 `clientId` 是**中继转发时补的**：端点自己发的 `enc` 不带它，
 * 而中继把客户端的上行转给主机时要补上"这是哪台手机"（主机按它做 per-client 回调）。
 * 于是这个字段是**唯一一个"两端都不生产、只有中继生产"**的字段。
 *
 * 原先中继因此只能手写 `{t:'enc',…}` 字面量——那意味着 `sessionId` / `seq` /
 * `ciphertext` 三个字段名在协议层与中继各写一遍，改字段不会编译失败。
 * 参数表补上它之后那条手写路径就消失了。
 */
export function encToRelay(
  sessionId: string,
  seq: number | undefined,
  ciphertext: string,
  clientId?: string,
): EndpointFrame {
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error(`密文 ${ciphertext.length} 字节超过上限 ${MAX_CIPHERTEXT_BYTES}`)
  }
  // `seq` 缺省即"不发这个字段"：schema 里它是可选的（客户端发来的 enc 可以不带），
  // 而写成 `seq: undefined` 会被 JSON.stringify 静默丢掉——行为一样，但源码里
  // 那个 `undefined` 会让人以为"这里总会发一个 seq"。
  return {
    t: 'enc',
    sessionId,
    ...(seq === undefined ? {} : { seq }),
    ciphertext,
    ...(clientId === undefined ? {} : { clientId }),
  }
}

/**
 * 批量帧的**上行**方向：中继把客户端的批量帧原样转给主机。
 *
 * 与 `encBatchToClient` 不同，这里的 `seq` 是**可选**的（跟 schema 一致）：
 * 客户端发来的 items 本来就可能不带 seq，中继在转发这条上行时**不改它**——
 * 重新编号是中继→客户端方向独有的（`forwardEncBatch` 的下行分支）。
 * 所以参数表必须容得下 `seq` 缺失，否则中继只能手写字面量绕过它。
 */
export function encBatchToRelay(
  sessionId: string,
  items: ReadonlyArray<{ seq?: number; ciphertext: string }>,
): EndpointFrame {
  if (items.length === 0) throw new Error('enc-batch 至少要带一项')
  for (const item of items) {
    if (item.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      throw new Error(`密文 ${item.ciphertext.length} 字节超过上限 ${MAX_CIPHERTEXT_BYTES}`)
    }
  }
  return { t: 'enc-batch', sessionId, items: items.map((item) => ({ ...item })) }
}

/**
 * 显式退出某个会话。
 *
 * `clientId` 可选且**只有 client 会带**：中继据此区分"这条 frame 的发送方是会话成员"
 * 与"host 作废了自己的会话"，两条路径给 `peer-left` 的触发完全不同（规范 §8.3）。
 */
export function sessionLeave(sessionId: string, clientId?: string): EndpointFrame {
  return { t: 'session-leave', sessionId, ...(clientId === undefined ? {} : { clientId }) }
}

/**
 * host → 中继：登记状态摘要（M2，REVIEW §5.1）。
 *
 * 摘要**不走 enc**（中继要存、手机回头要读），所以它是明文面 —— 形状防线
 * 在 `statusDigest`（strict：自由文本键整帧拒收）。这里只管原样装箱：
 * 构造器不加字段、不猜字段，schema 认得什么就是什么。
 */
export function summary(sessionId: string, digest: StatusDigest): EndpointFrame {
  return { t: 'summary', sessionId, summary: digest }
}

/**
 * host 声明"我此刻仍持有密钥的会话"（规范 §8.4）。
 *
 * 上限与 `resyncFrame` 的 `.max(2000)` 同源：一条超长的数组会让中继白占内存，
 * 而它对配对没有那么多条通道的要求。构造器在这里先挡一道，
 * 免得造出一条**自己收不了**的帧。
 */
/**
 * 小程序 → 中继：提交一条反馈（**明文**）。
 *
 * `id` 由客户端生成，是**幂等键**：同一条反馈重发（同 id）只留一条 ——
 * 小程序在网络抖动时会重发，而"用户看到提交失败又按一次"会生成两个 id
 * （那是两条反馈，用户确实按了两次，不该被合并）。
 */
export function feedbackSubmit(id: string, text: string, contact?: string): EndpointFrame {
  return {
    t: 'feedback',
    id,
    text,
    ...(contact ? { contact } : {}),
  }
}

/** 小程序 → 中继：拉取"我的反馈"（含已回复的）。 */
export function feedbackPoll(): EndpointFrame {
  return { t: 'feedback-poll' }
}

export function resync(sessionIds: readonly string[]): EndpointFrame {
  if (sessionIds.length > 2000) {
    throw new Error(`resync 最多带 2000 个会话，收到 ${sessionIds.length}`)
  }
  return { t: 'resync', sessionIds: [...sessionIds] }
}

// ── host → client 的数据面载荷 ───────────────────────────────────────

export function sessionChanged(sessions: SessionSummary[], reason?: string): EvSessionChanged {
  return { t: PAYLOAD_TYPES.evSessionChanged, sessions, ...(reason === undefined ? {} : { reason }) }
}

export function messageDelta(args: {
  messageId: string
  delta: string
  sessionId?: string
  part?: number
  role?: 'assistant' | 'user' | 'system'
  done?: boolean
}): EvMessageDelta {
  return { t: PAYLOAD_TYPES.evMessageDelta, ...args }
}

export function toolEvent(args: {
  callId: string
  phase: 'started' | 'args' | 'completed' | 'failed'
  tool?: string
  title?: string
  argsPreview?: string
  resultPreview?: string
  sessionId?: string
}): EvToolEvent {
  return { t: PAYLOAD_TYPES.evToolEvent, ...args }
}

export function permissionRequest(args: {
  requestId: string
  action: string
  options?: ChoiceOption[]
  resource?: string
  reason?: string
  expiresAt?: string
  sessionId?: string
}): EvPermissionRequest {
  return { t: PAYLOAD_TYPES.evPermissionRequest, ...args }
}

/**
 * 收回一张已经不必回答的审批卡（见 `evPermissionResolved` 的注释：桌面与手机同时被问，
 * 谁先答谁算，**输的那一侧要主动收**，不许让它对着一个已关闭的请求继续倒计时、继续可点）。
 */
export function permissionResolved(args: {
  requestId: string
  /** 必填：收场必须精确到会话（见 `evPermissionResolved` 的字段注）。 */
  sessionId: string
  by: 'desktop' | 'cancelled'
}): EvPermissionResolved {
  return { t: PAYLOAD_TYPES.evPermissionResolved, ...args }
}

export function questionRequest(args: {
  requestId: string
  questions: QuestionItem[]
  expiresAt?: string
  sessionId?: string
}): EvQuestionRequest {
  return { t: PAYLOAD_TYPES.evQuestionRequest, ...args }
}

/**
 * 收回一张已经不必回答的提问卡（与 `permissionResolved` 同一条理由：两端同时问、
 * 谁先答谁算，输的那一侧要主动收）。
 *
 * 提问这张卡**本来没有任何倒计时**（`ev.question_request` 今天才补上 `expiresAt`），
 * 所以对它来说这一帧不是"提前收卡"，而是唯一一条能让它消失的路径之一。
 */
export function questionResolved(args: {
  requestId: string
  /** 必填，理由同 `permissionResolved`。 */
  sessionId: string
  by: 'desktop' | 'cancelled'
}): EvQuestionResolved {
  return { t: PAYLOAD_TYPES.evQuestionResolved, ...args }
}

export function runState(args: { state: 'running' | 'idle'; detail?: string; sessionId?: string }): EvRunState {
  return { t: PAYLOAD_TYPES.evRunState, ...args }
}

/**
 * 待办清单（全量快照）。内核每次 `todo/write` 都给整份，所以这里也只发整份——
 * 增量（增删改某一条）在协议里没有形状，手机也不需要理解"改了哪条"。
 */
export function todoList(args: { todos: TodoItem[]; sessionId?: string }): EvTodo {
  return { t: PAYLOAD_TYPES.evTodo, ...args }
}

/**
 * 模型重试。attempt/max/reason 三件套是**手机唯一用得上**的（见 payloads 里的注）。
 *
 * 为什么是这个形状：内核 `llm/retry` 的 data 里还有 policyKey 那段策略 JSON，
 * 对用户毫无意义，不出站；手机要拼的是"正在重试 2/5 · TRANSPORT"。
 */
export function retryNotice(args: { sessionId: string; attempt: number; max: number; reason?: string }): EvRetry {
  return { t: PAYLOAD_TYPES.evRetry, ...args }
}

/** 上下文压缩起止。state 三态别合并（failed 与 ended 对用户是两件事）。 */
export function compactionNotice(args: {
  sessionId: string
  state: 'started' | 'ended' | 'failed'
  error?: string
}): EvCompaction {
  return { t: PAYLOAD_TYPES.evCompaction, ...args }
}

/**
 * 防休眠状态：参数表里没有 `sessionId`（F11）。
 * 想按会话区分就得改协议——那需要先改小程序，而它不在本次范围内。
 */
export function keepAwakeState(args: {
  enabled: boolean
  active: boolean
  platform: string
  backend: string
  reason?: string
}): EvKeepAwakeState {
  return { t: PAYLOAD_TYPES.evKeepAwakeState, ...args }
}

/**
 * 主机限额自述（§13.2）。**没有 `sessionId`**（F11）：限额是主机级的。
 *
 * ⚠️ 2026-10-11 晚：**能力位（`caps`）整条删掉**。它存在的唯一目的是让手机在
 * "对端可能不支持某个载荷"时降级（典型是 `drc.payload.resume` ⇒ 退回重拉一页）。
 * 三端同版本发版 ⇒ 没有"可能不支持"这回事，降级路径也就没有存在理由。
 */
export function hostInfo(args: {
  host: EvHostInfo['host']
  limits: EvHostInfo['limits']
  state: EvHostInfo['state']
}): EvHostInfo {
  return {
    t: PAYLOAD_TYPES.evHostInfo,
    host: args.host,
    limits: args.limits,
    state: args.state,
  }
}

/**
 * 当前模型。
 *
 * **`canSwitch` 必须由生产侧显式给出**，不许让手机从 `options` 有没有值去推断：
 * 「内核不能换」与「能换但清单为空」在手机上必须表现不同（置灰 vs 可点），
 * 推断出来的判断在"清单刚好为空"时会静默错成不可切。
 */
export function model(args: {
  sessionId: string
  model: string
  canSwitch: boolean
  provider?: string
  options?: ModelOption[]
  reason?: string
}): EvModel {
  const payload: EvModel = {
    t: PAYLOAD_TYPES.evModel,
    // sessionId 必填：模型是按会话的，没有它 mp 端无法过滤（§9.29.21）。
    sessionId: args.sessionId,
    model: args.model,
    canSwitch: args.canSwitch,
  }
  if (args.provider !== undefined) payload.provider = args.provider
  // 不可切时**不下发**候选：空数组会让"有候选但都不可选"和"没有候选"在手机上一回事。
  if (args.canSwitch && args.options?.length) payload.options = args.options
  if (args.reason !== undefined) payload.reason = args.reason
  return payload
}

export type EvResultExtras = { message?: string; data?: Record<string, unknown> }

export function result(cmdId: string, ok: boolean, extras: EvResultExtras = {}): EvResult {
  const { message, data } = extras
  return {
    t: PAYLOAD_TYPES.evResult,
    cmdId,
    ok,
    ...(message === undefined ? {} : { message }),
    ...(data === undefined ? {} : { data }),
  }
}

/**
 * 一页历史。
 *
 * **只给游标，不给 `hasMore`**：`nextBeforeSeq` 在 = 还有更早的一页，不在 = 到底了。
 * 原来那版是两个字段，于是"说还有、却忘了给游标"能写得出来，而那产出的是一条
 * 过不了自己 schema 的载荷——它只会在手机侧被静默丢弃，表现是「加载更早」点了没反应。
 * 现在这种状态在类型上不存在。
 */
export function sessionHistory(args: {
  sessionId: string
  cmdId: string
  items: HistoryItem[]
  /** 省略即"这是最初的一页"。 */
  nextBeforeSeq?: number
  /**
   * 这一页覆盖到的最大 seq（**空页也要给**，规范 §10.7 S3）。
   *
   * ⚠️ v3 加这个字段时只改了 schema，**漏了这个构造器**——于是 runtime 转发对了、
   * schema 也认了，而线格式那一步把它丢了。症状：手机收不到 `latestSeq`，
   * 下次重连只能记 0 ⇒ 整段历史重拉（而判据当时只查 schema 与 mock，
   * 正好从这两侧看不见这个洞）。**任何加字段的改动都要过一遍出站构造器。**
   */
  latestSeq?: number
}): EvSessionHistory {
  const { sessionId, cmdId, items, nextBeforeSeq, latestSeq } = args
  return {
    t: PAYLOAD_TYPES.evSessionHistory,
    sessionId,
    cmdId,
    items,
    ...(nextBeforeSeq === undefined ? {} : { nextBeforeSeq }),
    ...(latestSeq === undefined ? {} : { latestSeq }),
  }
}
