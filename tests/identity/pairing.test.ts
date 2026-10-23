/**
 * 配对码（3.2 起这是**唯一**的配对凭据形状）。
 *
 * 原来的配对 URI 用例（构造/解析/容错/对拍向量）随 `buildPairingUri` / `parsePairingUri`
 * 一起删掉了：屏幕上只有小程序码，码里只有这 6 位数字，没有第二个格式要兼容。
 * 小程序侧那份 `parsePairingQr` 仍在 `packages/client/core/codec.js`（客户端自己的历史包袱，
 * 与本案无关，别在这里为它保留判据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPairingToken, randomPairingToken } from '../../src/identity/pairing.js'

test('randomPairingToken 恒为 6 位数字（手输面靠它）', () => {
  for (let i = 0; i < 500; i += 1) assert.match(randomPairingToken(), /^\d{6}$/)
})

test('formatPairingToken：非有限值抛错，不许产出"000NaN"这种配不上的码', () => {
  assert.equal(formatPairingToken(0), '000000')
  assert.equal(formatPairingToken(7), '000007')
  assert.equal(formatPairingToken(999999.7), '999999')
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => formatPairingToken(bad), `配对码不该接受 ${String(bad)}`)
  }
})

test('随机源没有被截断：500 次里至少出现过 10 个不同的首位数字（模偏差/常量退化的反证）', () => {
  const heads = new Set<string>()
  for (let i = 0; i < 500; i += 1) heads.add(randomPairingToken().charAt(0))
  assert.ok(heads.size >= 10, `首位数字只出现了 ${heads.size} 种：${[...heads].join('')}`)
})
