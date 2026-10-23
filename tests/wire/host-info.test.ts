/**
 * `ev.host_info`（规范 §13.2，附录 D·GAP-5）的判据。
 *
 * ## 这个载荷为什么必须存在
 *
 * 手机要知道**这台主机此刻真正能收多少**（图片/文件张数、字节上限、正文字数）——
 * 少了它只能猜，而猜错的两种方向都有代价：猜大了提示发不出去、猜小了白关掉能用的功能。
 * 这些数只能由**主机自己在加密通道里**说出来：中继是结构性零知识的，
 * 让它回答"主机能收多少"等于把内容面的判断塞进一个只负责转发的角色。
 *
 * ## ⚠️ 2026-10-11 晚：这一帧不再带能力位（`caps`）
 *
 * 原来它同时是 `drc.payload.resume` 那条降级路径的载体（"对端没有这一位 ⇒ 手机
 * 退回重拉一页"）。三端同版本发版 ⇒ 没有"可能不支持"这回事，能力位连同注册表一起删除。
 * 本文件因此只钉**限额与自身信息**这两件事，以及"形状只有一种"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evHostInfo, hostLimits } from '../../src/wire/payloads.js'
import type { EvHostInfo } from '../../src/wire/payloads.js'
import { EV_TYPES, describeCatalog, isEvType, isKnownPayloadType } from '../../src/wire/registry.js'
import { hostInfo } from '../../src/wire/outbound.js'

/** 一份最小合法载荷。形状**从 schema 反推**，不照记忆手写。 */
const valid = (): EvHostInfo => ({
  t: 'ev.host_info',
  host: { platform: 'darwin', arch: 'arm64' },
  limits: {
    maxImageAttachments: 4,
    maxFileAttachments: 4,
    maxAttachmentBytes: 512 * 1024,
    maxTextChars: 20_000,
  },
  state: { sleep: 'caffeinate' },
})

test('① ev.host_info 进了事件表与注册表的每一条查询路（漏登记是静默的）', () => {
  assert.ok(isEvType('ev.host_info'), 'isEvType 必须认它：宿主按这条判据决定能不能发')
  assert.ok(isKnownPayloadType('ev.host_info'), 'isKnownPayloadType 也要认：登记表（CMD+EV）里必须有')
  assert.ok(
    (EV_TYPES as readonly string[]).includes('ev.host_info'),
    'EV_TYPES 里必须有它——registry.test.ts 那条"表与判别联合逐项相等"是**运行时**兜底，' +
      '而 registry.ts 里的 `_EvNamesMatchUnion` 是编译期兜底，两条都要在',
  )
  // 计数也要跟着走：describeCatalog 是排错与文档的入口，数字对不上就是在骗人。
  assert.equal(describeCatalog().events, EV_TYPES.length, 'describeCatalog().events 必须与事件表同长')
})

test('② 最小合法载荷过 schema；三个顶层键一个都不能少', () => {
  const parsed = evHostInfo.safeParse(valid())
  assert.ok(parsed.success, `最小合法载荷必须过：${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`)
  for (const key of ['host', 'limits', 'state'] as const) {
    const broken: Record<string, unknown> = { ...valid() }
    delete broken[key]
    assert.equal(
      evHostInfo.safeParse(broken).success,
      false,
      `缺 ${key} 必须被拒：要求报的是主机**此刻真正执行**的值，它没有"我不知道"这种状态——` +
        '设成可选只会给"漏填一个、手机退回猜"留一条路，而那正是本载荷要消灭的东西',
    )
  }
})

test('②b 多出来的键（含已删掉的 caps）会被剥掉，而不是被拒', () => {
  // 线上可能跑着一个更早的构建，它还在发 `caps`：那一帧必须照旧收下（zod 默认 strip），
  // 否则"主机多报一个字段"就变成"手机整帧丢弃"，表现是**功能凭空消失**。
  const parsed = evHostInfo.parse({ ...valid(), caps: ['drc.v1'], sessionId: 'ses_故意多塞的' })
  assert.ok(!('caps' in parsed), 'caps 已经不是这个载荷的一部分了')
  assert.ok(!('sessionId' in parsed), 'F11：能力面/限额是主机级的，按会话分装会被聊天页当过滤条件丢掉')
})

test('④ F11：这个载荷**不带** sessionId，多塞的那个会被剥掉（不是被拒）', () => {
  const withSession = evHostInfo.parse({ ...valid(), sessionId: 'ses_故意多塞的' })
  assert.ok(
    !('sessionId' in withSession),
    '限额是主机级的：按会话分装会把"这台主机能收多少"变成"这条通道能收多少"，' +
      '而聊天页会拿它当过滤条件、把整条载荷丢掉（F11 的经典形态）',
  )
})

test('⑤ 防休眠后端名的取值面与 ev.keep_awake_state 同源，`unsupported` 是如实上报', () => {
  for (const backend of ['caffeinate', 'systemd-inhibit', 'unsupported'] as const) {
    assert.ok(evHostInfo.safeParse({ ...valid(), state: { sleep: backend } }).success, `${backend} 必须合法`)
  }
  assert.equal(
    evHostInfo.safeParse({ ...valid(), state: { sleep: 'caffeinate ' } }).success,
    false,
    '带尾空格的名字必须被拒：它会被手机原样显示成"用了某个不认识的后端"',
  )
})

test('⑥ 限额的取值域：条数可以为 0（这一代不收），字节与字符数必须为正', () => {
  assert.ok(
    hostLimits.safeParse({ ...valid().limits, maxFileAttachments: 0 }).success,
    'maxFileAttachments 允许为 0 —— "这一代不收文件附件"是一种真实状态，不是错误',
  )
  for (const key of ['maxAttachmentBytes', 'maxTextChars'] as const) {
    assert.equal(
      hostLimits.safeParse({ ...valid().limits, [key]: 0 }).success,
      false,
      `${key}=0 必须被拒：0 字节/0 字符的上限不是"不收"，而是本端没法表达的一条约束`,
    )
  }
})

test('⑦ 构造器的产物形状必须与手写的合法载荷逐字段相同', () => {
  const frame = hostInfo({
    host: { platform: 'linux', arch: 'x64' },
    limits: valid().limits,
    state: { sleep: 'systemd-inhibit' },
  })
  assert.deepEqual(frame, valid2())
})

/** 上一句的期望值（把 host 换掉、其余同 `valid()`）。 */
function valid2(): EvHostInfo {
  return evHostInfo.parse({
    t: 'ev.host_info',
    host: { platform: 'linux', arch: 'x64' },
    limits: valid().limits,
    state: { sleep: 'systemd-inhibit' },
  })
}
