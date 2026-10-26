/**
 * registry — 协议注册表：帧名、载荷名、能力 id。
 *
 * ## 为什么要有这个文件
 *
 * 注册表本来是"协议知识"，但它曾经散在三处，每一处都要人肉同步：
 *
 * 1. zod 的两个判别联合（`endpointFrame` / `relayFrame`）——形状的事实源；
 * 2. 中继 `src/server.ts` 里手抄的 `KNOWN_FRAME_NAMES`——**手抄**的一份，用来把
 *    "帧名不认识"（`unknown_frame`）与"名字对、形状坏"（`bad_frame`）分开；
 *    （2026-10-07 已删：中继改 import 本文件的 `FRAME_TYPES` / `isKnownFrameType`。）
 * 3. 伞仓 `e2e/wire-surface.test.mjs` 靠正则从 `payloads.ts` 的**源码文本**里
 *    抽 `'ev.xxx'` / `'cmd.xxx'` 字面量。
 *
 * 三处同步意味着"协议加了帧、中继忘了改"不会编译失败、也不会测试变红，
 * 只是那个新帧在排错时永远收到一句 `unknown_frame`。本文件把 2 与 3 收进来：
 * 中继改 import 即可（删掉那份手抄），伞仓的闸门也能改成比对**导出的常量**
 * 而不是源码文本。
 *
 * ## 编译期保证"这张表与 union 完全一致"
 *
 * 表里多一个名字会怎样？union 解析时那个分支不可达，帧被静默拒收。
 * 表里少一个名字会怎样？那个帧被判成 `unknown_frame`，而对端明明在正确地发它。
 * 两种都是静默的。所以下面用 `_Assert<...>` 把它变成编译错误。
 */
import { PAYLOAD_TYPES, type CmdPayload, type EvPayload } from './payloads.js'
import { errorCodes, type EndpointFrame, type RelayFrame } from './frames.js'

/** 类型层的"不多不少"断言：T 是 true 才编译得过。 */
type _Assert<T extends true> = T

// ── 控制帧名 ─────────────────────────────────────────────────────────

/**
 * endpoint → relay 的全部帧名（规范 §17.1）。
 *
 * 与 `EndpointFrame['t']` 必须完全一致。
 */
const ENDPOINT_FRAME_NAMES = [
  'hello',
  'pair-begin',
  'pair-begin-client',
  'pair-grant',
  'resync',
  'enc',
  'enc-batch',
  'session-leave',
  // M2（2026-10-23）：状态摘要 —— 零知识边界上的明文业务面，中继据此存"最后已知"。
  'summary',
  'ping',
  // 反馈面（2026-10-26）：明文，能力位 `feedback.v1`。
  'feedback',
  'feedback-poll',
] as const
type _EndpointNamesMatchUnion = _Assert<
  Exclude<EndpointFrame['t'], (typeof ENDPOINT_FRAME_NAMES)[number]> extends never
    ? Exclude<(typeof ENDPOINT_FRAME_NAMES)[number], EndpointFrame['t']> extends never
      ? true
      : false
    : false
>

/**
 * relay → endpoint 的全部帧名（规范 §17.1）。
 *
 * 注意末尾那两条：`enc` / `enc-batch` **两个方向都有**——它们既是端点的出站帧，
 * 也是中继转发给对端的载荷载体。漏掉它们的后果正是下面那个 `_Assert` 报的错：
 * 表与 union 对不上，而人眼扫一遍两个列表根本看不出来（那张表写在文档里、
 * union 写在 zod 里，两处从来没有被机械比过）。
 */
const RELAY_FRAME_NAMES = [
  'hello-ok',
  'pair-ready',
  'pair-request',
  'pair-grant',
  'paired',
  'pair-fail',
  'peer-joined',
  'peer-left',
  'error',
  'pong',
  'enc',
  'enc-batch',
  // P1-3（2026-10-22）：`hello.resume` 补不出来时的回执（环滚过/序号重置）。
  'resume-gap',
  // 反馈面（2026-10-26）。
  'feedback-list',
] as const
type _RelayNamesMatchUnion = _Assert<
  Exclude<RelayFrame['t'], (typeof RELAY_FRAME_NAMES)[number]> extends never
    ? Exclude<(typeof RELAY_FRAME_NAMES)[number], RelayFrame['t']> extends never
      ? true
      : false
    : false
