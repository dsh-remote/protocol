/**
 * frames — 控制面（明文）帧。
 *
 * 这些帧是**中继唯一读得懂的东西**：它按 `t` 与几个标识字段做路由，
 * `ciphertext` 对它是不透明字符串（结构性零知识，docs/DESIGN.md §5.2）。
 *
 * 帧名冻结（F1）：`hello` `hello-ok` `pair-begin` `pair-ready` `pair-begin-client`
 * `paired` `pair-fail` `peer-joined` `peer-left` `enc` `enc-batch` `ping` `pong` `error`。
 * 新增名字是安全的（小程序的 `_onFrame` 把不认识的 `t` 落进 `default` 静默忽略）；
 * **挪用既有名字的语义不是**——比如把心跳响应叫 `peer-left`，
 * 小程序会每收到一次就丢一次配对。
 *
 * 与旧实现的三处结构差异（都不影响小程序，取证 docs/DESIGN.md §4、§8）：
 *
 * - **D5：`auth`/`auth-ok`/`auth-fail` 三帧并成一条 `hello` 注册路径。**
 *   旧的中继里，host 用 `auth`、client 用 `hello` 做同一件事（登记身份、拿回权威 id），
 *   失败面一个是 `auth-fail{reason}` 一个是 `error{code}`。合并后 host 发
 *   `hello{role:'host', token}`，失败统一 `error{code:'bad_token'}`。
 *   小程序仍只发它那一套（F2 的三种帧一个字节都没动）。
 * - **D1：`pair-begin` 不再携带 `psk`。** PSK 只留在主机本地，中继内存里不再有密钥副本。
 * - 删掉两个从未被使用的声明：`session-list` 帧、`cmd.subscribe` 载荷
 *   （前者中继从未发送/处理，后者的 `sessionIds`/`includeContent` 没有任何效果）。
 */
import { z } from 'zod'
import { MAX_CIPHERTEXT_BYTES, MAX_RELAY_MESSAGE_BYTES } from './limits.js'

/**
 * 帧大小预算住 `limits.ts`（三端共享的数值只有一个来源），这里**必须继续转出**：
 * 中继 `src/config.ts` 从 `@dsh-remote/protocol/frames` 引 `MAX_RELAY_MESSAGE_BYTES`
 * 当 `DRC_MAX_MSG_BYTES` 的默认值，撤掉这条转出是一个只会在下游编译期爆炸的变更。
 */
export { MAX_CIPHERTEXT_BYTES, MAX_RELAY_MESSAGE_BYTES }

/** 协议版本。三端同版本发版，**必填**；不等于本端时中继当场拒掉（见 `negotiate.ts`）。 */
export const PROTOCOL_VERSION = 1

/** 6 位配对码。位数变了要同时动三处（中继校验、主机生成、小程序归一化），而小程序改不了。 */
export const PAIRING_TOKEN_RE = /^\d{6}$/

/**
 * 帧大小预算（`MAX_RELAY_MESSAGE_BYTES` / `MAX_CIPHERTEXT_BYTES`）的定义在
 * `limits.ts`，本文件只转出——转出的理由见文件顶部的 import 旁注。
 * 那两个数为什么是今天这个值（1 MiB 预算、8 KiB 信封余量）记在 `limits.ts` 里。
 */

const nonEmpty = z.string().min(1)
const pairingToken = z.string().regex(PAIRING_TOKEN_RE)

/**
 * 密文记录的合法性预检。
 *
 * 为什么必须显式写：`Buffer.from(s,'base64')` 对非法字符是**静默丢弃并继续**，
 * 于是"手机能发、主机报错"这类假故障就没有落点。中继在转发前按标准表校验一次
 * （含 `+` `/` `=`，不含 url-safe 表），错的就直接 `bad_frame` 拒掉——
 * 这也是 D4 之外中继唯一会碰载荷内容的地方，而它碰的只是**字符集**，不是明文。
 */
export const base64Text = z
  .string()
  .min(1)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

const clientMeta = z.object({
  /**
   * 长度上限是**安全要求**，不是洁癖（2026-10-06 审计）：这两个字段会被中继逐字
   * 写进 info 日志，而中继在认证前就收 `hello`。实测单连接 20 帧、每帧 400 KiB 的
   * `platform` → 8.19 MB 日志 / 1.2 秒（journald 按条数限流，不按字节）。给它上界，
   * 加上中继侧对日志值的统一截断，这条放大通路就断了。
   */
  platform: z.string().max(128).optional(),
  label: z.string().max(128).optional(),
})
/** 客户端自报的门面信息（小程序发 `{platform:'wechat-mp', label:'微信小程序'}`）。 */
export type ClientMeta = z.infer<typeof clientMeta>

