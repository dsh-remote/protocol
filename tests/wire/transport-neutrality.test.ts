/**
 * D5 —— 协议中立性（V3-PLAN §7 阶段 D5、§9.2、§13「阶段 B 新增闸门」里的
 * "协议中立性（无 WS 专有概念）"）。
 *
 * ## 它守的是什么
 *
 * §9.2 的决定是「**可选传输面先不实现，只先验证协议中立**」。这句话要能兑现，
 * 前提是「换一个传输面不需要改协议层」——而这件事**现在**是事实（协议层确实
 * 没有一个 WS 专有概念），问题是**没有东西拦它退化**：下一个人为了排错方便，
 * 在握手里塞一个 `Sec-WebSocket-Key`，或者让某个载荷隐含依赖"连接是长连接"，
 * 中立性就没了，而**没有任何判据会红**。D5 要的就是这条 grep。
 *
 * ## 判据的形状：不是"全禁"，而是"每处都要登记 + 计数精确"
 *
 * 全禁既做不到也不该做（下面 `ALLOWED` 里那两处就是例子——其中一处是真耦合）。
 * 所以判据是两个方向：
 *
 * - 扫出来的每一处**必须**在 `ALLOWED` 里登记，并写明它为什么不算破坏中立；
 * - 登记的**计数必须逐字相等**——多一处（新泄漏）红，少一处（修好了却忘了删
 *   登记）也红。**后者尤其重要**：留着一条已经不成立的登记，这条判据就从
 *   "例外清单"退化成"允许清单"，而那正是本项目反复栽的那种漂移
 *   （`plan-progress.test.mjs` 里那条"留着一个已完成的步会让判据绿得没有意义"
 *   是同一个道理）。
 *
 * ## ⚠️ 为什么注释也算
 *
 * 扫的是**原始文本**，注释里的 `wss://` / `WebSocket` 一样计入。理由：注释是下
 * 一个人抄代码的地方——"中继地址必须以 `wss://` 开头"这句话既在描述现状，
 * 也是别人照着写新校验的依据。它变了，说明中立性也变了。
 *
 * ## 刻意**不**禁的几个词（写下来，免得下次有人顺手加上又被劝退）
 *
 * - `ping` / `pong` —— 那是**我们自己的**中继帧名（`RELAY_FRAME_NAMES` 里有），
 *   与 WS 控制帧只是同名；生产路径根本不用它（保活在 WS 层，见 `outbound.ts`）。
 * - `frame` —— 指我们自己那条"一条加密载荷"，与 WS 分帧无关。
 * - `socket` —— 只在注释里当"连接"的俗称出现（`payloads.ts` / `frames.ts` 各一处）。
 *   它不是 API 名；禁了只会逼人把注释改成更难懂的词，那是净损失。
 * - `close` / `error` / `1009` —— 通用词或散文里的引用，禁了必然误伤
 *   （`payloads.ts` 那条"socket 1009 断开"就是在解释体积上限的后果）。
 *
 * ## ⚠️ 这条判据用了 `node:fs`（红线 §15.5-2 说 protocol **包**不许有 I/O）
 *
 * 红线针对的是 `src/` —— 它保证"每条冻结契约都能脱离环境被测"。本文件在
 * `tests/`，不进产物（`main` 是 `dist/src/index.js`），也不被 `src` 引用。
 * 它读的是**源码文本**，因为中立性是"源码里有没有某个概念"这种事实，
 * 只能靠读源码来判定，编译后的 JS 回答不了（注释在编译期就没了）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 传输专有概念清单 ─────────────────────────────────────────────────────
//
// 每一条都是"只在某一种传输上才成立"的东西。⚠️ 加一条进来很容易（grep 而已），
// 所以每条都要写 `why`：没有 why 的下一次重构里会被当成冗余删掉。
type Concept = { id: string; re: RegExp; why: string }

const CONCEPTS: Concept[] = [
  {
    id: 'websocket-api',
    re: /\bWebSocket\b/,
    why: '浏览器/Node 的 WebSocket 对象名。它出现在协议层 ⇒ 协议层已经假定底下是 WS',
  },
  {
    id: 'ws-scheme',
    // ⚠️ 两个坑，都是我第一版踩到的（2026-10-08）：
    //   ① 真正的那处代码把 scheme 写成**正则字面量**（`/^wss?:\/\//.test(server)`），
    //      文本是 `wss?:\/\/` —— 斜杠是转义的，`?` 是字面字符。只写 `/wss?:\/\//`
    //      会**只数到两条注释而漏掉唯一的真代码**，判据还绿着。
    //   ② 所以这里既容忍转义斜杠，也容忍那个字面 `?`。
    re: /wss?\??:(\\\/|\/){2}/,
    why: 'WS 的地址 scheme。协议层若校验/生成它 ⇒ 换传输要先改协议',
  },
  {
    id: 'ws-package',
    re: /\bfrom\s+['"]ws['"]|require\(\s*['"]ws['"]\s*\)/,
    why: '`ws` 这个 npm 包是 WS 的实现；协议层不许依赖任何传输实现',
  },
  {
    id: 'ws-header',
    re: /Sec-WebSocket/i,
    why: 'WS 的握手头。它属于 HTTP Upgrade 那一步，不属于帧与载荷',
  },
  {
    id: 'ws-ready-state',
    re: /\breadyState\b/,
    why: 'WS 连接的状态机（CONNECTING/OPEN/…）。协议层不该知道连接处于哪个状态',
  },
  {
    id: 'ws-subprotocol',
    re: /\bsub-?protocol\b/i,
    why: 'WS 的子协议协商。协议版本由 `hello` 的 `v` 与能力位表达，不靠子协议',
  },
  {
    id: 'node-transport',
    re: /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram)['"]/,
    why: 'Node 的传输模块。协议层不许有 I/O，更不许有具体传输',
  },
  {
    id: 'sse',
    re: /\bEventSource\b|text\/event-stream/,
    why: 'SSE 专有。禁它是为了防"换第二传输面时挑了 SSE 却把它写进协议"——中立是对**所有**传输，不只是对 WS',
  },
  {
    id: 'xhr',
    re: /\bXMLHttpRequest\b/,
    why: '同上：它是另一种传输的专有 API',
  },
]

// ── 登记：目前允许存在的那几处 ───────────────────────────────────────────
//
// ⚠️ `count` 是**当前实测**的处数，改代码就必须改它（这是刻意的摩擦）。
// ⚠️ 这里的 `why` 不是"解释为什么可以"，而是"说清它到底是什么"——
//    其中 `ws-scheme` 那条是**真的耦合**，本文件没有替它开脱。
type Registration = { concept: string; file: string; count: number; why: string; todo?: string }

const ALLOWED: Registration[] = [
  {
    concept: 'ws-scheme',
    file: 'src/identity/pairing.ts',
    count: 3,
    why:
      '配对 URI 的 `s=` 是"主机让手机连哪儿"，它**本身就是一个传输地址**，' +
      '所以这里出现 `wss://` 是诚实的，不是泄漏。' +
      '真正属于"传输策略"的是 `parsePairingUri` 里那条 `/^wss?:\\/\\//` 校验' +
      '（3 处里 1 处是代码、2 处是注释）：它把"哪些 scheme 合法"钉在了协议层，' +
      '而这件事本该由传输面回答——换一个传输面时，**这是第一个要改的地方**。\n' +
      '    ⚠️ **这是目前唯一一处代码级耦合，本文件没有替它开脱。**\n' +
      '    没顺手改掉的理由：它是冻结契约 B7/B8；改它要同步小程序侧 `parsePairingQr` ' +
      '与 `e2e/protocol.test.mjs` 的三十多组对拍向量，还要重跑 golden vectors —— ' +
      '那是需要拍板的改动，不是"补欠账"时该顺手做的。',
    todo: 'docs/V3-PLAN.md §9.2',
  },
  {
    concept: 'websocket-api',
    file: 'src/identity/pairing.ts',
    count: 1,
    why:
      '注释里那句"`https://` 连不上 WebSocket"是在解释上面那条 scheme 校验为什么存在 —— ' +
      '它与 `ws-scheme` 是同一件事的两面。把它单独登记，是为了让它**可见**：' +
      '哪天那条校验被拿掉，这句话必须一起删，而那时这里的 `count` 会先红。',
    todo: 'docs/V3-PLAN.md §9.2',
  },
]

// ── 扫描 ─────────────────────────────────────────────────────────────────

type SourceFile = { file: string; text: string }
type Hit = { file: string; line: number; concept: string; text: string }

/**
 * `packages/protocol/src` 的源码文件（`file` 是相对包根的路径，用 `/`）。
 *
 * ⚠️ 用"往上找 `src/wire/frames.ts`"定位包根，不写死 `../../../src`：
 * 计划 §15.3 第 4 条点名过"靠路径而不是靠包名"的引用会悄悄失效。
 */
