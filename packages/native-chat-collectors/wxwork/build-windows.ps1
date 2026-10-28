$ErrorActionPreference = 'Stop'
$collectorRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspace = Join-Path $collectorRoot 'vendor\upstream'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw '未找到 Visual Studio Installer 的 vswhere.exe，无法配置企微采集器的 MSVC 构建环境。' }
$vsInstall = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $vsInstall) { throw '未找到带有 MSVC x64 C++ 工具链的 Visual Studio 安装。' }
$vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw "未找到 MSVC 环境脚本：$vcvars" }
$vcvarsOutput = & $env:ComSpec /d /s /c "`"$vcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw '配置 MSVC x64 构建环境失败。' }
foreach ($line in $vcvarsOutput) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) {
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe') -PathType Leaf)) { throw '未找到 Rust Cargo 工具链。' }
$env:PATH = "$cargoBin;$env:PATH"
Push-Location $workspace
try {
  cargo build --locked --release --target x86_64-pc-windows-msvc --bin HyydWxWorkCollector
  if ($LASTEXITCODE -ne 0) { throw '企微无界面采集程序构建失败' }
  $built = Join-Path $workspace 'target\x86_64-pc-windows-msvc\release\HyydWxWorkCollector.exe'
  if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw 'Cargo 未生成企微采集程序' }
  Copy-Item -LiteralPath $built -Destination (Join-Path $collectorRoot 'hyyd-wxwork-collector.exe') -Force
} finally {
  Pop-Location
}
