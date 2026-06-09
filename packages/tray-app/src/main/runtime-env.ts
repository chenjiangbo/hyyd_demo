import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * 现场版改造后，tray-app 不再依赖项目根 .env：
 *
 *   - LLM/VLM 调用全部迁到后端，不需要 API key
 *   - ASR (DashScope) 一直就在后端
 *   - tray-app 只通过 backend REST/WS 走业务流量，不直接接外部 API
 *
 * 因此 .env 在员工 VM 上是不存在的（deploy-win 会刻意排除）。
 * 这里保留载入逻辑只为本地开发方便：根目录有 .env 就 merge 进来，
 * 没有就跳过（不抛错），员工 VM 上正常启动。
 */
export function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), '../../.env')
  if (!existsSync(envPath)) {
    // 现场 VM 上预期没有 .env，这是 by design 的（不让 secrets 上员工机器）
    console.log('[env] 未找到根目录 .env，跳过本地 env 注入（现场版预期行为）')
    return
  }

  const content = readFileSync(envPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
    if (process.env[key] === undefined) process.env[key] = value
  }
}

