# Changelog

## 0.5.4 —— 订阅消息面：审批/提问挂起时的微信提醒

新增两个**明文控制帧**（都不携带载荷内容）与一个**动态能力位**。

| 帧                | 方向           | 形状                                                                              |
| ----------------- | -------------- | --------------------------------------------------------------------------------- |
| `notify-register` | client → relay | `{code, subscribed?}`（`code` 是 `wx.login` 的一次性 code）                       |
| `notify-approval` | host → relay   | `{conversationId, items[]}`（1–10 条，每条只有 requestId/sessionId/kind/askedAt） |

- `hello-ok.notify` = `{templateId}`：**只有中继真的启用了 notifier 才带**。
- 能力位 `notify.v1`：**动态**（不在 `RELAY_CAPABILITIES` 里）——
  通知面要 appid+secret+模板 三样都配齐才启用，声明了却发不出去比不声明更坏。
- `FEEDBACK_SLA_HOURS` 之外新增 `NOTIFY_DELAY_MS`（宿主侧，60 秒）。

判据：`tests/wire/notify.test.ts`（6 条）。帧名计数 20 → 22。

## 0.5.3 —— 回滚反馈面：改用微信小程序客服

反馈不再经过中继，也不再自定义协议。小程序的「意见反馈」入口保留原 FAB，
但点击直接走微信原生客服（`<button open-type="contact">`）。

删除 0.5.2 引入的整块反馈面：

- 三帧 `feedback` / `feedback-poll` / `feedback-list`；
- `FeedbackItem`、`FEEDBACK_SLA_HOURS` / `FEEDBACK_TEXT_MAX` / `FEEDBACK_CONTACT_MAX`；
- 能力位 `feedback.v1`（`RELAY_CAPABILITIES` 只剩 `digest.v1`）；
- 错误码 `not_paired`。

协议帧表回到 20 个（endpoint 10 / relay 13，重叠 3）。老小程序按能力位开入口：
新中继不声明 `feedback.v1`，0.5.5 及更早的客户端不会显示反馈入口、也不会发三帧。

## 0.5.2 —— 反馈面（`feedback` / `feedback-poll` / `feedback-list` + `feedback.v1`）

### 为什么有一块明文

零知识边界此前只有两个例外：`summary`（状态摘要，白名单只许状态类字段）与管理面。
本版是**第三个**，而且性质不同 —— 反馈是**用户亲手敲的**意见，它全部的价值就在那句话本身，
加密就没有人读得到（而读它的人正是要改这个产品的人）。

⇒ 这不是"破了一次零知识"，而是**开了一扇有名字的门**：
① 只承载用户主动提交的那一段文字，不与任何会话内容混流；
② 不经过 `enc`（中继存的是原文），落盘文件与会话表分开；
③ 有**能力位** `feedback.v1` —— 中继不声明，小程序就不开这个入口；
④ 有**限频**与**体量上限**（客户端无鉴权，clientId 是自报的）。

### 三帧

| 帧              | 方向        | 形状                                                      |
| --------------- | ----------- | --------------------------------------------------------- |
| `feedback`      | 端点 → 中继 | `{id, text, contact?}`（`id` 是幂等键）                   |
| `feedback-poll` | 端点 → 中继 | `{}`                                                      |
| `feedback-list` | 中继 → 端点 | `{items: FeedbackItem[]}`（**只含这个 clientId 自己的**） |

`FeedbackItem`（要落盘的形状）：`{id, text, contact?, at, status: 'open'|'replied', reply?, repliedAt?}`，
**strict** —— 坏形状整条拒收，不静默剥键（与 `statusDigest` 同一条纪律）。

### 资格与错误码

**只有配对成功的人才有权限提反馈**（2026-10-26 产品裁决）。中继以"这个 clientId
是不是某条活跃会话的成员"为凭据 —— 那需要真走过一次扫码 + SAS 确认，不是自报能伪造的。

新增错误码 **`not_paired`**。它**必须区别于 `unknown_session`**：后者会让客户端
清配对并要求重扫，而这里配对是好的，只是这一条业务动作没资格做
⇒ 客户端只提示"先配对再反馈"，**绝不能**顺手把配对清了。

### 承诺