// ── 端点 → 中继 ─────────────────────────────────────────────────────

/** host 与 client 共用这一条注册帧；`token` 只有 host 会带。 */
export const helloFrame = z.object({
  t: z.literal('hello'),
  role: z.enum(['host', 'client']),
  /** **必填**：两端必须同版本（单版本制，见 `negotiate.ts`）。 */
  protocol: z.number().int().positive(),
  /** host 的出站认证凭据，与中继的 `DRC_HOST_TOKEN` 定时安全比较。上限防超长串白占内存。 */
  token: z.string().min(1).max(512).optional(),
  hostId: nonEmpty.optional(),
  label: z.string().max(128).optional(),
  /** 安装 id，弱随机、非秘密；缺省时由中继分配。上限防一条超长字符串白占内存。 */
  clientId: z.string().min(1).max(128).optional(),
  clientMeta: clientMeta.optional(),
  /**
   * 发送方的**软件版本**（2026-10-22）：主机填插件版本，小程序填小程序版本。
   *
   * ## 为什么加它
   * 排查"为什么这人的两端配不上"时，最缺的**就是**版本号 ——
   * 3.1.x 的插件配不上 3.2.x 的小程序，而**两端都不报错**
   * （见 `packages/client/core/version.js` 的头注：这是 2026-10-21 线上事故的形状）。
   * 有了它，中继就能按版本分组，一眼看出"这批全是老版本"。
   *
   * ## 字段语义与现状（2026-10-23 裁决后）
   * `hello` 是**明文**控制帧 ⇒ 中继**看得见**这个字段。当初因此设计成"默认不带"；
   * 2026-10-23 用户裁决"不用做开关，丰富埋点"后：插件**无条件**上报、小程序上传时
   * 默认开（`mp-upload` 的 `DRC_REPORT_VERSION` 只关不猜）、中继无条件记并聚合
   * （healthz 的 hostVersions/clientVersions）。字段仍是**可选**的（老端点不带也合法）。
   *
   * 它**不是**协议协商位：两端**永远不因它不同而拒连**（版本兼容性由各自的应用层判，
   * 见小程序的 `MIN_PLUGIN_VERSION`）⇒ 它只是给人看的读数。
   */
  softwareVersion: z.string().min(1).max(64).optional(),
  /**
   * 断线补帧请求（P1-3，2026-10-22）：客户端告诉中继"我上次收到这里，
   * 断线期间的下行帧请从环形缓冲里补给我"。
   *
   * ## 为什么搭 `hello` 而不是单独发一帧 `resume`
   *
   * 竞态：客户端重连后 socket 一进成员表，主机的下行帧就会**立刻**推给它；
   * 而一条独立的 `resume` 帧要等下一个事件循环才被处理 —— 中间挤进来的
   * live 帧会**先于**回放到达（重连发生在输出流中段时几乎必然）。要么在客户端
   * 做重排缓冲 + 去重，要么在中继侧按 socket 暂停投递 —— 两边都比问题本身大。
   * 搭 `hello` 则整段（鉴权、进表、回放）在**同一个同步处理**里完成：
   * 回放帧先于 socket 进入投递表，顺序由构造保证，客户端一行重排代码都不用。
   *
   * ## 为什么这是加性变更（§15.1 第一行：新增可选字段，不升 PROTOCOL_VERSION）
   *
   * - **旧中继 × 新客户端**：旧 schema 没有这一格 ⇒ zod strip 掉、静默忽略 ⇒
   *   行为与加这个字段之前逐字节相同（客户端退回收不到回放，走既有历史重读）。
   *   **不会**回 `unknown_frame` —— 这正是不发独立帧的第二个好处。
   * - **新中继 × 旧客户端**：旧客户端不填 ⇒ 不回放 ⇒ 逐字节现状。
   * - F2（client 只发 3 类帧 + `session-leave`）**不动**：没有新增客户端出站帧名。
   *
   * ⚠️ 只有 `role:'client'` 有意义；主机带了会被忽略（没有"主机断线补下行"的场景）。
   * ⚠️ 只补**当前配对那一条**会话（小程序同时只有一条有效 convId）。
   * ⚠️ `fromSeq` 是**中继编号**（`enc`/`enc-batch` 里的 `seq`），不是主机历史游标
   *   `latestSeq` —— 两个序号空间互不相干，混用的症状是"补回来一段莫名其妙的内容"。
   */
  resume: z
    .object({
      /** 配对通道 id（与 `enc.sessionId` 同义，F3）。 */
      sessionId: nonEmpty,
      /** 已收到的最大中继编号；中继回放 `seq > fromSeq` 的存帧。0 = 一帧都没收到过。 */
      fromSeq: z.number().int().nonnegative(),
    })
    .optional(),
})