>

/** endpoint → relay 的帧名。 */
export const ENDPOINT_FRAME_TYPES: readonly EndpointFrame['t'][] = ENDPOINT_FRAME_NAMES
/** relay → endpoint 的帧名。 */
export const RELAY_FRAME_TYPES: readonly RelayFrame['t'][] = RELAY_FRAME_NAMES
/**
 * 协议里存在过的全部控制帧名（两个方向的并集）。
 *
 * **去重**：enc / enc-batch / pair-grant 三个名字两个方向都有，直接相加会得到 23 个条目、20 个不同名字，
 * 而"注册表里有几条帧"这种问法本身就该按不同名字算——否则文档里的数字会骗人
 * （本项目已经吃过一次这种亏：README 里的"项数"漂了半年，见伞仓 HANDOFF §0.10.6）。
 */
export const FRAME_TYPES: readonly (EndpointFrame['t'] | RelayFrame['t'])[] = [
  ...new Set<EndpointFrame['t'] | RelayFrame['t']>([...ENDPOINT_FRAME_NAMES, ...RELAY_FRAME_NAMES]),
]

const FRAME_TYPE_SET: ReadonlySet<string> = new Set<string>(FRAME_TYPES)

/**
 * 这个名字在协议里存在吗？（规范 §4.3.2 第 5 步）
 *
 * **只回答"名字"，不回答"形状"**——这两个必须分开，它们的错误码不同
 * （`unknown_frame` vs `bad_frame`），而它们对排错的价值完全不同：
 * 前者是"对端版本不对"，后者是"对端发了坏数据"。
 */
export function isKnownFrameType(name: unknown): name is EndpointFrame['t'] | RelayFrame['t'] {
  return typeof name === 'string' && FRAME_TYPE_SET.has(name)
}

// ── 能力面（M-C：hello-ok 的中继声明） ─────────────────────────────────

/**
 * 这一版中继**声明**的能力面（`hello-ok.capabilities`，PLAN-v5 M-C）。
 *
 * 方向是中继 → 端点：端点看见声明才启用新行为（"按声明开"）。清单与
 * 实现同进退 —— 中继实现了什么才声明什么，缺声明时端点一律按"老中继"处理。
 *   · `digest.v1` —— 状态摘要面（M2：主机发 `summary`、手机读 hello-ok.summary）。
 *   · `feedback.v1` —— 反馈面（2026-10-26）：小程序可提交/拉取反馈。
 *     **声明它 = 中继已经实现了那三帧**（否则小程序会对着没实现的端点发帧）。
 *     未声明的老中继 ⇒ 小程序**不开**反馈入口（按声明开，不靠版本号猜）。
 */
export const RELAY_CAPABILITIES = ['digest.v1', 'feedback.v1'] as const

// ── 载荷名 ────────────────────────────────────────────────────────────

/**
 * client → host 的全部命令名（规范 §17.2）。
 *
 * ⚠️ 结尾的 `as const satisfies` 不是风格问题，是下面那个 `_Assert` 能不能生效的**前提**。
 * 原来这里写的是 `: readonly CmdPayload['t'][]`——注解把类型**拓宽**成了"任意命令名数组"，
 * 于是 `(typeof CMD_TYPES)[number]` 就是 `CmdPayload['t']` 本身，
 * `Exclude<A, A>` 恒为 `never`，那条 `_Assert` **永远为真**（它看起来像一道编译期闸门，
 * 实际上一行代码都拦不住）。2026-10-08 加 `ev.host_info` 时漏登记 `EV_TYPES` 就是这么溜过去的，
 * 最后是**运行时**那条 `registry.test.ts` 抓到的。
 * `as const` 让元组保留字面量类型，`satisfies` 仍然检查每一项确实是合法的 t。
 */
