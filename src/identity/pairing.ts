/**
 * pairing — 6 位配对码。
 *
 * 3.2 起配对只有一条路：电脑屏幕上那张**小程序码**，码里只有这 6 位数字。密钥不在码里，
 * 由主机在用户比对过两端那 6 位数字之后用 X25519 加密送回手机（`pair-request` → `pair-grant`）。
 *
 * ⚠️ 原来这里还有一条 `dshr:/p?v=1&s=…&psk=…&t=…` 的 URI：构造、解析、以及"两侧逐条对拍"
 * 的向量。**3.2 整条删掉**了——那条 URI 的语义是"密钥在码里"，与本产品的安全姿态正好相反，
 * 而且它存在时屏幕上有两种码，用户永远不知道自己该扫哪一张（两次现场投诉的形状）。
 * 没有第二种码，就不该有第二个格式：`buildPairingUri` / `parsePairingUri` / `PairingInfo`
 * 已从本包消失，别再把它们加回来。
 */
import { randomBytes } from 'node:crypto'

/**
 * 6 位配对码（手输友好）。用 CSPRNG，不用 `Math.random()`。
 *
 * 这是**唯一**的配对凭据形状：屏幕上印的、中继 `pendingPairs` 里存的、手机上 scene 里带的，
 * 都是它。
 */
export function randomPairingToken(): string {
  // 0..999999，均匀取到 6 位：rejection sampling 避免 `randomBytes % 1e6` 的模偏差。
  let n = 0
  do {
    n = randomBytes(3).readUIntBE(0, 3)
  } while (n >= 16_777_216 - (16_777_216 % 1_000_000))
  return formatPairingToken(n % 1_000_000)
}

/**
 * 把整数摆成 6 位数字码。
 *
 * 非有限值（NaN / Infinity）**抛错**而不是返回 `'000NaN'`（2026-10-06 审计）：
 * 那个返回值不是 6 位数字码，扫进去永远配不上，而调用方以为拿到了一张合法的码。
 */
export function formatPairingToken(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`配对码必须来自有限数，收到 ${String(n)}`)
  return String(Math.abs(Math.trunc(n)) % 1_000_000).padStart(6, '0')
}