/** X25519 公钥：32 字节的 base64（44 字符，末尾一个 `=`）。 */
const publicKeyB64 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, '必须是 32 字节 base64 公钥')

/** 主机发布一次性配对码。**没有 psk 字段**——这是 D1 的执行点。 */
export const pairBeginFrame = z.object({
  t: z.literal('pair-begin'),
  pairingToken,
})

/**
 * 客户端认领配对码。小程序从不提交 PSK。
 *
 * `clientPub`（2026-10-21 加，**可选**）：小程序码路线里手机拿不到 psk，
 * 得在这里带一枚一次性 X25519 公钥，主机确认后再把 psk 加密送回来。
 * 3.2 起所有客户端都带它；可选只是为了让 `pair-begin-client` 这个帧形状本身不依赖它
 * （不带时中继照常把认领转给主机，只是不会收到 `pair-request`）。
 */
export const pairClaimFrame = z.object({
  t: z.literal('pair-begin-client'),
  pairingToken,
  clientPub: publicKeyB64.optional(),
})

/**
 * 中继 → 主机：有人拿 publicKeyB64 来认领这张码（2026-10-21）。
 *
 * 中继只是**转发**：它把 `pair-begin-client` 里的 `clientPub` 原样带给主机。
 * 中继不知道 psk，也不知道主机将回什么。
 */
export const pairRequestFrame = z.object({
  t: z.literal('pair-request'),
  pairingToken,
  clientPub: publicKeyB64,
  /**
   * 认领这条码时**新开的会话号**。中继在 claim 的同一时刻就知道它，一并带来：
   * 主机回 `pair-grant` 必须带会话号（见 pairGrantFrame），否则中继无处可送。
   */
  sessionId: nonEmpty,
  hostId: nonEmpty.optional(),
})

/**
 * 主机 → 中继 → 手机：psk 的密文（2026-10-21）。
 *
 * 三个字段都是中继眼里的**不透明字节**：`hostPub` 是主机的临时公钥，
 * `nonce` + `wrappedPsk` 是 `secretbox(psk)`。中继只负责转交。
 */
export const pairGrantFrame = z.object({
  t: z.literal('pair-grant'),
  /**
   * **带 sessionId 而不是 pairingToken**（2026-10-21 拍板）。
   *
   * 中继在 `claim()` 之后就没有 token→会话 的映射了（pendingPairs 当场消费），
   * 若按 token 转发就得再养一张 60s 的短命表。而主机在 `peer-joined` 里**已经拿到
   * sessionId**，让它把会话号原样带回来，中继按会话成员转发即可，零新状态。
   */
  sessionId: nonEmpty,
  hostPub: publicKeyB64,
  nonce: nonEmpty,
  wrappedPsk: nonEmpty,
})

export const encFrame = z.object({
  t: z.literal('enc'),
  /** 配对通道 id（`c_xxx`），不是 DSH 会话 id（F3）。 */
  sessionId: nonEmpty,
  /** 元数据而已：不得校验单调（F13），host→client 方向由中继重新编号。 */
  seq: z.number().int().nonnegative().optional(),
  clientId: z.string().min(1).max(128).optional(),
  /**
   * 这里只要求"非空字符串"，**字符集合不合法由 `base64Text` 单独把关**。
   * 故意分两层：混在 schema 里，中继就没法区分"形状不对（unknown_frame）"与
   * "密文不是合法 base64（bad_frame）"，而这两个错误码对排错的价值完全不同。
   */
  ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_BYTES),
})