function srcFiles(): SourceFile[] {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  let root = ''
  for (;;) {
    if (existsSync(path.join(dir, 'src', 'wire', 'frames.ts'))) {
      root = dir
      break
    }
    const up = path.dirname(dir)
    if (up === dir) throw new Error('找不到 protocol 的包根（src/wire/frames.ts 不在任何祖先目录里）')
    dir = up
  }
  const out: SourceFile[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(root, rel))) {
      const child = `${rel}/${name}`
      const full = path.join(root, child)
      if (statSync(full).isDirectory()) walk(child)
      else if (/\.tsx?$/.test(name)) out.push({ file: child.slice(1), text: readFileSync(full, 'utf8') })
    }
  }
  walk('/src')
  out.sort((a, b) => a.file.localeCompare(b.file))
  return out
}

function scan(files: SourceFile[]): Hit[] {
  const hits: Hit[] = []
  for (const f of files) {
    const lines = f.text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      for (const c of CONCEPTS) {
        // ⚠️ 每条概念每行只记一次：同一行里 `wss://` 出现三次也只算一处，
        // 否则"把注释换行"就能改数字，而那不是我们要盯的变化。
        if (c.re.test(line)) hits.push({ file: f.file, line: i + 1, concept: c.id, text: line.trim().slice(0, 120) })
      }
    }
  }
  return hits
}

