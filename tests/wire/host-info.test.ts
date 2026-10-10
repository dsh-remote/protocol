/**
 * `ev.host_info`（规范 §13.2，附录 D·GAP-5）的判据 —— B3 的协议面出口。
 *
 * ## 这个载荷为什么必须存在（否则 B3 无处落地）
 *
 * §10.7 的 **S6** 是一条硬义务：client 在对端**没有** `drc.payload.resume` 能力位时
 * MUST NOT 发 `cmd.session_history.since`，必须退回"重拉一页"。
 * "对端有没有这一位"这个事实只能由**主机自己在加密通道里**说出来——
 * 中继是结构性零知识的，让它回答"主机支持什么"等于把内容面的判断
 * 塞进一个只负责转发的角色，而它一旦答错（旧中继 strip 掉 `hello-ok.capabilities`、
 * 或者它缓存了一份过期的），手机就会拿一个陈旧的能力面去决定发不发 `since`——
 * 表现是**静默漏消息**，比"整段重拉"难查得多。
 *
 * ## 四条义务里，协议层能钉住哪几条
 *
 * - **L1**（`caps` 取自注册表）是对**生产端**的义务。协议层能钉的是"校验器不许
 *   把不认识的 id 拒掉"——那条正好是 L1 的反面：一旦校验器只放行注册表里的 id，
 *   一台更新过的主机会被**整帧丢弃**，而表现与"它没发"完全一样，
 *   §5.2 的加性演进就此失效。这条在下面第 ③ 条。
 * - **L2**（报的是此刻真正执行的值）只有宿主侧判据能钉，见
 *   `packages/plugin/tests/runtime.test.ts`（限额与 `cmd.send_prompt` 的拒绝面同源）。
 * - **L3**（client 不许用"字段缺失"推断"不支持"）只有两端各自的消费侧能钉，
 *   见 `e2e/mp-chat-blocks.test.mjs` 与 `packages/plugin/tests/*`。
 * - **L4**（（重）连上与能力变化时各发一次）同样在宿主侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evHostInfo, hostLimits } from '../../src/wire/payloads.js'
import type { EvHostInfo } from '../../src/wire/payloads.js'
import { capabilityList } from '../../src/wire/frames.js'
import { EV_TYPES, describeCatalog, isEvType, isKnownPayloadType } from '../../src/wire/registry.js'
import { hostInfo } from '../../src/wire/outbound.js'

/** 一份最小合法载荷。形状**从 schema 反推**，不照记忆手写。 */
const valid = (): EvHostInfo => ({
  t: 'ev.host_info',
  host: { platform: 'darwin', arch: 'arm64' },
  caps: ['drc.v1', 'drc.payload.resume'],
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

test('② 最小合法载荷过 schema；四个顶层键一个都不能少', () => {
  const parsed = evHostInfo.safeParse(valid())
  assert.ok(parsed.success, `最小合法载荷必须过：${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`)
  for (const key of ['host', 'caps', 'limits', 'state'] as const) {
    const broken: Record<string, unknown> = { ...valid() }
    delete broken[key]
    assert.equal(
      evHostInfo.safeParse(broken).success,
      false,
      `缺 ${key} 必须被拒：L2 要求报的是主机**此刻真正执行**的值，它没有"我不知道"这种状态——` +
        '设成可选只会给"漏填一个、手机退回猜"留一条路，而那正是本载荷要消灭的东西',
    )
  }
})

test('③ 不认识的 `caps` id 必须放行（加性演进），但超长数组要拒', () => {
  // L1 的反面：校验器一旦只放行注册表里的 id，一台更新过的主机会被整帧丢弃，
  // 而表现与"它没发"完全一样 —— §5.2 V1 的加性演进就此失效。
  assert.ok(
    evHostInfo.safeParse({ ...valid(), caps: ['drc.v1', 'drc.未来某个能力'] }).success,
    '不认识的 id 必须放行：拒掉它 = 把一台新主机降级成"从不发 host_info"',
  )
  // 但边界必须与 `hello.capabilities` 同一条（安全要求：未认证前就能收到的那条也用它）。
  const tooMany = Array.from({ length: 65 }, (_, i) => `drc.c${i}`)
  assert.equal(evHostInfo.safeParse({ ...valid(), caps: tooMany }).success, false, '65 个 id 必须被拒')
  assert.equal(
    evHostInfo.safeParse({ ...valid(), caps: ['x'.repeat(65)] }).success,
    false,
    '单个 id 超过 64 字符必须被拒',
  )
  // 与 frames.ts 用**同一条**校验器：两处各写一遍 `.max(64)` 的话，
  // 改一处不会有信号，症状是"hello 收得下、host_info 被拒"——能力面时有时无。
  assert.equal(
    capabilityList.safeParse(Array.from({ length: 64 }, (_, i) => `drc.c${i}`)).success,
    true,
    '上界是 64 而不是 63：与 hello.capabilities 逐字同界',
  )
})

test('④ F11：这个载荷**不带** sessionId，多塞的那个会被剥掉（不是被拒）', () => {
  const withSession = evHostInfo.parse({ ...valid(), sessionId: 'ses_故意多塞的' })
  assert.ok(
    !('sessionId' in withSession),
    '能力面是主机级的：按会话分装会把"这台主机支持什么"变成"这条通道支持什么"，' +
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

test('⑦ 构造器：caps 是**拷一份**，调用方后续改数组不许影响已造出的载荷', () => {
  const caps = ['drc.v1', 'drc.payload.resume'] as const
  const frame = hostInfo({
    host: { platform: 'linux', arch: 'x64' },
    caps,
    limits: valid().limits,
    state: { sleep: 'systemd-inhibit' },
  })
  assert.deepEqual(frame, valid2(), '构造器的产物形状必须与手写的合法载荷逐字段相同')
  assert.notEqual(frame.caps, caps, 'caps 必须是新数组：共享引用会让调用方之后的一次 push 悄悄改掉已发出的帧')
})

/** 上一句的期望值（把 host 换掉、其余同 `valid()`）。 */
function valid2(): EvHostInfo {
  return evHostInfo.parse({
    t: 'ev.host_info',
    host: { platform: 'linux', arch: 'x64' },
    caps: ['drc.v1', 'drc.payload.resume'],
    limits: valid().limits,
    state: { sleep: 'systemd-inhibit' },
  })
}