export const encBatchFrame = z.object({
  t: z.literal('enc-batch'),
  /** 通道 id 只在外层；小程序逐项解密时复用它。 */
  sessionId: nonEmpty,
  items: z
    .array(
      z.object({
        seq: z.number().int().nonnegative().optional(),
        ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_BYTES),
      }),
    )
    .min(1)
    /**
     * 项数上限（2026-10-06 审计）：没有上限时一条批量帧可以塞进任意多项，
     * 中继要么在 WS 层按 maxPayload 拒掉、要么先吃满内存再拒。
     * 取 200：单帧总量仍由中继的 maxPayload 兜底（每项最小也有 nonce+MAC+JSON 开销），
     * 这个数只是"别让 items 本身变成无界的"。
     */
    .max(200),
})

/** 显式退出某个会话（D3 之后会话会长存，需要一条主动退出的路）。 */
export const sessionLeaveFrame = z.object({
  t: z.literal('session-leave'),
  sessionId: nonEmpty,
})

/**
 * **状态摘要**（M2，REVIEW-offline-continuity §5.1）——零知识边界上唯一的明文业务面。
 *
 * 零知识切分（§5.1 原文）：「**内容**零知识（中继不可解密）＋ **状态**可留存
 * （最后活动时间 / 进度摘要 / 待审批数）」。正因为它不走 enc（中继要存、
 * 手机回头要读），**形状就是防线**：
 *
 *   · 只许状态类字段 —— 时刻（at）/ 布尔（running）/ 非负整数（steps、pending）；
 *   · **一个自由文本都不许有**（title/detail/content…）——§5.1 风险条：
 *     「摘要粒度要克制（不写具体任务文本）」，自由文本一进来就是内容侧漏；
 *   · `strict()` 是执行点：多带一个键 ⇒ **整帧拒收**（bad_frame），
 *     不是静默剥掉 —— 静默剥掉是"主机以为存上了、其实没有"，
 *     而拒收会当场出声（判据：tests/wire/summary.test.ts 的 strict 反证那条）。
 */
export const statusDigest = z
  .object({
    /** 最后活动时刻（主机时钟，epoch ms）。「最后已知于 X」的 X。 */
    at: z.number().int().nonnegative(),
    /** 正在跑还是已停（§5.1 的两态；没有第三种）。 */
    running: z.boolean(),
    /** 进度：已完成的工具步数（数字，不是文本）。 */
    steps: z.number().int().nonnegative().optional(),
    /** 在等人处理的审批/提问数（§5.1：待审批数）。 */
    pending: z.number().int().nonnegative().optional(),
  })
  .strict()
export type StatusDigest = z.infer<typeof statusDigest>

/** 主机 → 中继：把状态摘要登记到会话条目上（中继持久化它，见 relay/persist）。 */
export const summaryFrame = z.object({
  t: z.literal('summary'),
  /** 通道 id（与 enc / session-leave 同一取值空间）。 */
  sessionId: nonEmpty,
  summary: statusDigest,
})

export const pingFrame = z.object({ t: z.literal('ping'), ts: z.number().optional() })

/**
 * 主机声明"我此刻仍持有密钥的会话有哪些"。
 *
 * 为什么必须有这条（复核 R1）：D3/D6 让会话跨断连存活之后，出现了旧实现没有的
 * 死角——**主机进程重启**（PSK 随之消失）而中继不知道，于是它继续把手机发来的
 * 密文转发给一个解不开的主机；手机既收不到回复、也收不到 `unknown_session`，
 * 表现是"永远转圈且没有任何提示"。中继自己的表命中与否并不能代表主机是否还认得这个会话。
 *
 * 语义：主机鉴权成功后立刻发一条 `resync`，列出它还持有的 convId。
 * 中继把该主机名下**没被列出**的会话删掉，但**不**向客户端发 `peer-left`——
 * 那在小程序里会翻成一条英文 toast（没有映射），而是让客户端下一次用旧 convId
 * 发帧时自然撞上 `unknown_session`，从而得到中文的"会话已失效，请重新配对"。
 */
export const resyncFrame = z.object({
  t: z.literal('resync'),
  sessionIds: z.array(nonEmpty).max(2000),
})

// 刻意不提供"逐条确认会话还在"的帧：resync 一次就够，
// 多一个入口只会多一类"两条路说法不一致"的故障。