type Verdict = { unregistered: string[]; countMismatch: string[]; expired: string[] }

/** 三个方向的问题都从同一段代码里出来——反向判据测的是**同一条路径**，不是抄一份。 */
function verdict(files: SourceFile[], allowed: Registration[] = ALLOWED): Verdict {
  const hits = scan(files)
  const key = (concept: string, file: string) => `${concept} @ ${file}`

  const byKey = new Map<string, Hit[]>()
  for (const h of hits) {
    const k = key(h.concept, h.file)
    const list = byKey.get(k) ?? []
    list.push(h)
    byKey.set(k, list)
  }

  const unregistered: string[] = []
  const countMismatch: string[] = []
  for (const [k, list] of byKey) {
    const first = list[0]
    if (!first) continue
    const reg = allowed.find((a) => a.concept === first.concept && a.file === first.file)
    if (!reg) {
      unregistered.push(
        `${k}：${list.length} 处未登记 —— 这是新的传输耦合。` +
          `\n      第一处：${first.file}:${first.line} ${first.text}` +
          `\n      要么把它从协议层挪走，要么在 ALLOWED 里写清它为什么不算破坏中立`,
      )
      continue
    }
    if (reg.count !== list.length) {
      countMismatch.push(
        `${k}：登记 ${reg.count} 处，实测 ${list.length} 处 —— 数字对不上说明有人改了协议层而没改这条登记`,
      )
    }
  }

  const expired: string[] = []
  for (const reg of allowed) {
    if (!byKey.has(key(reg.concept, reg.file))) {
      expired.push(
        `${key(reg.concept, reg.file)}：代码里已经没有这个概念了 —— 这条登记过期，删掉它。` +
          `\n      （留着已不成立的登记，这条判据就从"例外清单"变成"允许清单"）`,
      )
    }
  }
  return { unregistered, countMismatch, expired }
}

