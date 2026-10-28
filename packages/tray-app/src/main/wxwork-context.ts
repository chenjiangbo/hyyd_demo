import { existsSync, readFileSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { execFileSync } from 'child_process'

export type WxworkContext = {
  profileId: string
  accountDirectoryId: string
  wecomRoot: string
  sourceRoot: string
  identityKey: string
}

function readVarint(bytes: Buffer, offset: { value: number }): bigint {
  let value = 0n
  let shift = 0n
  while (offset.value < bytes.length && shift < 70n) {
    const byte = bytes[offset.value++]
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return value
    shift += 7n
  }
  throw new Error('企微当前账号信息中的 protobuf 字段不完整')
}

function accountDirectoryId(encodedUserInfo: unknown): string {
  if (typeof encodedUserInfo !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedUserInfo)) {
    throw new Error('企微当前账号信息缺少有效的 user_info')
  }
  const bytes = Buffer.from(encodedUserInfo, 'base64')
  if (bytes.length === 0 || bytes.length > 4096 || bytes.toString('base64') !== encodedUserInfo) {
    throw new Error('企微当前账号信息长度或编码无效')
  }

  const offset = { value: 0 }
  const matches: string[] = []
  while (offset.value < bytes.length) {
    const tag = readVarint(bytes, offset)
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (!Number.isSafeInteger(field) || field <= 0) throw new Error('企微当前账号信息字段无效')
    if (wire === 0) {
      const value = readVarint(bytes, offset)
      if (field === 1) matches.push(value.toString())
    } else if (wire === 1) {
      offset.value += 8
    } else if (wire === 2) {
      const length = readVarint(bytes, offset)
      if (length > BigInt(bytes.length - offset.value)) throw new Error('企微当前账号信息字段长度无效')
      offset.value += Number(length)
    } else if (wire === 5) {
      offset.value += 4
    } else {
      throw new Error(`企微当前账号信息使用不支持的 protobuf wire type ${wire}`)
    }
    if (offset.value > bytes.length) throw new Error('企微当前账号信息字段越界')
  }
  if (matches.length !== 1 || !/^\d+$/.test(matches[0]) || matches[0] === '0') {
    throw new Error('无法从企微当前账号信息中唯一确定数据目录编号')
  }
  return matches[0]
}

type RegistryLocation = { dataLocationPath?: string; dataLocation?: number }
type WindowsLocations = { roots: string[]; installed: boolean | null }

function discoverRegistryLocations(): { entries: RegistryLocation[]; error?: string } {
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; $items=@(); foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) { $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view); try { $key=$base.OpenSubKey('Software\\Tencent\\WXWork'); if ($key) { try { $items+=,[pscustomobject]@{dataLocationPath=[string]$key.GetValue('DataLocationPath','');dataLocation=$key.GetValue('DataLocation')} } finally { $key.Dispose() } } } finally { $base.Dispose() } }; [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($items) -Compress))))"
    ], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
    const parsed: unknown = JSON.parse(Buffer.from(output.trim(), 'base64').toString('utf8'))
    if (!Array.isArray(parsed)) throw new Error('企微注册表返回值不是列表')
    return { entries: parsed.filter((entry): entry is RegistryLocation => !!entry && typeof entry === 'object') }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { entries: [], error: `注册表查询失败：${detail}` }
  }
}

function registeredPath(entry: RegistryLocation): string | null {
  return typeof entry.dataLocationPath === 'string' && entry.dataLocationPath.trim()
    ? entry.dataLocationPath.trim()
    : null
}

function knownWxworkLocations(documentsPath: string, registry: RegistryLocation[]): WindowsLocations {
  const roots: string[] = []
  for (const entry of registry) {
    const path = registeredPath(entry)
    if (path) roots.push(path)
  }
  // DataLocation=0 on the tested Windows install stores the profile under Documents\\WXWork.
  // Always inspect this known folder; the registry value is absent on some previously-used installs.
  if (documentsPath.trim()) roots.push(join(documentsPath, 'WXWork'))

  const folderOutput = execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$ErrorActionPreference='Stop'; $roaming=[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData); $local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData); $programFiles=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles); $programFilesX86=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86); $appPaths=@(); $uninstall=@(); foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) { $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view); try { $app=$base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WXWork.exe'); if ($app) { try { $appPaths+=,[string]$app.GetValue('') } finally { $app.Dispose() } }; $un=$base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); if ($un) { try { foreach ($name in $un.GetSubKeyNames()) { $item=$un.OpenSubKey($name); if ($item) { try { $display=[string]$item.GetValue('DisplayName',''); if ($display -match '企业微信|WeCom|WXWork') { $uninstall+=,[string]$item.GetValue('InstallLocation','') } } finally { $item.Dispose() } } } } finally { $un.Dispose() } } } finally { $base.Dispose() } }; $current=$null; try { $current=Get-Process -Name WXWork -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Path } catch {}; $executables=@($appPaths + $current + (Join-Path $programFiles 'WXWork\\WXWork.exe') + (Join-Path $programFilesX86 'WXWork\\WXWork.exe') + (Join-Path $local 'WXWork\\WXWork.exe') + ($uninstall | ForEach-Object { Join-Path $_ 'WXWork.exe' })); $installed=($executables | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1) -ne $null; $o=[pscustomobject]@{roaming=$roaming;local=$local;installed=$installed}; [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o|ConvertTo-Json -Compress))))"
  ], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
  const folders = JSON.parse(Buffer.from(folderOutput.trim(), 'base64').toString('utf8')) as { roaming?: unknown; local?: unknown; installed?: unknown }
  for (const root of [folders.roaming, folders.local]) {
    if (typeof root !== 'string' || !root.trim()) continue
    roots.push(join(root, 'Tencent', 'WXWork'), join(root, 'Tencent', 'WXWork', 'Data'), join(root, 'WXWork'))
  }
  return {
    roots: [...new Set(roots)],
    installed: typeof folders.installed === 'boolean' ? folders.installed : null
  }
}