// ── 反馈面（2026-10-26）─────────────────────────────────────────────
//
// ## 这是一块**明文**平面，而且是**唯一**一块中继读得懂的自由文本
//
// 零知识边界此前只有两个例外：`summary`（状态摘要，纯状态类字段）与管理面
// （`/healthz` 等只出计数与版本）。本节是**第三个**，而且性质不同：
//
//   · `summary` 是**主机**自动上报的**状态**（时刻/布尔/整数），白名单 strict
//     把关，**一个自由文本都不许有**（见上面 statusDigest 那段）；
//   · 反馈是**用户亲手敲的**意见，**它的全部价值就在于那句话本身**。
//     把它加密就没有人读得到——而读它的人正是要改这个产品的人。
//
// ⇒ 所以这不是"破了一次零知识"，而是**开了一扇有名字的门**：
//   ① 它只承载用户**主动提交**的那一段文字，不与任何会话内容混流；
//   ② 它**不经过 enc**，中继存的是原文（明文），落盘文件与 state.json 分开；
//   ③ 它有**能力位**（`feedback.v1`）——中继不声明，小程序就不开这个入口；
//   ④ 它有**限频**与**体量上限**（见 relay/src/feedback.ts），因为客户端**无鉴权**
//     （clientId 是自报的，见 server.ts 的 handleHello 客户端分支）——
//     没有限频的话这是一台免费的留言板。
//
// ## 形状纪律
//
// 帧对象本身**不 strict**（与 ping/summary 同款：zod 默认剥掉未知键）；
// 但**条目**（`feedbackItem`）strict —— 它是要落盘的形状，落盘的文件不是信任边界
// （可能被人手改过），坏形状的整条丢掉而不是剥键放行（同 statusDigest 的理由）。

/**
 * 反馈的**响应承诺**：24 小时（2026-10-26 产品裁决）。
 *
 * 这个数写在协议层是因为**两处必须一致**：中继算「逾期未回」用它，
 * 小程序显示「承诺 24 小时内回复」也用它。两处各写一个 24 的话，
 * 有一天有一处被改成 48，用户看到的承诺就和中继的口径对不上 ——
 * 而"承诺"这件事一旦对不上，整条通道就失去意义。
 */
export const FEEDBACK_SLA_HOURS = 24

/** 反馈正文的上限。够写三段话，不够写一篇作文。 */
export const FEEDBACK_TEXT_MAX = 2000
/** 联系方式（可选）的上限。留空也完全合法 —— 匿名反馈我们一样回，只是回不到。 */
export const FEEDBACK_CONTACT_MAX = 120

export const feedbackText = z.string().min(1).max(FEEDBACK_TEXT_MAX)
export const feedbackContact = z.string().min(1).max(FEEDBACK_CONTACT_MAX)

/**
 * 一条反馈（**明文**）。落盘的形状，也是中继 → 小程序 回包里的形状。
 *
 * `status` 只有两态：`open`（还没回）与 `replied`（回了）。
 * 没有第三态 ——「已回」和「没回」是两种事实，别的都是这两个的组合。
 */
