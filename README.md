# @dsh-remote/protocol

DSH Remote Control 的**线协议层**：密封记录（XSalsa20-Poly1305）、方向密钥派生（KDF）、
中继控制帧与构造器、`cmd.*` / `ev.*` 载荷目录、错误码可重试表、协议版本闸、防休眠命令构造器。

**纯函数、零 I/O**：不认识时钟、不认识平台、不发定时器——所以每条冻结契约都能脱离环境
逐字节被测（含 golden vectors 对拍：与小程序里那份保留实现的 SHA-256 锚定）。

## 安装

```sh
npm install @dsh-remote/protocol
```

## 结构

| 子路径             | 内容                                                          |
| ------------------ | ------------------------------------------------------------- |
| `…/keys`           | PSK 生成、两把方向密钥的 HKDF 风格派生、计数器 nonce          |
| `…/record`         | `seal()` / `open()`——基于 tweetnacl 的密封记录                |
| `…/frames`         | 中继控制帧的 zod schema + 解析器（帧名冻结）                  |
| `…/outbound`       | 同一批帧的构造器（产物保证过 schema）                         |
| `…/payloads`       | `cmd.*` / `ev.*` 载荷目录的 zod schema                        |
| `…/limits`         | 三端共享的数值预算（帧上限 / 附件上限 / 去重窗口）            |
| `…/registry`       | 帧名 / 载荷名 / 能力 id 的注册表（编译期与 zod 联合一致）     |
| `…/classify`       | 帧的分类（谁向谁、能不能重试）                                |
| `…/errors`         | 错误码表与可重试判定                                          |
| `…/idempotency`    | 请求幂等去重窗口                                              |
| `…/negotiate`      | 协议版本闸（单版本严格校验）+ `PROTOCOL_VERSION`              |
| `…/report-version` | `DRC_REPORT_VERSION` 判定（版本上报开关，仅小程序上传在用）   |
| `…/pairing`        | 6 位配对码工具（`randomPairingToken` / `formatPairingToken`） |
| `…/ids`            | 会话 / 主机 / 命令 id 的生成与前缀                            |
| `…/sleep`          | 防休眠命令构造器（`caffeinate` / `systemd-inhibit`）          |

完整清单见 `package.json` 的 `exports`；根入口会把全部子路径再导出一次。

## 红线

- **协议中立**：不引入任何传输层（WS / SSE / HTTP）与平台概念——游标、ack 这类
  会话层语义可以进协议，但「因为是 WS 所以……」不可以。
- 帧名与载荷名**冻结**：改动既有形状就是**破坏性变更**，必须升 `PROTOCOL_VERSION`
  并让三端一起升（`hello.protocol` 必填且必须与本端相等，不相等的一端在握手上就被拒）。
  **加性演进不升号**（新增可选字段 / 新帧名），新行为走**能力协商**：
  中继在 `hello-ok.capabilities` 里声明、端点按声明开（发版含义见伞仓 `docs/RELEASE.md`）。
- 本包**不许出现** `node:fs` / `node:os` / `process.*`（I/O 全部在消费方）。

## 开发

```sh
pnpm install
pnpm test        # tsc 构建 + node --test
pnpm typecheck
```

## 许可

MIT
