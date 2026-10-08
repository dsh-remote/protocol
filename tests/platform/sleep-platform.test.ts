/**
 * sleep-platform 的判据 —— A7 的出口。
 *
 * ## A7 要证明什么
 *
 * V3-PLAN §8.4 的结论是「**先做如实报 unsupported，不假装**」。这条纪律的
 * 关键不在于"win32 上没有防休眠"这个事实，而在于**它必须被说出来**：
 *
 * - `detectBackend('win32')` 必须返回 `'unsupported'`，而不是 `'caffeinate'`
 *   之类——后者会让插件去 `spawn` 一条不存在的命令，**静默失败**（exit code 非 0
 *   但没人看），于是"防休眠开着"这个假象一直持续到机器真的睡着。
 * - `buildSleepCommand` 必须返回 `null`（**不构造命令**），而不是构造一条
 *   跑不出来的——调用方 `if (!cmd) 上报 unsupported` 这条路必须真的走得到。
 *
 * ## 为什么这值得一条判据
 *
 * 因为"加一个 Windows 后端"这件事在将来某天会诱惑所有人（V3-PLAN §8.4 记着
 * 为什么当时不做：要引入**本项目至今第一个原生依赖**，而收益只是一个可选功能）。
 * 有了这条判据，那天的改动必须**先更新这里**，而不是顺手把 `unsupported` 删掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSleepCommand, detectBackend, isSleepSupported } from '../../src/platform/sleep.js'

test('三个平台各自如实上报：darwin/linux 有后端，win32 明说 unsupported', () => {
  assert.equal(detectBackend('darwin'), 'caffeinate')
  assert.equal(detectBackend('linux'), 'systemd-inhibit')
  // ⚠️ 这条是 A7 的核心断言：不是"暂时没实现"，而是**明确的上报**。
  assert.equal(detectBackend('win32'), 'unsupported', 'win32 必须明说 unsupported：假装有后端会让插件去跑一条不存在的命令')
  assert.equal(detectBackend('freebsd'), 'unsupported', '未知平台同样如实上报')
  assert.equal(detectBackend(''), 'unsupported', '空串（探测失败）也是 unsupported，不是抛异常也不是猜一个')
})

test('isSleepSupported 与 detectBackend 同源（不许两处各写一套平台名单）', () => {
  for (const platform of ['darwin', 'linux', 'win32', 'aix', 'sunos']) {
    assert.equal(
      isSleepSupported(platform),
      detectBackend(platform) !== 'unsupported',
      `${platform}：两个函数的结论必须一致——它们是两处各写一遍平台名单时的经典分叉`,
    )
  }
})

test('buildSleepCommand 在不支持的平台返回 null（让调用方走上报那条路）', () => {
  // ⚠️ 返回 null 而不是一条跑不出来的命令：调用方（sleep-posix.ts）拿到 null
  // 才会上报 `ev.keep_awake_state{reason}`；拿到命令则会去 spawn，失败被吞。
  assert.equal(buildSleepCommand('win32', 1234), null, 'win32 上不许构造命令')
  assert.equal(buildSleepCommand('aix', 1234), null, '未知平台同上')
  // 对照：支持的平台确实构造得出命令
  assert.ok(buildSleepCommand('darwin', 1234), 'darwin 上要构造得出来')
  assert.ok(buildSleepCommand('linux', 1234), 'linux 上要构造得出来')
})

test('pid 非法时**抛**而不是静默返回 null（两种失败要分得开）', () => {
  // 不支持的平台 → null（"这台机器做不到"）
  // pid 不合法 → 抛（"调用方传错了"）
  // 混成一种的话，调用方分不清"平台不支持"与"自己写错了"，而处置完全不同。
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => buildSleepCommand('darwin', bad), /宿主 pid|必须是正整数/, `pid=${bad} 应当抛`)
  }
})

test('反向判据：detectBackend 若对 win32 返回 caffeinate，上面第一条立刻红', () => {
  // 证明这条在测「如实上报」而不是碰巧全绿
  const fake = (platform: string) => (platform === 'linux' ? 'systemd-inhibit' : 'caffeinate')
  assert.equal(fake('win32'), 'caffeinate', '假装有后端时返回值不同 ⇒ 判据抓得住')
  assert.notEqual(detectBackend('win32'), fake('win32'), '真实实现与之不同 ⇒ 判据确实在测它')
})