export const feedbackItem = z
  .object({
    /** 提交时由小程序生成的 id（客户端自己的，不含时间戳以外的信息）。 */
    id: nonEmpty,
    /** 用户原话。**明文**。 */
    text: feedbackText,
    /** 联系方式（可选）。用户不填就没有这个键。 */
    contact: feedbackContact.optional(),
    /** 提交时刻（epoch ms，中继落库时刻为准 —— 客户端的钟不可信）。 */
    at: z.number().int().nonnegative(),
    status: z.enum(['open', 'replied']),
    /** 我们的回复（可选；`status==='replied'` 时必有）。 */
    reply: z.string().min(1).max(FEEDBACK_TEXT_MAX).optional(),
    /** 回复时刻（epoch ms）。 */
    repliedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
export type FeedbackItem = z.infer<typeof feedbackItem>

/** 小程序 → 中继：提交一条反馈。 */
export const feedbackFrame = z.object({
  t: z.literal('feedback'),
  /** 客户端生成的 id（幂等键：同 id 重复提交只留一条）。 */
  id: nonEmpty,
  text: feedbackText,
  contact: feedbackContact.optional(),
})

/** 小程序 → 中继：拉取"我的反馈"（含已回复的那些）。 */
export const feedbackPollFrame = z.object({ t: z.literal('feedback-poll') })

/** 中继 → 小程序：这个客户端自己的反馈列表（**只给它自己的**）。 */
export const feedbackListFrame = z.object({
  t: z.literal('feedback-list'),
  items: z.array(feedbackItem).max(200),
})

/** 端点可能发给中继的一切。 */
export const endpointFrame = z.discriminatedUnion('t', [
  helloFrame,
  pairBeginFrame,
  pairClaimFrame,
  // 主机发出去的：psk 密文（中继原样转交给手机）
  pairGrantFrame,
  resyncFrame,

  encFrame,
  encBatchFrame,
  sessionLeaveFrame,
  summaryFrame,
  pingFrame,
  // 反馈面（2026-10-26）：明文，能力位 `feedback.v1`。
  feedbackFrame,
  feedbackPollFrame,
])
export type EndpointFrame = z.infer<typeof endpointFrame>

// ── 中继 → 端点 ─────────────────────────────────────────────────────

export const helloOkFrame = z.object({
  t: z.literal('hello-ok'),
  role: z.enum(['host', 'client']),
  /** 权威 clientId：小程序会采纳它并覆盖本地安装 id（F2/§3.6）。 */
  clientId: z.string().min(1).max(128).optional(),
  hostId: nonEmpty.optional(),
  protocol: z.number().int().positive(),
  /**
   * **中继声明**的能力面（M-C，PLAN-v5）。方向是中继 → 端点（下发）：
   * 端点看见声明才启用新行为（"按声明开"）。有界（32 条 × 64 字符）：
   * hello-ok 也是不可信输入，别给它放大日志的机会。**不认枚举** ——
   * 未来的中继多声明新面时，老端点只当没看见（`supportsCapability`），
   * 不许拒帧（向前兼容）。
   */
  capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
  /**
   * 状态摘要（M2 的下发载体，随 M-C 上车）：只有声明 `digest.v1` 的中继才会带，
   * 端点**看见声明才消费**。形状照 `statusDigest` 的 strict（自由文本进不来）。
   */
  summary: statusDigest.optional(),
})

/**
 * hello-ok 的声明里有这个面吗（M-C "按声明开"的执行点）。
 *
 * 输入不校验形状：`undefined` / 非数组 / 带怪名字都只回答"没有"，
 * **不抛不拒帧** —— 未来的中继多声明新面时，老端点必须安静地跳过。
 */
export function supportsCapability(capabilities: unknown, id: string): boolean {
  return Array.isArray(capabilities) && capabilities.some((item) => item === id)
}

/** 服务端权威 TTL。**主机必须据此改写本地过期时间**——这是旧实现的第一起事故。 */
export const pairReadyFrame = z.object({
  t: z.literal('pair-ready'),
  pairingToken,
  /**
   * 服务端权威 TTL。**有上界**（2026-10-07 补）。
   *
   * 为什么"正整数"不够：端点拿它算本地过期时刻（`createdAt + ttlMs`），
   * 而那一步之后会走 `new Date(...).toISOString()` —— Date 的合法范围是
   * ±8.64e15 ms，一个 `1e17` 的 TTL 让 `toISOString` 抛 `RangeError`。
   *
   * 症状特别贵：那一抛发生在宿主侧**构造 status.json 快照**的过程中，而
   * `shell/status.ts` 的写盘外面包着一个空 catch（"状态入口不许成为崩溃源"）
   * —— 于是**整个 status.json 从此永久停更**，而 GUI 宿主里那是唯一的排错入口
   * （`carrier` / `relay` / `problems` 全部冻在启动那一版）。
   *
   * 上界取 30 天：真实的配对码 TTL 是秒级到分钟级（中继默认 120 s、
   * 本机线上 180 s），30 天已经宽到不可能是误配。而它离 Date 的上限
   * 仍有 11 个数量级，所以这条约束不会在可见的将来变成障碍。
   */
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(30 * 24 * 3600 * 1000),
})

export const pairedFrame = z.object({
  t: z.literal('paired'),
  /** 小程序把它当 convId 持久化并参与密钥派生：缺了它后面全部解不开（F4/F6）。 */
  sessionId: nonEmpty,
  hostId: nonEmpty,
})

/** 四个 reason 是 UI 分支条件，小程序有逐字的中文映射表（F6）。 */
// reason 的取值集合是**冻结消费面**的一部分（F6）：小程序 `packages/client/core/client.js:translatePairFail`
// 只认这四个键（invalid_or_expired / already_used / host_offline / bad_token），
// 多一个就把英文字面量弹到用户脸上。中继侧内部原因（rate_limited 之类）
// 要记进日志，落到线上的 reason 必须是这张表里的一个。
export const pairFailFrame = z.object({
  t: z.literal('pair-fail'),
  reason: z.enum(['invalid_or_expired', 'already_used', 'host_offline', 'bad_token']),
  /**
   **是哪一张码失败的**（2026-10-07 补，加性）。
   *
   * ## 为什么必须有它
   *
   * 这个帧原先只有 `reason`，而主机侧的处理是"作废**当前展示的那张**"——
   * 于是它只能拿 `active.pairing` 顶罪。多码并存时那会**作废错的那张**：
   * 屏幕上是码 B（完全有效），用户扫了一张早就过期的码 A → 中继回
   * `invalid_or_expired` → 主机把 B 记进 `spentTokens` 并 forget，再补一张 C。
   *
   * 症状不是"多扫一次码"：B 的 PSK 被丢弃意味着那条配对通道作废，
   * 而这正是文件头引用的那起「取错 PSK 全线解不开」事故的前置条件。
   *
   * ## 为什么可选
   *
   * **中继不总能知道是哪一张**：帧本身坏掉那条分支（`server.ts` 里 `bad_frame` 那条）
   * 手上没有 token 可点名。缺省时主机按"当前展示的那张"兜底
   * （`onPairFail` 的注释里写着这条兜底的原因）。
   */
  pairingToken: z.string().min(1).max(16).optional(),
})

export const peerJoinedFrame = z.object({
  t: z.literal('peer-joined'),
  sessionId: nonEmpty,
  clientId: nonEmpty.optional(),
  /** 发给主机的那一份**必须**带：主机按它取对应的 PSK（多码并存那起事故的根因）。 */
  pairingToken: pairingToken.optional(),
})

/** 对客户端而言，`peer-left` 只有一个合法触发：**主机离开**（D3 把这条写死）。 */
export const peerLeftFrame = z.object({
  t: z.literal('peer-left'),
  sessionId: nonEmpty,
  clientId: nonEmpty,
  /**
   * **这一条是不是「主动解配」**（可选，2026-10-05）。
   *
   * 为什么必须能区分：发给主机的 `peer-left` 有两个触发，现场长得一模一样——
   *   - 手机点了「解除配对」（发 session-leave）：它 `_forgetPairing()` 清了 convId，
   *     **再也不会带这个 convId 回来**。主机留着这条会话就是一条永远清不掉的幽灵。
   *   - 手机 socket 断了（切后台、断网）：D3 要求会话留着，回前台还要用它。
   *
   * 不带这个标记 = **断线**（D3：会话留着，回前台还要用）；带 true = 主动解配，
   * 主机应当把会话一并作废，于是 pill 从「手机离线」回到「未配对」
   * （2026-10-05 用户报：「mp 端解除配对，dsh 端执行的是手机离线」）。
   *
   * 可选是**语义**上的：它表达"这次离开是断线还是解配"，缺省必须是断线
   * （主机不许假定是解配 —— 那会把用户的一条会话凭空作废）。
   */
  unpaired: z.boolean().optional(),
})

export const errorCodes = [
  'bad_role',
  'bad_token',
  'need_host',
  'need_client',
  'bad_pair',
  'pair_table_full',
  /** 客户端靠这个字面量决定"清配对并提示重扫"（F5）。 */
  'unknown_session',
  /** D4：发送方不是该会话成员。 */
  'not_member',
  /**
   * **尚未配对**（2026-10-26，反馈面）。
   *
   * 反馈通道只对**配对成功**的用户开放（产品裁决）：中继以"这个 clientId 是否是
   * 某条活跃会话的成员"为凭据 —— 那需要真走过一次扫码 + SAS 确认，不是自报能伪造的。
   *
   * 它必须区别于 `unknown_session`（那个码让客户端**清配对并要求重扫**）：
   * 这里配对关系是好的，只是这一条业务动作没资格做 ⇒ 客户端只提示"先配对再反馈"，
   * **绝不能**顺手把配对清了（那会造成"想提意见反而配不上了"）。
   */
  'not_paired',
  /**
   * 会话还在，但主机此刻不在（宽限期内）。**必须区别于 `unknown_session`**：
   * 客户端见到 `unknown_session` 会丢掉配对并要求重新扫码，而这里只是"这条指令没人接"，
   * 用户重试即可，配对关系不该因此作废（D3/D6）。
   */
  'host_unavailable',
  'bad_frame',
  'rate_limited',
  'bad_json',
  'unknown_frame',
  /**
   * `cmd.session_history.since` 落在主机的保留窗口之外（V3-PLAN §5.1）。
   *
   * **它必须是一个明确的码，而不是"少给几条"**：主机只保留最近 N 条 seq，
   * 而手机记的 `since` 可能比那更早（长时间离线）。此时若静默从窗口头部开始给，
   * 手机会以为补齐了，实际中间缺一段——而那段永远补不回来。
   *
   * ⚠️ **不可重试**：重发同一条 `since` 仍然是窗口外。客户端该做的是**改拉历史**
   * （退回 v2 的重拉一页），这也是它不在 `RETRYABLE` 里的原因。
   */
  'history_window_exceeded',
  /**
   * 对端报的协议版本与本端**不相等**（含没报，规范 §5.2 V3）。
   *
   * 为什么不复用 `bad_frame`：它是**版本问题**而不是形状问题，而它唯一该触发的
   * 动作是"把版本说清楚"——一句"帧形状非法"会让用户去查一个根本不存在的问题。
   * 不认识的码在客户端会走兜底展示（`message || code`），所以中继 MUST 同时带上一句
   * 中文 message（规范 §12.3 E1）—— 反过来，"没带 message"就是把英文码弹给用户。
   */
  'unsupported_protocol',
  'internal',
] as const

export const errorFrame = z.object({
  t: z.literal('error'),
  code: z.enum(errorCodes),
  message: z.string().max(512).optional(),
  /**
   * 多久之后可以再来（毫秒）。借鉴 RFC 9110 的 `Retry-After` 的**毫秒形态**。
   *
   * 只有 `rate_limited` / `pair_table_full` 这类"等一等就好"的码才带它：
   * 端点拿它直接算退避，而没有它时只能盲退——盲退在限速窗口上等于
   * "再多撞几次，每一次都让窗口重新计时"。
   */
  retryAfterMs: z.number().int().positive().max(300_000).optional(),
})
export type ErrorCode = z.infer<typeof errorFrame>['code']

export const pongFrame = z.object({ t: z.literal('pong'), ts: z.number().optional() })

/**
 * `hello.resume` 补不出来的回执（P1-3，2026-10-22）：环形缓冲滚过了要补的那段，
 * 或者序号对不上 —— **明说缺了**，而不是悄悄少发几帧。
 *
 * 客户端收到它什么都不用做：缺帧的内容由既有的"重建显示"路径兜底
 * （`status` 回 online 后 chat 页的 `_tryLoadDelta`/`_loadHistory`），
 * 它只是把"这是一段缺口"从静默变成可判据、可计数的事件。
 * 真没有缺口时中继**不发**这一帧（回放几帧就是几帧，零帧就什么都不发）。
 *
 * ⚠️ reason 只有两个值：`overflow`（环滚过/中继重启丢了环）与 `reset`
 * （客户端游标跑到了计数器前面 —— 会话被重建过或 state 被手改过）。
 * 会话不存在/不是成员**不走这一帧**：那条路已经有 `unknown_session` 错误码
 * （F5 唯一清配对信号），多一个入口只会多一类"两条路说法不一致"的故障。
 */
export const resumeGapFrame = z.object({
  t: z.literal('resume-gap'),
  sessionId: nonEmpty,
  reason: z.enum(['overflow', 'reset']),
})

/** 中继可能发给端点的一切。 */
export const relayFrame = z.discriminatedUnion('t', [
  helloOkFrame,
  pairReadyFrame,
  // 中继发出的两条：认领请求带给主机、psk 密文带给手机
  pairRequestFrame,
  pairGrantFrame,
  pairedFrame,
  pairFailFrame,
  peerJoinedFrame,
  peerLeftFrame,
  errorFrame,
  pongFrame,
  encFrame,
  encBatchFrame,
  resumeGapFrame,
  // 反馈面（2026-10-26）。
  feedbackListFrame,
])
export type RelayFrame = z.infer<typeof relayFrame>

// ── 解析与构造 ──────────────────────────────────────────────────────

/** 中继解析端点来帧。`t` 认不出 → null（调用方回 `unknown_frame`）。 */
export function parseEndpointFrame(value: unknown): EndpointFrame | null {
  const parsed = endpointFrame.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 端点（主机或小程序）解析中继来帧。 */
export function parseRelayFrame(value: unknown): RelayFrame | null {
  const parsed = relayFrame.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** JSON 文本 → 对象 → 中继来帧；任何一步失败都 null（小程序侧同样静默丢弃非法帧）。 */
export function parseRelayFrameText(raw: string): RelayFrame | null {
  try {
    return parseRelayFrame(JSON.parse(raw))
  } catch {
    return null
  }
}
