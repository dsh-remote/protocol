# Changelog

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

2.0.21 及更早的完整历史见旧仓 [`providcc/dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol) 的 CHANGELOG。
