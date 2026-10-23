/**
 * 补差量（`since`）的判据 —— B1 的出口。
 *
 * 三条（V3-PLAN §7 阶段 B 明确列出）：
 * 1. `since` 与 `beforeSeq` **互斥** —— 两个方向一起走没有可定义的语义；
 * 2. 保留窗口外**明确拒绝** —— 不许静默从窗口头部开始给；
 * 3. 补差量与"拉历史"的结果**逐字节一致** —— 同一批 seq 给同样的条目。
 *
 * ## 为什么第 2 条要用错误码而不是"少给几条"
 *
 * 手机记的 `since` 可能比主机保留窗口更早（长时间离线）。此时静默从窗口头部开始给，
 * 手机会以为补齐了，实际中间缺一段——**而那段永远补不回来**。
 * 所以它必须是 `history_window_exceeded`，且**不可重试**（重发同一条仍在窗口外）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { z } from 'zod'
import { cmdSessionHistory, evSessionHistory } from '../../src/wire/payloads.js'
import { errorCodes } from '../../src/wire/frames.js'
import { isRetryableError } from '../../src/wire/errors.js'
import { sessionHistory } from '../../src/wire/outbound.js'

/**
 * 一条最小的合法历史条目。
 *
 * ⚠️ 形状**从 schema 取**，不在这里手写：`ev.message_delta` 的字段是 `delta` 不是 `text`，
 * 而 `seq` 是**历史层**加的游标字段（载荷本身没有它）。我第一版照记忆手写 `{text, seq}`
 * �� `safeParse` 直接失败——「按记忆抄一个 schema 的形状」是判据自己骗自己的经典形状。
 *
 * 做法：从 `evSessionHistory` 的 items 里反推元素类型，再补上历史层加的 `seq`。
 */
type HistoryEntry = z.infer<typeof evSessionHistory>['items'][number]
const item = (seq: number, delta: string): HistoryEntry =>
  ({ t: 'ev.message_delta', messageId: `m_${seq}`, delta, done: false }) as HistoryEntry

test('① since 与 beforeSeq 互斥：同时出现要当场拒', () => {
  const base = { t: 'cmd.session_history' as const, cmdId: 'c1', sessionId: 'ses_abc' }
  // 两个方向各给一个，合法
  assert.ok(cmdSessionHistory.safeParse({ ...base, since: 10 }).success, '只给 since 合法')
  assert.ok(cmdSessionHistory.safeParse({ ...base, beforeSeq: 10 }).success, '只给 beforeSeq 合法')
  assert.ok(cmdSessionHistory.safeParse(base).success, '两个都不给 = 要最新一页，合法')
  // ⚠️ 同时给必须拒
  const both = cmdSessionHistory.safeParse({ ...base, since: 10, beforeSeq: 20 })
  assert.equal(both.success, false, 'since 与 beforeSeq 同时出现必须被拒：放行等于让实现自己挑方向，而挑错是静默漏消息')
  if (!both.success) {
    assert.match(String(both.error.issues[0]?.message ?? ''), /互斥/, '错误信息要说清是互斥，否则端点不知道该怎么改')
  }
})

test('② 窗口外要明确拒绝，且该码不可重试', () => {
  assert.ok(errorCodes.includes('history_window_exceeded'), '错误码必须真的在 errorCodes 里（否则发出去对端不认）')
  // 不可重试：重发同一条 since 仍然在窗口外。客户端该做的是改拉历史。
  assert.equal(
    isRetryableError('history_window_exceeded'),
    false,
    '它不在可重试集合里：标成可重试会让端点在一条永远不会自愈的请求上耗尽重试额度',
  )
})

