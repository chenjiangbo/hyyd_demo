import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

export function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), '../../.env')
  if (!existsSync(envPath)) {
    throw new Error(`缺少根目录 .env 文件: ${envPath}`)
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

