/**
 * 「要不要把版本号报给中继」的环境变量判定（2026-10-22 加；2026-10-23 裁决后语义变了）。
 *
 * ## 背景
 * 排查"这人的两端为什么配不上"时最缺的就是版本号 ——
 * 3.1.x 的插件配不上 3.2.x 的小程序，而**两端都不报错**
 * （形状见 `packages/client/core/version.js` 的头注）。
 * 有了它，中继能按版本分组，一眼看出"这批全是老版本"。
 *
 * ## 现状（2026-10-23 用户裁决："不用做开关，丰富埋点"）
 * 这个判定**只剩小程序上传一处在用**（`scripts/mp-upload.mjs` 自己读同名环境变量，
 * **默认开**、`0/false` 才关）。主机插件**无条件**上报（`index.ts` 的 hello 构造），
 * 中继**无条件**记并聚合（healthz 的 hostVersions/clientVersions，`DRC_REPORT_VERSION`
 * 已不再是中继的闸）。
 *
 * 本函数与 `REPORT_VERSION_ENV` **保留**：protocol 的导出是公共 API（外部消费者在用），
 * "内部不用 ≠ 死代码"。历史上"默认关、私有部署开"的设计见 git 历史。

/** 环境变量名（三处统一）。 */
export const REPORT_VERSION_ENV = 'DRC_REPORT_VERSION'

/**
 * 这个值是不是"要报版本"。
 *
 * 认 `1` / `true`（大小写不敏感）—— 与 relay 侧 `config.ts` 的读法**逐字一致**，
 * 别让两边的开关语义分叉（分叉 ⇒ "我开了但没生效"这种极难查的问题）。
 */
export function reportSoftwareVersion(env: { [k: string]: string | undefined }): boolean {
  const raw = (env[REPORT_VERSION_ENV] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}
