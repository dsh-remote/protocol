/**
 * summary — M2「状态摘要」的协议面判据（REVIEW-offline-continuity §5.1）。
 *
 * 这是零知识边界上**唯一的明文业务面**：摘要不走 enc（中继要存、手机回头要读），
 * 所以**形状就是防线** —— 只许状态类字段（时刻/布尔/非负整数），
 * **一个自由文本都不许有**（§5.1 风险条：摘要粒度要克制，不写具体任务文本）。
 *
 * `strict()` 是执行点：多带一个键 ⇒ **整帧拒收**，不是静默剥掉 ——
 * 静默剥掉是"主机以为存上了、其实没有"（静默是这一族缺陷里最难查的），
 * 而拒收会回 bad_frame，让多带字段这件事**当场出声**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEndpointFrame, statusDigest, summaryFrame } from '../../src/wire/frames.js'
import { ENDPOINT_FRAME_TYPES, isKnownFrameType } from '../../src/wire/registry.js'
import { summary } from '../../src/wire/outbound.js'

const DIGEST = { at: 1_761_200_000_000, running: true, steps: 12, pending: 1 }

test('summary 帧形状：sessionId + 状态摘要，往返成立', () => {
  const frame = summary('c_1', DIGEST)
  assert.equal(frame.t, 'summary')
  const parsed = parseEndpointFrame(frame)
  assert.ok(parsed, '合法 summary 帧必须过解析')
  assert.equal(parsed.t, 'summary')
  if (parsed.t !== 'summary') return
  assert.equal(parsed.sessionId, 'c_1')
  assert.deepEqual(parsed.summary, DIGEST)
})

test('summary 是注册表里的已知端点帧（漏注册 ⇒ unknown_frame 静默丢摘要）', () => {
  assert.ok(ENDPOINT_FRAME_TYPES.includes('summary'), '注册表必须收录 summary')
  assert.ok(isKnownFrameType('summary'))
})

test('零知识边界：自由文本字段一律拒收（strict，不静默剥）', () => {
  for (const leak of [
    { title: '写周报' },
    { detail: '正在跑第 3 步' },
    { content: '用户输入原文' },
    { text: 'anything' },
    { task: 'fix login' },
  ]) {
    const bad = { t: 'summary', sessionId: 'c_1', summary: { ...DIGEST, ...leak } }
    assert.equal(parseEndpointFrame(bad), null, `摘要里混进 ${Object.keys(leak)[0]} 必须整帧拒收`)
    assert.equal(statusDigest.safeParse({ ...DIGEST, ...leak }).success, false, 'strict 是执行点')
  }
})

test('状态类字段的形状边界：缺 at/running 拒收，负数与小数拒收', () => {
  assert.equal(statusDigest.safeParse({ running: true }).success, false, 'at 必填')
  assert.equal(statusDigest.safeParse({ at: 1 }).success, false, 'running 必填')
  assert.equal(statusDigest.safeParse({ ...DIGEST, at: -1 }).success, false, 'at 不许负')
  assert.equal(statusDigest.safeParse({ ...DIGEST, steps: -2 }).success, false, 'steps 不许负')
  assert.equal(statusDigest.safeParse({ ...DIGEST, pending: 1.5 }).success, false, 'pending 必须是整数')
  assert.equal(parseEndpointFrame({ t: 'summary', sessionId: 'c_1', summary: { at: 1 } }), null)
})

test('可选字段可省（老/简主机只报三件套也不算坏帧）', () => {
  const minimal = { at: 5, running: false }
  const parsed = parseEndpointFrame({ t: 'summary', sessionId: 'c_1', summary: minimal })
  assert.ok(parsed, 'steps/pending 是可选的')
  if (parsed.t !== 'summary') return
  assert.deepEqual(parsed.summary, minimal)
})

test('反向判据：这是 strict 不是 strip（多带键必须 null，而不是"解析出少了键的对象"）', () => {
  const sneaky = { t: 'summary', sessionId: 'c_1', summary: { ...DIGEST, note: '顺手记一笔' } }
  const parsed = parseEndpointFrame(sneaky)
  // strip 会返回 {at, running, steps, pending}（悄悄丢掉 note）⇒ 这条判据必须能分出两种实现
  assert.equal(parsed, null, 'strict：整帧拒收；strip 的"悄悄丢字段"正是这里不许的')
  const schemaOnly = statusDigest.safeParse({ ...DIGEST, note: 'x' })
  assert.equal(schemaOnly.success, false)
})

test('构造器产出的帧就是 schema 认得的形状（自证往返，别各写一份）', () => {
  for (const d of [
    { at: 1, running: true },
    { at: 2, running: false, steps: 0 },
    { at: 3, running: true, steps: 9, pending: 0 },
  ]) {
    assert.ok(summaryFrame.safeParse(summary('c_x', d)).success, `构造器与 schema 对不上：${JSON.stringify(d)}`)
  }
})
