# @dsh-remote/protocol

DSH Remote Control 的**线协议层**：密封记录（XSalsa20-Poly1305）、方向密钥派生（KDF）、
配对 URI、中继控制帧、`cmd.*` / `ev.*` 载荷目录、错误码可重试表、防休眠命令构造器。

**纯函数、零 I/O**：不认识时钟、不认识平台、不发定时器——所以每条冻结契约都能脱离环境
逐字节被测（含 golden vectors 对拍：与小程序里那份保留实现的 SHA-256 锚定）。

## 安装

```sh
npm install @dsh-remote/protocol
```

## 结构

| 子路径 | 内容 |
|---|---|
| `…/keys` | PSK 生成、两把方向密钥的 HKDF 风格派生、计数器 nonce |
| `…/record` | `seal()` / `open()`——基于 tweetnacl 的密封记录 |
| `…/frames` | 中继控制帧的 zod schema + 解析器（帧名冻结，v1） |
| `…/limits` | 三端共享的数值预算（帧上限 / 附件上限 / 去重窗口） |
| `…/registry` | 帧名 / 载荷名 / 能力 id 的注册表（编译期与 zod 联合一致） |
| `…/payloads` | `cmd.*` / `ev.*` 载荷目录的 zod schema |
| `…/pairing` | `dshr:/p?...` 配对 URI 编解码、6 位码工具 |
| `…/sleep` | 防休眠命令构造器（`caffeinate` / `systemd-inhibit`） |

完整清单见 `package.json` 的 `exports`；根入口会把全部子路径再导出一次。

## 开发

```sh
pnpm install
pnpm test        # tsc 构建 + node --test
pnpm typecheck
```

## 红线

- **协议中立**：不引入任何传输层（WS / SSE / HTTP）与平台概念——游标、ack 这类
  会话层语义可以进协议，但「因为是 WS 所以……」不可以。
- 帧名与载荷名**冻结**（v1）；增量只许走能力位，不许改既有形状。
- 本包**不许出现** `node:fs` / `node:os` / `process.*`（I/O 全部在消费方）。

## 许可

MIT
