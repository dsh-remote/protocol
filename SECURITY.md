# Security Policy

## 报告漏洞

用本仓 GitHub 的私密渠道：**Security → Report a vulnerability**（`/security/advisories/new`）。
不要在公开 issue 里贴可利用细节。

## 本仓的范围

- 负责：密封记录的**字节级格式**（`seal` / `open`）、方向密钥派生（KDF）、计数器 nonce、
  配对 URI 编解码、控制帧与载荷的 schema 严格性。
- 不负责：网络层（中继）、TLS 终止、凭据存储、审批策略——那些在中继与宿主插件两个包。

## 设计边界（与本仓相关）

- 本包**零 I/O**：没有网络、没有磁盘、没有时钟；一切外部输入都是参数。
- 唯一密码学原语是 tweetnacl 的 XSalsa20-Poly1305；KDF 是 HKDF 风格的 sha256 派生。
- 密钥材料（PSK / 方向密钥）在本包内只以 `Uint8Array` 形态存在，**不序列化**。
