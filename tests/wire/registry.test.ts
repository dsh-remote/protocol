/**
 * registry — 注册表**不许与 zod 判别联合漂移**。
 *
 * ## 这条判据守的是哪一类故障
 *
 * 注册表存在的理由是替掉"人手抄一份帧名清单"（中继的 `KNOWN_FRAME_NAMES`）。
 * 但它自己也会漂：协议加了帧、注册表忘了加 → 那个帧被判成 `unknown_frame`，
 * 而对端明明在正确地发它；反过来注册表多了一个名字 → 该分支永远不可达。
 *
 * 两种都是**静默**的。所以这里不测"注册表里有这些名字"（那只是抄一遍自己），
 * 而测**注册表与 zod 联合逐项相等**——联合是形状的事实源，注册表是它的投影。
 *
 * 变异验证：
 * - 从 `ENDPOINT_FRAME_NAMES` 里删一个 → 「endpoint 表与联合逐项相等」红；
 * - 加一个不存在的名字 → 同一判据红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpointFrame, relayFrame } from '../../src/wire/frames.js'
import { cmdPayload, evPayload, parseCmdPayload, parseEvPayload } from '../../src/wire/payloads.js'
import {
  CMD_TYPES,
  ENDPOINT_FRAME_TYPES,
  EV_TYPES,
  FRAME_TYPES,
  RELAY_FRAME_TYPES,
  describeCatalog,
} from '../../src/wire/registry.js'

/** 判别联合自己的选项名——形状的事实源，不是人抄的。 */
const unionNames = (schema: { options?: Array<{ shape: { t: { value: string } } }> }): string[] =>
  (schema.options ?? []).map((option) => option.shape.t.value)

test('endpoint 表与 endpointFrame 判别联合逐项相等（漏一个、多一个都红）', () => {
  assert.deepEqual([...ENDPOINT_FRAME_TYPES].sort(), unionNames(endpointFrame).sort())
})

test('relay 表与 relayFrame 判别联合逐项相等：enc / enc-batch 两个方向都有', () => {
  // 这条曾经真的漏过：relay → endpoint 的 union 里含 enc / enc-batch（中继转发密文），
  // 而人抄的那张表只有 8 个控制帧名。合起来 10 个，少一个都是静默的。
  assert.deepEqual([...RELAY_FRAME_TYPES].sort(), unionNames(relayFrame).sort())
  // 14 = 原 13 + feedback-list（反馈面回包，2026-10-26）
  // 13 = 原 10 + pair-request（中继带给主机）+ pair-grant（中继转给手机）
  //      + resume-gap（P1-3 补帧回执，2026-10-22）
  assert.equal(RELAY_FRAME_TYPES.length, 14)
})

test('两个方向的两张表没有互相矛盾的名字（同一 t 在两边含义必须一致）', () => {
  const endpointNames: readonly string[] = ENDPOINT_FRAME_TYPES
  const overlap = RELAY_FRAME_TYPES.filter((name) => endpointNames.includes(name))
  // 允许的重叠：enc / enc-batch 是"中继转发给对端的载荷载体"，
  // pair-grant 是"主机发出、中继转交给手机"的同一条帧（2026-10-21 加）——
  // 三者都是**同义双向**，不是某个名字被挪用（F1）。任何别的重叠仍然要红。
  assert.deepEqual([...overlap].sort(), ['enc', 'enc-batch', 'pair-grant'])
})

test('载荷表与两个判别联合逐项相等；FRAME_TYPES 是两张表的并集且没有重复', () => {
  assert.deepEqual([...CMD_TYPES].sort(), unionNames(cmdPayload).sort())
  assert.deepEqual([...EV_TYPES].sort(), unionNames(evPayload).sort())
  // 命令表与事件表不许有交集：同一个 t 既是命令又是事件，分发时必然有一边不可达。
  const evNames: readonly string[] = EV_TYPES
  assert.deepEqual(
    CMD_TYPES.filter((t) => evNames.includes(t)),
    [],
  )
  // FRAME_TYPES 是并集而不是相加：enc / enc-batch / pair-grant 两边都有。
  // 计数翻转（20 → 23，B 口径）：反馈面新增三帧 —— 端点侧 `feedback` / `feedback-poll`
  // 与中继侧 `feedback-list`（2026-10-26）。计数是**派生事实**，跟帧面走。
  assert.equal(FRAME_TYPES.length, new Set(FRAME_TYPES).size)
  assert.equal(FRAME_TYPES.length, new Set([...ENDPOINT_FRAME_TYPES, ...RELAY_FRAME_TYPES]).size)
  assert.equal(FRAME_TYPES.length, 23)
})

test('describeCatalog 打印的是实测值，且与它数的东西一致', () => {
  const catalog = describeCatalog()
  assert.equal(catalog.endpointFrames, ENDPOINT_FRAME_TYPES.length)
  assert.equal(catalog.relayFrames, RELAY_FRAME_TYPES.length)
  assert.equal(catalog.frames, FRAME_TYPES.length)
  assert.equal(catalog.commands, CMD_TYPES.length)
  assert.equal(catalog.events, EV_TYPES.length)
  assert.equal(catalog.payloads, CMD_TYPES.length + EV_TYPES.length)
  // 抽两条真的能解析的载荷，确保这些名字不是"只在表里"的死字符串
  assert.ok(parseCmdPayload({ t: 'cmd.list_sessions', cmdId: 'c1' }))
  assert.ok(parseEvPayload({ t: 'ev.run_state', state: 'idle' }))
})