`FEEDBACK_SLA_HOURS = 24` 写在协议层，因为**两处必须一致**：中继算「逾期未回」用它，
小程序显示「承诺 24 小时内回复」也用它。两处各写一个 24 的话，有一天有一处被改成 48，
用户看到的承诺就和中继的口径对不上 —— 而"承诺"一旦对不上，整条通道就失去意义。

## 3.2.14 —— 与 3.2.13 逐字节相同（版本对齐，无协议改动）

`src/` 无任何改动：没有新帧、没有新义务、没有 schema 改动 ⇒ **中继与小程序不需要配套动作**。
这一版只为版本号对齐（3.2.14 的实质改动在 relay）。

## 3.2.13 —— 与 3.2.12 逐字节相同（四包同号，无协议改动）

这一版只是为了四个包保持同一个版本号（发版惯例）。`src/` 与 3.2.12 完全一致：
没有新帧、没有新义务、没有 schema 改动 ⇒ **中继与小程序不需要任何配套动作**。

- `hello.resume` / `resume-gap` 仍是 3.2.12 定下的形状（§10.8）。
- 中继的 `protocol` 兼容表不动（§17.1）。

## 3.2.12 —— 断线补帧的协议面（`hello.resume` + `resume-gap`）

### `hello` 新增可选字段 `resume{sessionId, fromSeq}`

重连时报"上次收到哪里"，中继据此从环形缓冲把断线期的帧补投（规范 §10.8）。
**§15.1 加性字段，不升版本**：旧中继 zod strip 静默忽略、旧客户端不带字段
⇒ 新旧双向兼容零报错（两端各有一条判据钉着）。

### 新帧 `resume-gap{sessionId, reason: overflow|reset}`

补不出来时**明确说"缺了一段"**，绝不悄悄缺帧（§10.7 S5 同族）：
`overflow` = 环滚出、`reset` = 游标跑到计数器前面。FRAME_TYPES 18→19。

### 兼容

- 旧客户端 × 新中继：不带 `resume` ⇒ 行为逐字节是现状。
- 新客户端 × 旧中继：`resume` 被 strip ⇒ 零报错，退回现状。
- SPEC §5.1 / §8 / §10.8（P1–P6 义务）/ §17.1 帧名表同步。

## 3.2.11

版本号随四包同步。本包**无代码改动**。

## 3.2.10

版本号随四包同步。本包**无代码改动**。

## 3.2.9

版本号随四包同步。本包本轮只有一处改动：

- `hello` 帧新增**可选** `softwareVersion`（**默认不带这个键**，帧逐字节不变 ⇒ 零知识不变）。
  只有 `DRC_REPORT_VERSION=1` 的部署才会带上；中继侧对应开关 `reportSoftwareVersion` 默认 **false**。

## 3.2.8

版本号随四包同步。本包**无代码改动**。

## 3.2.7

版本号随四包同步。本包**无代码改动**。

发布工作流的 provenance 判据收紧：`grep -Eq` 容忍压缩/展开两种 JSON，并要求
`attestations` 数组首项是对象（空数组不算）；`e2e/npm-publish-tp.test.mjs`
把这条正则抽出来跑样例，压缩、展开、空数组、错误体、相近字段名五个方向都钉住。

## 3.2.6

版本号随四包同步。本包**无代码改动**。

## 3.2.5

版本号随四包同步。本包**无代码改动**。

## 3.2.4

`evHostInfo.host` 新增 `pluginVersion`（**optional**）。

手机要在首页提示"电脑上的插件太旧了，请升级到 X"：3.2 换掉了整条配对协议，
**3.1.x 的插件配不上 3.2.x 的小程序而两端都不报错**；pnpm 的 `minimumReleaseAge`
还会静默把插件降级到最后一个"够老"的版本（用户本机就这么回到 3.1.8）。

⚠️ **必须是 optional**：3.2.0 之前的插件不发这一格，而手机连的主机里恰恰就有那一批。
必填会让整帧 `ev.host_info` 被 schema 拒掉 —— 那比"少一个字段"糟得多
（限额、防休眠状态全跟着丢）。

## 3.2.3

版本号随四包同步。协议层无改动。

## 3.2.2

版本号随四包同步。协议层无改动。

## 3.2.1

### 删除：配对 URI 整条（`buildPairingUri` / `parsePairingUri` / `PairingInfo` / `normalizePairingToken`）

