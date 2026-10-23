/**
 * capabilities — M-C 能力协商的协议面判据（PLAN-v5 M-C / M4）。
 *
 * 模型（裁决出处 PLAN-v5 M-C）：**hello-ok 带 capabilities，新行为按声明开**。
 * 方向是**中继 → 端点**（下发）：中继在 hello-ok 里声明它支持哪些面，端点看见声明
 * 才启用新行为（比如主机才开始发 `summary`）。老端点收 hello-ok 多两个键：
 * 各家解析都是 strip ⇒ **零报错、零行为**（M-C 判据的"老端点零报错"那一半）。
 *
 * ⚠️ 与"能力位已删除"的关系（frames.test.ts 那条钉着的）：被删的是**端点→中继**
 * 的 `hello.capabilities`（端点自报、中继判放行）——那条纪律**原样保留**（hello
 * 多带仍被剥）。本片新增的是**反方向**的 `hello-ok.capabilities`（中继声明、
 * 端点决定开什么），两者不是一回事；frames.test 的标题已按本裁决收窄措辞。
 *
 * `summary`（M2 的下发载体）与声明同车：声明 `digest.v1` 的中继才会带它，
 * 端点**看见声明才消费**（"按声明开"的执行点）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { helloOkFrame, parseRelayFrame, statusDigest, supportsCapability } from '../../src/wire/frames.js'
import { helloOkForClient, helloOkForHost } from '../../src/wire/outbound.js'
import { RELAY_CAPABILITIES } from '../../src/wire/registry.js'
import { PROTOCOL_VERSION } from '../../src/wire/frames.js'

const DIGEST = { at: 1_761_200_000_000, running: true, steps: 12, pending: 1 }

test('hello-ok 的声明面与摘要面：round-trip 后原样在', () => {
  const frame = helloOkForClient('c_1', PROTOCOL_VERSION, { capabilities: ['digest.v1'], summary: DIGEST })
  const parsed = parseRelayFrame(frame)
  assert.ok(parsed, '带声明/摘要的 hello-ok 必须过解析')
  assert.equal(parsed.t, 'hello-ok')
  if (parsed.t !== 'hello-ok') return
  assert.deepEqual(parsed.capabilities, ['digest.v1'])
  assert.deepEqual(parsed.summary, DIGEST)
})

test('老形状照常过（back-compat）：没有这两个字段的 hello-ok 不是坏帧', () => {
  const old = helloOkForHost('h_1', PROTOCOL_VERSION)
  assert.ok(parseRelayFrame(old), '老构造器产出必须照常过')
  const parsed = parseRelayFrame({ t: 'hello-ok', role: 'host', hostId: 'h', protocol: PROTOCOL_VERSION })
  assert.ok(parsed)
  if (parsed.t !== 'hello-ok') return
  assert.equal(parsed.capabilities, undefined, '没声明 = 没有面（端点一律按"不支持"处理）')
  assert.equal(parsed.summary, undefined)
})

test('声明面有界：条数与单条长度都封顶（hello-ok 是不可信输入也要防放大）', () => {
  assert.equal(
    helloOkFrame.safeParse({
      t: 'hello-ok',
      role: 'client',
      clientId: 'c',
      protocol: PROTOCOL_VERSION,
      capabilities: Array.from({ length: 33 }, (_, i) => `cap.${i}`),
    }).success,
    false,
    '33 条声明必须拒',
  )
  assert.equal(
    helloOkFrame.safeParse({
      t: 'hello-ok',
      role: 'client',
      clientId: 'c',
      protocol: PROTOCOL_VERSION,
      capabilities: ['x'.repeat(65)],
    }).success,
    false,
    '65 字符的声明名必须拒',
  )
  assert.ok(
    helloOkFrame.safeParse({
      t: 'hello-ok',
      role: 'client',
      clientId: 'c',
      protocol: PROTOCOL_VERSION,
      capabilities: ['digest.v1'],
    }).success,
  )
})

test('supportsCapability：没声明=假、认得的=真、不认识的名字只忽略不报错', () => {
  assert.equal(supportsCapability(undefined, 'digest.v1'), false, '没声明一律按不支持')
  assert.equal(supportsCapability([], 'digest.v1'), false)
  assert.equal(supportsCapability(['digest.v1'], 'digest.v1'), true)
  // 未知 id（未来中继多声明了新面）：老端点只当没有，不许抛/不许拒帧。
  assert.equal(supportsCapability(['digest.v1', 'future.v9'], 'digest.v1'), true)
  assert.equal(supportsCapability(['future.v9'], 'digest.v1'), false)
})

test('声明载体里放的是摘要白名单形状（strict 照旧：自由文本进不了 summary）', () => {
  const bad = helloOkFrame.safeParse({
    t: 'hello-ok',
    role: 'client',
    clientId: 'c',
    protocol: PROTOCOL_VERSION,
    summary: { ...DIGEST, title: '写周报' },
  })
  assert.equal(bad.success, false, 'hello-ok 里的 summary 同样过 statusDigest 的 strict')
  assert.equal(statusDigest.safeParse({ ...DIGEST, title: 'x' }).success, false)
})

test('中继声明的常量表里有 digest.v1（漏了它 M2 下发就永远不开）', () => {
  assert.ok(Array.isArray(RELAY_CAPABILITIES))
  assert.ok(RELAY_CAPABILITIES.includes('digest.v1'), 'RELAY_CAPABILITIES 必须声明状态摘要面')
  // 构造器默认就把中继的声明带上（调用方不传 = 全量声明）。
  const def = helloOkForClient('c_2', PROTOCOL_VERSION)
  assert.deepEqual(def.capabilities, [...RELAY_CAPABILITIES])
})
