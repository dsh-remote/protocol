/**
 * 「要不要把版本号报给中继」的**唯一判定处**（2026-10-22）。
 *
 * ## 为什么要有这个开关
 * 排查"这人的两端为什么配不上"时最缺的就是版本号 ——
 * 3.1.x 的插件配不上 3.2.x 的小程序，而**两端都不报错**
 * （形状见 `packages/client/core/version.js` 的头注）。
 * 有了它，中继能按版本分组，一眼看出"这批全是老版本"。
 *
 * ## ⚠️ 为什么**默认关**（零知识）
 * 承载版本号的是 `hello` 帧 —— **明文**控制帧 ⇒ 中继**看得见**。
 * ⇒ 默认**不带** ⇒ 发出去的帧**逐字节与加这个字段之前相同**
 * ⇒ **开源版不因为加了这个字段而多暴露任何东西**。
 *
 * ## 开关怎么开
 * 三处**同名**的环境变量 `DRC_REPORT_VERSION=1`：
 * - 主机插件：进程环境（或 `user-config.json` 的同名字段）；
 * - 中继：进程环境；
 * - 小程序：**上传时**的环境变量（`scripts/mp-upload.mjs` 把它写进构建产物）。
 *
 * ⇒ **私有部署开、开源版不开** ⇒ 两条线互不影响。
 */

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