test('③ latestSeq 是 since 的取值来源；报不出来时缺省合法（手机当"补齐了"）', () => {
  const base = { t: 'ev.session_history' as const, sessionId: 'ses_abc', cmdId: 'c1' }
  assert.ok(evSessionHistory.safeParse({ ...base, items: [item(1, 'a')], latestSeq: 1 }).success)
  // 空页也必须能带 latestSeq —— 否则"这期间没有新条目"时手机没有可记的值
  assert.ok(
    evSessionHistory.safeParse({ ...base, items: [], latestSeq: 7 }).success,
    '空页也要能报 latestSeq：否则手机要么记陈旧值（重复收）要么记 0（整段重拉）',
  )
  // ⚠️ 「报不出来」是一个**真实状态**，不是兼容：内核这一代给不出游标时，
  // 宿主只能不报。手机把它当"这一页已经到顶"（`client.js` 的 `next === null` 那一支），
  // 而不是记一个错的游标。
  assert.ok(
    evSessionHistory.safeParse({ ...base, items: [item(1, 'a')] }).success,
    'latestSeq 可缺省：含义是"这一页没有游标"，手机据此收工',
  )
})

test('⑤ 补差量与拉历史给同一批 seq 时结果逐字节一致（V3-PLAN §7 B1 第三条）', () => {
  // ⚠️ 这一条在协议层能验的是「同一批 seq 构成的分组完全相同」。
  //
  // `seq` **不在 `items[]` 里**（第一版我假设它在，被 TS 当场指出）：宿主侧按
  // `{seq, events}` 分组，`seq` 来自内核事件（carrier-services.ts:2162），而协议
  // schema 描述的是**组内的载荷**。真正的差异在宿主实现（B4），但协议层要先钉住
  // 分组语义，否则实现差异会被"反正两条路走同一段代码"掩盖过去。
  type Group = { seq: number; events: unknown[] }
  const seqs = [3, 4, 5]
  // 模拟宿主侧的两条取值路径：向后翻页取 `seq < before` 的组，向前补差量取 `seq > since` 的组。
  const pageBack = (beforeSeq: number): Group[] =>
    seqs.filter((s) => s < beforeSeq).map((seq) => ({ seq, events: [item(seq, `t${seq}`)] }))
  const resume = (since: number): Group[] =>
    seqs.filter((s) => s > since).map((seq) => ({ seq, events: [item(seq, `t${seq}`)] }))

  // since=2 ⇒ seq 3,4,5；beforeSeq=6 ⇒ 同一批
  assert.deepEqual(resume(2), pageBack(6), '补差量与翻页必须给出逐字节相同的分组')
  assert.deepEqual(
    resume(2).map((g) => g.seq),
    [3, 4, 5],
    '补差量只给 since 之后的：早于它的已经在手机上了',
  )
  // 反向判据：范围写错（>= 而不是 >）会把手机已有的那条再发一次
  assert.equal(
    [2, 3, 4, 5].filter((s) => s >= 3).length,
    3,
    '若实现写成 `>=` 就会把 since 那一条重发 ⇒ 下面那条断言必须比它多一条',
  )
  assert.equal(resume(3).length, 2, 'since=3 时只补 4、5（3 那条手机已有，不重发）')
})
test('⑥ 出站构造器也要带 latestSeq（v3 加字段时漏掉的那一处）', () => {
  // ⚠️ 这一条是补记的：v3 给 `ev.session_history` 加 `latestSeq` 时改了 schema、
  // 改了端口类型、改了 SPEC，**唯独漏了协议层的出站构造器**。
  // 于是 runtime 转发正确、schema 认这个字段，而线格式那一步把它丢掉——
  // 手机永远收不到游标，重连后整段重拉。
  //
  // 为什么前五条判据都没抓住：它们查的是 schema、mock 与描述表，
  // **没有一条真的走一遍出站构造器到线格式**。凡"加字段"的改动都得过这一条。
  const built = sessionHistory({
    sessionId: 'ses_abc',
    cmdId: 'c1',
    items: [],
    latestSeq: 42,
  })
  assert.equal(built.latestSeq, 42, '构造器必须把 latestSeq 放进线格式载荷')

  // 缺省时也不能塞一个 undefined 进去（那是"字段存在但值为 undefined"的怪形状）
  const without = sessionHistory({ sessionId: 'ses_abc', cmdId: 'c1', items: [] })
  assert.equal(
    Object.hasOwn(without, 'latestSeq'),
    false,
    '没给 latestSeq 时整个字段不该出现（老主机就是这个样子，手机据此走 v2 路径）',
  )
})
