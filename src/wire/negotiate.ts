/**
 * negotiate — 协议版本校验（**单版本**，2026-10-11 晚）。
 *
 * ## 为什么这一闸非有不可
 *
 * `hello.protocol` 对了才允许继续。不对的时候，这套协议的现场表现是
 * "连上了、界面正常、什么都不发生" —— 没有一层会报错，日志里也什么都没有。
 * 那是这套协议里最贵的一类故障，所以两端**必须**报版本，且必须与本端一致。
 *
 * ## ⚠️ 这里已经没有"协商"了
 *
 * 原来有两条为"三端发版节奏不同"准备的容忍路径：
 * - **V1**：对端不报版本就按 1 处理（"兼容既有小程序"）；
 * - **V3**：只要求对端落在 `[MIN_SUPPORTED_PROTOCOL, 本端]` 区间里。
 *
 * 没有老用户、三端同时发版 ⇒ 两条都删掉：**不报 = 拒，不等于本端 = 拒**。
 * 留下的唯一自由度是 `own` 可注入 —— 那是给判据造"版本对不上"用的，不是给线上用的。
 */
import { PROTOCOL_VERSION } from './frames.js'

export { PROTOCOL_VERSION }

/** 判定结果。`ok:false` 时 `message` 是**可以直接给用户看**的中文。 */
export type VersionVerdict =
  | { ok: true; version: number }
  | { ok: false; reason: 'missing' | 'mismatch' | 'invalid'; message: string; peer: unknown }

/**
 * 校验对端报的协议版本。
 *
 * 三条规则，逐条对应"说不清就拒"：
 * - **没报**（`undefined` / `null`）⇒ 拒：版本是必填字段，缺了说明对端不是这一版；
 * - **不是正整数** ⇒ 拒（`invalid`，与"版本不同"分开，排错方向不同）；
 * - **不等于本端** ⇒ 拒（`mismatch`）。
 */
export function negotiateProtocol(peerProtocol: unknown, own: number = PROTOCOL_VERSION): VersionVerdict {
  if (peerProtocol === undefined || peerProtocol === null) {
    return {
      ok: false,
      reason: 'missing',
      peer: peerProtocol,
      message: `对方没有报协议版本（本端为 ${own}）：把对端升到同一版本再试`,
    }
  }
  if (typeof peerProtocol !== 'number' || !Number.isInteger(peerProtocol) || peerProtocol <= 0) {
    return {
      ok: false,
      reason: 'invalid',
      peer: peerProtocol,
      message: `对方报告的协议版本不是正整数（收到 ${JSON.stringify(peerProtocol) ?? 'undefined'}）`,
    }
  }
  if (peerProtocol !== own) {
    return {
      ok: false,
      reason: 'mismatch',
      peer: peerProtocol,
      /**
       * ⚠️ 这句话**会被原样弹到用户手机上**（中继 `acceptProtocol` 显式带 message，
       * 而客户端的处理是 `f.message || f.code`）。所以人称必须从**读它的人**出发：
       * 收这条错的那端才是要被升级的那端。写"请把本端升级"时，手机用户读到的是
       * "请升级我的手机"，而真正落后的是中继/主机那一侧 —— 两个方向都试过，
       * 都会指错人。⇒ 只陈述事实（本端 X、对方 Y），由人来判断升哪一端。
       */
      message: `协议版本对不上：这一端是 ${own}，对方是 ${peerProtocol}。两端必须是同一版本`,
    }
  }
  return { ok: true, version: peerProtocol }
}

/** 版本自述，用于日志与 `/api/info`。 */
export function describeVersion(): { protocol: number } {
  return { protocol: PROTOCOL_VERSION }
}
