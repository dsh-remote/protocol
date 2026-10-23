/**
 * 三条新帧的形状判据（2026-10-21）。
 *
 * 重点不是"能解析"，而是**边界**：
 * - `pair-begin-client.clientPub` 可选（老客户端不带，必须照旧通过）；
 * - 带了就必须是 32 字节 base64（写错长度不能悄悄放行，否则主机拿它算密钥会抛）；
 * - `pair-grant` 三个字段都不许空（空密文解出来是 null，手机侧会以为配对失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpointFrame, pairClaimFrame, pairGrantFrame, pairRequestFrame, relayFrame } from '../../src/wire/frames.js'

const PUB = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' // 32 字节 base64
const PUB2 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='

test('老客户端（不带 clientPub）仍然通过', () => {
  const parsed = pairClaimFrame.safeParse({ t: 'pair-begin-client', pairingToken: '042915' })
  assert.equal(parsed.success, true)
})

test('带 clientPub 时必须是 32 字节 base64', () => {
  assert.equal(
    pairClaimFrame.safeParse({ t: 'pair-begin-client', pairingToken: '042915', clientPub: PUB }).success,
    true,
  )
  for (const bad of ['', 'short', 'A'.repeat(43), 'A'.repeat(44), `${'A'.repeat(42)}==`]) {
    assert.equal(
      pairClaimFrame.safeParse({ t: 'pair-begin-client', pairingToken: '042915', clientPub: bad }).success,
      false,
      `这条不合法的公钥必须被拒：${JSON.stringify(bad)}`,
    )
  }
})

test('pair-request：中继带给主机的认领请求', () => {
  const ok = { t: 'pair-request', pairingToken: '042915', clientPub: PUB, sessionId: 'c_abc' }
  assert.equal(pairRequestFrame.safeParse(ok).success, true)
  assert.equal(relayFrame.safeParse(ok).success, true)
  // 缺 clientPub：主机拿不到公钥算不出共享密钥，认领请求没有意义。
  assert.equal(
    pairRequestFrame.safeParse({ t: 'pair-request', pairingToken: '042915', sessionId: 'c_abc' }).success,
    false,
    '不带 clientPub 的认领请求没有意义，必须拒',
  )
  // 缺 sessionId：主机回的 pair-grant 无处可送（中继在 claim 时已消费掉 token，没有 token→会话 的映射）。
  assert.equal(
    pairRequestFrame.safeParse({ t: 'pair-request', pairingToken: '042915', clientPub: PUB }).success,
    false,
    '不带 sessionId 的认领请求会让 pair-grant 无处可送，必须拒',
  )
})

test('pair-grant：三个字段都不许空', () => {
  const ok = { t: 'pair-grant', sessionId: 'c_abc', hostPub: PUB2, nonce: 'n', wrappedPsk: 'w' }
  assert.equal(pairGrantFrame.safeParse(ok).success, true)
  for (const key of ['sessionId', 'hostPub', 'nonce', 'wrappedPsk'] as const) {
    assert.equal(pairGrantFrame.safeParse({ ...ok, [key]: '' }).success, false, `${key} 为空必须被拒`)
  }
})

test('两个方向都能解析 pair-grant（主机发出、中继转给手机）', () => {
  const frame = { t: 'pair-grant', sessionId: 'c_abc', hostPub: PUB2, nonce: 'n', wrappedPsk: 'w' }
  assert.equal(endpointFrame.safeParse(frame).success, true, '主机要能发出去')
  assert.equal(relayFrame.safeParse(frame).success, true, '中继要能转给手机')
})
