# Changelog

## 3.0.0（开发中）

- v3：四端合并进 `dsh-remote-v3` 单仓开发；包名由 `dsh-remote-wire` 迁到 **`@dsh-remote/protocol`**，
  仓库改到 [`dsh-remote/dsh-remote-protocol`](https://github.com/dsh-remote/dsh-remote-protocol)。
- **补差量**：`cmd.session_history.since`（与 `beforeSeq` 互斥）+ `ev.session_history.latestSeq`（空页也给）；
  错误码 `history_window_exceeded`（不可重试）；能力位 `drc.payload.resume`。见 SPEC §10.7（S1–S6）。
- `ev.session_history` 的**出站构造器**补上 `latestSeq`——加字段时漏了它，schema 与判据都看不出来。
- 防休眠：三平台如实上报（`detectBackend(win32) === "unsupported"`），判据 5 条钉住。
- 判据 168 → 179。

2.0.21 及更早的完整历史见旧仓 [`providcc/dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol) 的 CHANGELOG。