export const CMD_TYPES = [
  PAYLOAD_TYPES.cmdSendPrompt,
  PAYLOAD_TYPES.cmdAnswer,
  PAYLOAD_TYPES.cmdResolvePermission,
  PAYLOAD_TYPES.cmdInterrupt,
  PAYLOAD_TYPES.cmdListSessions,
  PAYLOAD_TYPES.cmdKeepAwake,
  PAYLOAD_TYPES.cmdSessionHistory,
  PAYLOAD_TYPES.cmdNewSession,
  PAYLOAD_TYPES.cmdGetPending,
  PAYLOAD_TYPES.cmdArchiveSession,
] as const satisfies readonly CmdPayload['t'][]
type _CmdNamesMatchUnion = _Assert<
  Exclude<CmdPayload['t'], (typeof CMD_TYPES)[number]> extends never
    ? Exclude<(typeof CMD_TYPES)[number], CmdPayload['t']> extends never
      ? true
      : false
    : false
>

/**
 * host → client 的全部事件名（规范 §17.3）。
 *
 * `as const satisfies` 的理由与 `CMD_TYPES` 逐字相同——不给 `as const`，
 * 下面那条 `_EvNamesMatchUnion` 就是一道永远为真的假闸门。
 */
export const EV_TYPES = [
  PAYLOAD_TYPES.evSessionChanged,
  PAYLOAD_TYPES.evMessageDelta,
  PAYLOAD_TYPES.evToolEvent,
  PAYLOAD_TYPES.evPermissionRequest,
  PAYLOAD_TYPES.evPermissionResolved,
  PAYLOAD_TYPES.evQuestionRequest,
  PAYLOAD_TYPES.evQuestionResolved,
  PAYLOAD_TYPES.evRunState,
  PAYLOAD_TYPES.evTodo,
  PAYLOAD_TYPES.evRetry,
  PAYLOAD_TYPES.evCompaction,
  PAYLOAD_TYPES.evKeepAwakeState,
  PAYLOAD_TYPES.evHostInfo,
  PAYLOAD_TYPES.evModel,
  PAYLOAD_TYPES.evResult,
  PAYLOAD_TYPES.evSessionHistory,
] as const satisfies readonly EvPayload['t'][]
type _EvNamesMatchUnion = _Assert<
  Exclude<EvPayload['t'], (typeof EV_TYPES)[number]> extends never
    ? Exclude<(typeof EV_TYPES)[number], EvPayload['t']> extends never
      ? true
      : false
    : false
>

const PAYLOAD_TYPE_SET: ReadonlySet<string> = new Set<string>([...CMD_TYPES, ...EV_TYPES])

/** 这个 `t` 是协议里存在过的载荷名吗？（命令或事件都算） */
export function isKnownPayloadType(name: unknown): name is CmdPayload['t'] | EvPayload['t'] {
  return typeof name === 'string' && PAYLOAD_TYPE_SET.has(name)
}

/** 这个 `t` 是命令吗？ */
export function isCmdType(name: unknown): name is CmdPayload['t'] {
  return typeof name === 'string' && (CMD_TYPES as readonly string[]).includes(name)
}

/** 这个 `t` 是事件吗？ */
export function isEvType(name: unknown): name is EvPayload['t'] {
  return typeof name === 'string' && (EV_TYPES as readonly string[]).includes(name)
}

// ── 自述 ─────────────────────────────────────────────────────────────

/** 注册表自述。文档与闸门用它打印实测值，而不是各写一个数字（见 `scripts/report-gates.mjs`）。 */
export function describeCatalog(): {
  endpointFrames: number
  relayFrames: number
  frames: number
  commands: number
  events: number
  payloads: number
  errorCodes: number
} {
  return {
    endpointFrames: ENDPOINT_FRAME_TYPES.length,
    relayFrames: RELAY_FRAME_TYPES.length,
    frames: FRAME_TYPES.length,
    commands: CMD_TYPES.length,
    events: EV_TYPES.length,
    payloads: CMD_TYPES.length + EV_TYPES.length,
    errorCodes: errorCodes.length,
  }
}
