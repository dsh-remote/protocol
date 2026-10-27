/**
 * 订阅消息面（2026-10-27）的协议判据。
 *
 * ## 为什么要单独一个文件
 *
 * 这一面有**三处**特别容易出错，而它们出错的方式都是**静默**的：
 *
 * ① **它是明文的**（`notify-register` 带 code、`notify-approval` 带挂起时刻）
 *    —— 形状闸松了，坏数据就进了中继的内存表；
 * ② **`items` 有上下界**（1–10）—— 松了就是"一次打包 100 张卡"，
 *    而那会让**一条通知**把 100 张卡合并成一段没人看得懂的正文；
 * ③ **`hello-ok.notify` 与 `capabilities` 是两件事** ——
 *    能力位说"中继实现了这一面"，`notify` 说"用哪个模板"。
 *    只看其中一个就开开关，结局是"点了没反应"。
 *
 * ## 判据清单
 *
 *   1. `notify-register`：code 非空、有上界；`subscribed` 可选。
 *   2. `notify-approval`：items 1–10；每条 strict（坏形状整条拒收）。
 *   3. `hello-ok.notify`：strict；模板 id 非空且有上界。
 *   4. `notify.v1` 是**动态能力**：不在 `RELAY_CAPABILITIES` 里。
 *   5. 构造器产出的形状与 schema 一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  endpointFrame,
  helloOkFrame,
  notifyApprovalFrame,
  notifyConfig,
  notifyItem,
  notifyRegisterFrame,
} from '../../src/wire/frames.js'
import { notifyApproval, notifyRegister } from '../../src/wire/outbound.js'
import { CAPABILITY_NOTIFY, ENDPOINT_FRAME_TYPES, RELAY_CAPABILITIES } from '../../src/wire/registry.js'

const ITEM = {
  requestId: 'ap_1',
  sessionId: 'dsh-session-1',
  kind: 'approval',
  askedAt: '2026-10-27T08:30:00.000Z',
} as const

test('notify-register：code 是必填且有上界；subscribed 可选', () => {
  assert.equal(notifyRegisterFrame.parse({ t: 'notify-register', code: 'abc' }).code, 'abc')
  assert.equal(notifyRegisterFrame.parse({ t: 'notify-register', code: 'abc', subscribed: true }).subscribed, true)
  // 空 code 不许（它会被送去换 openid，空的换不到）
  assert.equal(notifyRegisterFrame.safeParse({ t: 'notify-register', code: '' }).success, false)
  // 超长 code 不许（那是别的东西塞进来的）
  assert.equal(notifyRegisterFrame.safeParse({ t: 'notify-register', code: 'x'.repeat(257) }).success, false)
  // 帧名不认识
  assert.equal(notifyRegisterFrame.safeParse({ t: 'notify-registerx', code: 'abc' }).success, false)
})

test('notify-approval：items 1–10，每条 strict', () => {
  assert.equal(
    notifyApprovalFrame.parse({ t: 'notify-approval', conversationId: 'c_1', items: [ITEM] }).items.length,
    1,
  )
  // 空数组：主机没有待办就不该发这一帧
  assert.equal(notifyApprovalFrame.safeParse({ t: 'notify-approval', conversationId: 'c_1', items: [] }).success, false)
  // 超过 10 条：一次打包太多，落地页会变成一张看不懂的清单
  const many = Array.from({ length: 11 }, (_, i) => ({ ...ITEM, requestId: `ap_${i}` }))
  assert.equal(
    notifyApprovalFrame.safeParse({ t: 'notify-approval', conversationId: 'c_1', items: many }).success,
    false,
  )
  // kind 只允许两种
  assert.equal(notifyItem.safeParse({ ...ITEM, kind: 'other' }).success, false)
  // strict：多一个键就整条拒收（不静默剥键）
  assert.equal(notifyItem.safeParse({ ...ITEM, extra: 'x' }).success, false)
})

test('hello-ok.notify：strict；模板 id 非空且有上界', () => {
  assert.equal(
    helloOkFrame.parse({ t: 'hello-ok', role: 'client', protocol: 1, notify: { templateId: 'T1' } }).notify?.templateId,
    'T1',
  )
  assert.equal(
    helloOkFrame.safeParse({ t: 'hello-ok', role: 'client', protocol: 1, notify: { templateId: '' } }).success,
    false,
  )
  assert.equal(
    helloOkFrame.safeParse({ t: 'hello-ok', role: 'client', protocol: 1, notify: { templateId: 'T', extra: 1 } })
      .success,
    false,
  )
  // 没有这个字段的老中继：hello-ok 照样合法（端点据此不显示开关）
  assert.equal(helloOkFrame.safeParse({ t: 'hello-ok', role: 'client', protocol: 1 }).success, true)
})

test('notify.v1 是动态能力：不在 RELAY_CAPABILITIES 里', () => {
  // ⚠️ 它**故意不在**那张恒定表里：通知面要 appid+secret+模板 三样都配齐
  // 才启用 ⇒ 声明了却发不出去比不声明更坏（用户看到开关、点了没反应）。
  assert.ok(!(RELAY_CAPABILITIES as readonly string[]).includes(CAPABILITY_NOTIFY), 'notify.v1 不许进恒定能力表')
  assert.equal(CAPABILITY_NOTIFY, 'notify.v1')
  // 两个新帧名要在端点帧表里（少一个就是"帧被判成 unknown_frame"）
  assert.ok(ENDPOINT_FRAME_TYPES.includes('notify-register'))
  assert.ok(ENDPOINT_FRAME_TYPES.includes('notify-approval'))
})

test('两个新帧都在 endpointFrame 判别联合里（不认得 ⇒ 静默拒收）', () => {
  assert.equal(endpointFrame.safeParse({ t: 'notify-register', code: 'abc' }).success, true)
  assert.equal(endpointFrame.safeParse({ t: 'notify-approval', conversationId: 'c_1', items: [ITEM] }).success, true)
})

test('构造器：notifyRegister / notifyApproval 产出的形状与 schema 一致', () => {
  assert.deepEqual(notifyRegister('abc'), { t: 'notify-register', code: 'abc' })
  assert.deepEqual(notifyRegister('abc', true), { t: 'notify-register', code: 'abc', subscribed: true })
  const frame = notifyApproval('c_1', [ITEM])
  assert.equal(frame.t, 'notify-approval')
  assert.equal(frame.conversationId, 'c_1')
  assert.equal(frame.items?.length, 1)
  assert.equal(notifyApprovalFrame.safeParse(frame).success, true)
  // 构造器不许造出 schema 会拒的帧（空 items）
  assert.equal(notifyApprovalFrame.safeParse(notifyApproval('c_1', [])).success, false)
})