3.2.0 删掉了本机渲染二维码，但协议层还留着那条 `dshr:/p?v=1&s=…&psk=…` 的构造与解析 ——
它唯一的消费者（插件发码时拼 `qr` 字符串，只为算一个 ETag）也已改成用 token 派生。
**没有第二种码，就不该有第二个格式**，于是整条删掉：本包只剩 6 位配对码
（`randomPairingToken` / `formatPairingToken`）。

⚠️ 破坏面：`export *` 出去的这四个名字没了。本仓只有 plugin 用过（同一批已改），npm 上没有
第三方消费者。把它们加回来之前先读 `src/identity/pairing.ts` 的文件头。

### 判据

- 删除 10 条 URI 用例（构造/解析/容错/对拍），新增「随机源没有被截断」一条：185。
- `transport-neutrality` 的唯一两条登记（`ws-scheme` / `websocket-api` @ `identity/pairing.ts`）
  **随之过期并删除** —— 协议层现在已经没有传输耦合。反向判据改成"造一条故意过期的登记"，
  证明这条闸真会报过期（3.2.1 清理时它真咬过一次）。
- 伞仓的 golden vector 跟着缩了两段：`qr`（33 组）与 `normalizeToken`（8 组）没有对端了，
  284 条 → **243 条**（`e2e/protocol.test.mjs` 三对拍用例退役，18 项 → 15 项）。向量由
  小程序那份 `codec.js` 生成（它审核期冻结，一行不改），所以删的是"没人消费的那两段"，
  不是"重新生成了一遍"。

## 3.2.0

版本号随四包同步（本包无代码改动）。3.2 的破坏性变更全在宿主插件与小程序：删掉了本机渲染
`dshr:` 二维码那一套，配对只剩小程序码一条路。

## 3.1.12

版本号随四包同步。

## 3.1.11

版本号随四包同步（本包无代码改动）。

## 3.1.10

版本号随四包同步（本包无代码改动）。

## 3.1.9

### 双码合一：新增 pair-grant 的路由字段 sessionId（2026-10-21）

`pair-request` 补上 `sessionId`（认领时**新开**的那条会话号）。

为什么必须补：中继在 `claim()` 的同一时刻就把配对码消费掉了，**没有"配对码 → 会话"的
映射**。而 `pair-grant`（主机把 psk 密文送回手机）是**按会话号投递**的——缺了它，
主机回了密文中继也无处可送，表现是"手机上一直停在等待确认"。

判据 195（`pair-request` 缺 `clientPub` / 缺 `sessionId` 都必须被拒）。

## 3.1.8

版本号随四包同步（本包无代码改动）。

## 3.1.7

版本号随四包同步（本包无代码改动）。

## 3.1.6

版本号随四包同步（本包无代码改动）。

## 3.1.5

> 四个包一起 bump 到 `3.1.5`。**主体是小程序的审核整改**（见 `packages/client/CHANGELOG.md`）。
> 本包**代码无变化**；review 只修了 README 里一条**已经失效的规范**。

### 深度 review 补丁（2026-10-12）

- ⚠️ `README.md` 的红线里还写着「增量只许走**能力位**，不许改既有形状」——
  而能力位机制（`hello.capabilities` / `ev.host_info.caps` 与三端的降级分支）
  **已整条删除**（2026-10-11 单版本制裁决）。现在写的是真实规则：改既有形状就是
  破坏性变更，必须同时升 `PROTOCOL_VERSION` 并让三端一起升。
- 注释里的证据指针过期的（`@dsh-rc/protocol`、`mp/core/*.js`）一律指到真实位置。

## 3.1.4

> 四个包一起 bump 到 `3.1.4`。**主题：把"向后兼容"整条清掉**（用户裁决：没有真实用户，
> 只留最优解与最新版本）。这一版**故意破坏线协议**：三端必须一次升到同一版本。

- **单版本制**：删除协议协商的两条容忍路径 —— V1「`hello.protocol` 缺省视为 1」与
  V3「对端落在 `[MIN_SUPPORTED_PROTOCOL, 本端]` 区间即可」。现在 `hello.protocol`
  是**必填**，且必须**等于**本端版本，否则中继在 `hello` 那一刻回
  `error{unsupported_protocol}` 并关连接（1002）。`MIN_SUPPORTED_PROTOCOL` 常量删除。