// ── 判据 ─────────────────────────────────────────────────────────────────

test('D5 协议中立性：传输专有概念只出现在登记过的那几处，且计数逐字相等', () => {
  const files = srcFiles()
  assert.ok(files.length >= 10, `只扫到 ${files.length} 个源码文件 —— 定位包根的那条路可能失效了`)
  const v = verdict(files)
  const problems = [...v.unregistered, ...v.countMismatch, ...v.expired]
  assert.deepEqual(
    problems,
    [],
    `\n协议层出现了未登记/计数不符/已过期的传输专有概念：\n  ${problems.join('\n  ')}\n\n` +
      '改代码 ⇒ 改 `ALLOWED` 的 `count`；修好了 ⇒ **删掉**那条登记（留着它，这条判据就没意义了）。\n',
  )
})

test('反向判据：往协议层里塞一个 WebSocket，上面那条立刻红', () => {
  // 证明它在查"有没有这个概念"，而不是恒绿
  const dirty: SourceFile[] = [
    ...srcFiles(),
    {
      file: 'src/wire/__probe.ts',
      text: [
        "import { WebSocket } from 'ws'",
        "import { createServer } from 'node:http'",
        'export const probe = new WebSocket("wss://example.com")',
      ].join('\n'),
    },
  ]
  const v = verdict(dirty)
  assert.ok(
    v.unregistered.length >= 3,
    `新塞进去的三个概念（ws-package / node-transport / websocket-api + ws-scheme）应该被判为未登记，实际 ${v.unregistered.length} 条`,
  )
  assert.match(v.unregistered.join('\n'), /ws-package/, "`from 'ws'` 要被抓到")
  assert.match(v.unregistered.join('\n'), /node-transport/, '`node:http` 要被抓到')
})

test('反向判据：把登记里那条的代码删掉（但不删登记），上面那条也红', () => {
  // 证明"计数精确"这一半不是装饰：少一处同样红，否则 ALLOWED 会变成一张永远有效的通行证
  const withoutPairing = srcFiles().filter((f) => f.file !== 'src/identity/pairing.ts')
  assert.ok(withoutPairing.length === srcFiles().length - 1, '夹具没把 pairing.ts 滤掉 —— 那这条反证什么也没证')
  const v = verdict(withoutPairing)
  assert.ok(
    v.expired.length === ALLOWED.length,
    `删掉 pairing.ts 后 ${ALLOWED.length} 条登记都该判为过期，实际 ${v.expired.length} 条`,
  )
})

test('这份判据本身不是死的（概念清单有规模、每条都有理由、登记都指向 §9.2）', () => {
  assert.ok(CONCEPTS.length >= 6, `只有 ${CONCEPTS.length} 条概念：清单被削过，扫了等于没扫`)
  for (const c of CONCEPTS) {
    assert.ok(c.why && c.why.length > 12, `${c.id} 缺"为什么它是传输专有" —— 下一个人会把它当噪音删掉`)
  }
  for (const a of ALLOWED) {
    assert.ok(a.why && a.why.length > 30, `${a.concept} @ ${a.file} 的 why 太短：说不清它为什么能留着`)
    assert.ok(a.todo, `${a.concept} @ ${a.file} 是一条已知的耦合，必须指向 §9.2 —— 否则它会永远留在这里`)
  }
  // 概念清单与登记之间不许有"写了却永不生效"的项（id 打错字是最常见的那种）
  for (const a of ALLOWED) {
    assert.ok(
      CONCEPTS.some((c) => c.id === a.concept),
      `${a.concept} 不在 CONCEPTS 里 —— 打错字的话这条登记永远不会命中，而判据照样绿`,
    )
  }
})