function rootCandidates(path: string): string[] {
  const candidates = [path]
  // Some releases store Profiles beside, rather than inside, the configured Data directory.
  if (basename(path).toLowerCase() === 'data') candidates.push(dirname(path))
  return candidates
}

function discoverWxworkContext(documentsPath: string): WxworkContext {
  const registryResult = discoverRegistryLocations()
  let locations: WindowsLocations = { roots: documentsPath.trim() ? [join(documentsPath, 'WXWork')] : [], installed: null }
  let folderError: string | null = null
  try {
    locations = knownWxworkLocations(documentsPath, registryResult.entries)
  } catch (error) {
    locations.roots.push(...registryResult.entries.map(registeredPath).filter((path): path is string => path !== null))
    folderError = error instanceof Error ? error.message : String(error)
  }

  const explicitRoots = registryResult.entries.map(registeredPath).filter((path): path is string => path !== null)
  const ordered = [...explicitRoots, ...locations.roots.filter((root) => !explicitRoots.includes(root))]
  const valid: WxworkContext[] = []
  const checked = new Set<string>()
  const failedCandidates: string[] = []
  for (const root of ordered.flatMap(rootCandidates)) {
    const key = root.toLowerCase()
    if (checked.has(key)) continue
    checked.add(key)
    try {
      valid.push(resolveWxworkContextAtRoot(root))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failedCandidates.push(`${root}: ${detail}`)
    }
  }

  if (locations.installed === false) throw new Error('未安装企业微信')

  // Prefer an explicit, structurally valid registry path. If it is unusable, only accept a
  // filesystem-discovered location when the profile structure identifies exactly one account.
  const explicit = valid.find((context) => explicitRoots.some((root) => context.wecomRoot.toLowerCase() === root.toLowerCase()))
  if (explicit) return explicit
  const unique = new Map(valid.map((context) => [context.identityKey, context]))
  if (unique.size === 1) return [...unique.values()][0]

  const diagnostics = [registryResult.error, folderError].filter(Boolean).join('；')
  if (unique.size > 1) throw new Error(`发现多个有效的企微数据目录，无法唯一确定当前目录（${unique.size} 个）${diagnostics ? `；${diagnostics}` : ''}`)
  const candidateDetails = failedCandidates.length ? `；已检查位置及结果：${failedCandidates.join('；')}` : ''
  throw new Error(`未检测到当前企微的数据目录${diagnostics ? `；${diagnostics}` : ''}${candidateDetails}`)
}

export function resolveWxworkContext(documentsPath: string): WxworkContext {
  return discoverWxworkContext(documentsPath)
}

export function resolveWxworkContextAtRoot(wecomRoot: string): WxworkContext {
  const profilesRoot = join(wecomRoot, 'Profiles')
  const settingsPath = join(profilesRoot, 'setting.json')
  if (!existsSync(settingsPath) || !statSync(settingsPath).isFile()) {
    throw new Error('未找到企微当前配置文件，已停止企微消息采集')
  }

  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    throw new Error('企微当前配置文件无法解析，已停止企微消息采集')
  }
  const profileId = (settings as { CurrentProfile?: unknown } | null)?.CurrentProfile
  if (typeof profileId !== 'string' || !/^[A-Fa-f0-9]{32}$/.test(profileId)) {
    throw new Error('企微当前配置未提供有效的 CurrentProfile，已停止企微消息采集')
  }

  const profilePath = join(profilesRoot, profileId, 'io_data.json')
  if (!existsSync(profilePath) || !statSync(profilePath).isFile()) {
    throw new Error('企微当前账号资料文件不存在，已停止企微消息采集')
  }
  let profile: unknown
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  } catch {
    throw new Error('企微当前账号资料文件无法解析，已停止企微消息采集')
  }

  const accountId = accountDirectoryId((profile as { user_info?: unknown } | null)?.user_info)
  const sourceRoot = join(wecomRoot, accountId, 'Data')
  const messageDatabase = join(sourceRoot, 'message.db')
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory() || !existsSync(messageDatabase) || !statSync(messageDatabase).isFile()) {
    throw new Error(`企微当前账号对应的数据目录不完整（目录编号 ${accountId}），已停止企微消息采集`)
  }

  return {
    profileId,
    accountDirectoryId: accountId,
    wecomRoot,
    sourceRoot,
    identityKey: `${profileId.toUpperCase()}\u001f${accountId}\u001f${sourceRoot.toLowerCase()}`
  }
}
