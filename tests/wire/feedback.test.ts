/**
 * feedback — 反馈面的协议判据（2026-10-26）。
 *
 * ## 这一面为什么特殊
 *
 * 反馈是**明文**的，而且是中继唯一读得懂的自由文本（`summary` 那面只许状态类字段）。
 * 零知识边界在这里**开了一扇有名字的门**，所以形状与注册必须钉死：
 *
 *   · 帧名必须在注册表里 —— 漏注册 ⇒ 中继回 `unknown_frame` **静默丢弃**；
 *   · 能力位 `feedback.v1` 必须由中继声明 —— 小程序按声明开，没声明就不显示入口；
 *   · 条目（要落盘的形状）必须 **strict** —— 坏形状整条拒收，不静默剥键；
 *   · 错误码 `not_paired` 必须在册 —— 反馈只对配对成功的用户开放，
 *     而它**必须区别于 `unknown_session`**（后者会让客户端清配对要求重扫）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorCodes, feedbackItem, parseEndpointFrame, parseRelayFrame } from '../../src/wire/frames.js'
import {
  ENDPOINT_FRAME_TYPES,
  RELAY_CAPABILITIES,
  RELAY_FRAME_TYPES,
  isKnownFrameType,
} from '../../src/wire/registry.js'
import { feedbackList, feedbackPoll, feedbackSubmit, helloOkForClient } from '../../src/wire/outbound.js'

const ITEM = {
  id: 'fb_1',
  text: '配对页那个码总是扫不上',
  at: 1_761_200_000_000,
  status: 'open',
} as const

test('feedback 帧形状：id + text（contact 可选），往返成立', () => {
  const frame = feedbackSubmit('fb_1', '配对页那个码总是扫不上')
  assert.equal(frame.t, 'feedback')
  const parsed = parseEndpointFrame(frame)
  assert.ok(parsed, '合法的 feedback 帧必须过解析')
  assert.equal(parsed.t, 'feedback')
  if (parsed.t !== 'feedback') return
  assert.equal(parsed.id, 'fb_1')
  assert.equal(parsed.text, '配对页那个码总是扫不上')
  assert.equal(parsed.contact, undefined, '联系方式是可选的：不填就没有这个键')
})

test('feedback-poll / feedback-list 的形状', () => {
  const poll = parseEndpointFrame(feedbackPoll())
  assert.ok(poll && poll.t === 'feedback-poll', 'feedback-poll 必须过解析')

  const list = parseRelayFrame(feedbackList([ITEM]))
  assert.ok(list, 'feedback-list 必须过解析')
  assert.equal(list.t, 'feedback-list')
  if (list.t !== 'feedback-list') return
  assert.equal(list.items.length, 1)
  const first = list.items[0]
  assert.ok(first, '列表里至少有一条')
  assert.equal(first.text, ITEM.text)
  assert.equal(first.status, 'open')
})

test('注册表收录三帧（漏注册 ⇒ unknown_frame 静默丢，用户什么都看不到）', () => {
  assert.ok(ENDPOINT_FRAME_TYPES.includes('feedback'), '端点帧表必须收录 feedback')
  assert.ok(ENDPOINT_FRAME_TYPES.includes('feedback-poll'), '端点帧表必须收录 feedback-poll')
  assert.ok(RELAY_FRAME_TYPES.includes('feedback-list'), '中继帧表必须收录 feedback-list')
  assert.ok(isKnownFrameType('feedback'))
  assert.ok(isKnownFrameType('feedback-poll'))
  assert.ok(isKnownFrameType('feedback-list'))
})

test('能力位 feedback.v1：中继在 hello-ok 里声明它（按声明开）', () => {
  assert.ok(RELAY_CAPABILITIES.includes('feedback.v1'), '能力表必须含 feedback.v1')
  const helloOk = helloOkForClient('c-1')
  assert.ok(
    Array.isArray(helloOk.capabilities) && helloOk.capabilities.includes('feedback.v1'),
    '中继回给客户端的 hello-ok 必须带上 feedback.v1 —— 小程序靠它开这个入口',
  )
})

test('条目 strict：多一个键整条拒收（不是静默剥键）', () => {
  const withExtra = { ...ITEM, hostId: 'h-1' }
  const parsed = feedbackItem.safeParse(withExtra)
  assert.equal(parsed.success, false, '多带一个键必须被拒 —— 静默剥键会让人以为"存住了"')
  // 反过来：合法的条目过得去
  assert.equal(feedbackItem.safeParse(ITEM).success, true)
  assert.equal(feedbackItem.safeParse({ ...ITEM, reply: '收到，正在看', repliedAt: 1 }).success, true)
})

test('正文有上限：超过 2000 字拒收（反馈是明文落盘，不能无限长）', () => {
  const long = 'x'.repeat(2001)
  assert.equal(feedbackItem.safeParse({ ...ITEM, text: long }).success, false)
  assert.equal(feedbackItem.safeParse({ ...ITEM, text: 'x'.repeat(2000) }).success, true)
  assert.equal(parseEndpointFrame(feedbackSubmit('fb_2', long)), null, '超长的提交帧过不了解析')
})

test('not_paired 在错误码表里（反馈的资格闸用它）', () => {
  assert.ok(errorCodes.includes('not_paired'), '错误码表必须含 not_paired')
  assert.ok(!errorCodes.includes('unknown_session') === false, 'unknown_session 仍在册（那是另一条语义）')
})