- **能力位整条机制删除**：`hello` / `hello-ok` 的 `capabilities`、`ev.host_info.caps`、
  `CAPABILITY_IDS` / `CAPABILITY_DESCRIPTIONS` / `isKnownCapability` / `hasCapability` /
  `filterCapabilities` / `sharedCapabilities` 全部移除。它存在的目的是"对端**可能**不支持
  某个载荷时降级"（典型是 `drc.payload.resume` ⇒ 不发 `since`）；单版本制下这个问题
  不存在，于是手机**总是**发 `since`，宿主做不出差量时明确拒绝、客户端退回整页重读。
- **形状只有一种**：`ev.permission_resolved` / `ev.question_resolved` 的 `sessionId` 与
  `by` 从可选改为**必填**（生产端一直都给全，可选只留下"收错卡/收错会话"的空间）。
- 判据：删掉整份 `e2e/wire-handshake-compat.test.mjs`（它手抄了 `hello@2.0.14` 的旧
  schema 来证明三端加性兼容）；`negotiate` / `registry` / `resume-capability` /
  `frames` / `payloads` / `outbound` 的判据按新契约重写。

## 3.1.3

> 四个包一起 bump 到 `3.1.3`。

**本包无代码改动**（四包同号）。这一版改的是中继的 host token 模型与插件的认领请求体。

## 3.1.2

> 四个包一起 bump 到 `3.1.2`。**本包无代码改动**（版本号按约定与 plugin 同号）。
> 实质内容都在 `relay`（认领 host token 的接口）与 `plugin`（默认中继 + 自动认领 + 设置页进阶一栏）。

## 3.1.1

> 四个包一起 bump 到 `3.1.1`。**本包无代码改动**（版本号按约定与 plugin 同号）。
> 实质内容都在 `plugin`：`approvalTimeoutSec` 配置项被删除。

## 3.1.0

> 四个包（`protocol` / `relay` / `plugin` / `client`）一起 bump 到 `3.1.0`。

**本包无代码改动** —— 线协议、KDF、帧 schema 一个字没动。

- **发布链路换成 npm Trusted Publishing（OIDC）**：新增 `.github/workflows/release.yml`，
  打 `v*` tag 即发。没有 `NPM_TOKEN`、没有长期凭据 —— GitHub 签一个 OIDC token，npm 核对
  「这次运行确实是本仓、本工作流」之后发一个短时发布 token。
  `publishConfig.provenance` 随之打开 ⇒ **从这一版起 npm 上有供应链溯源**（v3.0.x 各版都没有）。
- **修 `repository` / `homepage` / `bugs`**：一直指向 `dsh-remote/dsh-remote-<包名>`（**不存在**），
  实际仓名是 `dsh-remote/<包名>` ⇒ npm 包页的仓库链接此前是 404。

## 3.0.0

> 3.0.1 ~ 3.0.8 是 v3 上线前后的迭代版本（都已发到 npm），逐版记录在伞仓
> [`docs/RELEASE.md`](https://github.com/linbin/dsh-remote-v3) 的「已发布记录」。
> 这一节只保留 3.0.0 当时的内容。

- v3：四端合并进 `dsh-remote-v3` 单仓开发；包名由 `dsh-remote-wire` 迁到 **`@dsh-remote/protocol`**，
  仓库改到 [`dsh-remote/dsh-remote-protocol`](https://github.com/dsh-remote/dsh-remote-protocol)。
- **补差量**：`cmd.session_history.since`（与 `beforeSeq` 互斥）+ `ev.session_history.latestSeq`（空页也给）；
  错误码 `history_window_exceeded`（不可重试）；能力位 `drc.payload.resume`。见 SPEC §10.7（S1–S6）。
- `ev.session_history` 的**出站构造器**补上 `latestSeq`——加字段时漏了它，schema 与判据都看不出来。
- 防休眠：三平台如实上报（`detectBackend(win32) === "unsupported"`），判据 5 条钉住。
- 判据 168 → 179。

2.0.21 及更早的完整历史见 npm 版本页（旧仓已于 2026-10-20 删除，发布物仍在）：
[`dsh-remote-wire` 的历史版本](https://www.npmjs.com/package/dsh-remote-wire?activeTab=versions)。
