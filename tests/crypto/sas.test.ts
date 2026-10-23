/**
 * 配对密钥交接的判据（2026-10-21）。
 *
 * 守的是三件事，每一件都对应一个真实失败模式：
 * 1. 两端算出**同一个**共享密钥与 6 位数字（参数顺序写反不会报错，只会永远对不上）；
 * 2. psk 能被包裹/解出，且**篡改任何一个字节都解不出**（解不出必须是 null，不是空数组）；
 * 3. **中继换公钥必须被数字比对发现** —— 这是整个方案能保住零知识的唯一理由。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSharedKey, newPairingKeyPair, sasCode, unwrapPsk, wrapPsk } from '../../src/crypto/sas.js'
import { fromBase64, toBase64 } from '../../src/crypto/bytes.js'

const psk = (fill = 9): Uint8Array => new Uint8Array(32).fill(fill)

test('两端算出同一个共享密钥与同一串 6 位数字', () => {
  const phone = newPairingKeyPair()
  const host = newPairingKeyPair()
  const fromPhone = deriveSharedKey(phone.secretKey, host.publicKey)
  const fromHost = deriveSharedKey(host.secretKey, phone.publicKey)
  assert.deepEqual([...fromPhone], [...fromHost], '共享密钥必须逐字节相同（参数顺序写反这里就红）')
  assert.equal(sasCode(fromPhone), sasCode(fromHost), '两端显示的确认码必须相同')
})

test('确认码恒为 6 位数字，前导零不丢', () => {
  for (let i = 0; i < 200; i += 1) {
    const a = newPairingKeyPair()
    const b = newPairingKeyPair()
    const code = sasCode(deriveSharedKey(a.secretKey, b.publicKey))
    assert.match(code, /^\d{6}$/, `确认码必须是 6 位数字，收到 ${code}`)
  }
})

test('psk 能包裹再解出，且解出的是原字节', () => {
  const phone = newPairingKeyPair()
  const host = newPairingKeyPair()
  const shared = deriveSharedKey(host.secretKey, phone.publicKey)
  const { nonce, wrappedPsk } = wrapPsk(shared, psk(0x5a))
  const opened = unwrapPsk(deriveSharedKey(phone.secretKey, host.publicKey), nonce, wrappedPsk)
  assert.ok(opened, '正确密钥必须解得开')
  assert.deepEqual([...opened], [...psk(0x5a)])
})

test('密文被改一个字节 ⇒ 解不出，且返回 null（不是空数组）', () => {
  const phone = newPairingKeyPair()
  const host = newPairingKeyPair()
  const shared = deriveSharedKey(host.secretKey, phone.publicKey)
  const { nonce, wrappedPsk } = wrapPsk(shared, psk())
  const bytes = fromBase64(wrappedPsk)
  bytes[0] = (bytes[0] ?? 0) ^ 0x01
  assert.equal(unwrapPsk(shared, nonce, toBase64(bytes)), null)
})

test('拿别人的密钥解 ⇒ null（错的共享密钥不许"好像成功了"）', () => {
  const phone = newPairingKeyPair()
  const host = newPairingKeyPair()
  const stranger = newPairingKeyPair()
  const { nonce, wrappedPsk } = wrapPsk(deriveSharedKey(host.secretKey, phone.publicKey), psk())
  assert.equal(unwrapPsk(deriveSharedKey(stranger.secretKey, host.publicKey), nonce, wrappedPsk), null)
})

test('反证：中继换掉 clientPub ⇒ 主机与手机算出的确认码不同', () => {
  const phone = newPairingKeyPair()
  const host = newPairingKeyPair()
  // 中继自己造一对钥匙，把 clientPub 换成自己的
  const relay = newPairingKeyPair()

  const phoneCode = sasCode(deriveSharedKey(phone.secretKey, host.publicKey))
  // 主机以为对端是 relay，于是用 relay 的公钥算
  const hostCode = sasCode(deriveSharedKey(host.secretKey, relay.publicKey))

  assert.notEqual(phoneCode, hostCode, '换公钥后两端数字必须不同 —— 否则中间人无从发现')
})
