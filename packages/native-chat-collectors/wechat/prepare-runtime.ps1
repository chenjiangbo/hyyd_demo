param(
  [Parameter(Mandatory = $true)]
  [string]$PythonExe
)

$ErrorActionPreference = 'Stop'
$python = (Resolve-Path -LiteralPath $PythonExe).Path
$version = & $python --version 2>&1
if ($LASTEXITCODE -ne 0 -or $version -ne 'Python 3.12.10') {
  throw "微信采集运行时要求 Python 3.12.10 x64；当前解释器报告：$version"
}
$architecture = & $python -c "import struct; print(struct.calcsize('P') * 8)"
if ($LASTEXITCODE -ne 0 -or $architecture -ne '64') {
  throw "微信采集运行时要求 x64；当前解释器位数：$architecture"
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildRoot = Join-Path $scriptRoot '.runtime-build'
if (Test-Path -LiteralPath $buildRoot) {
  Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
& $python -m venv $buildRoot
if ($LASTEXITCODE -ne 0) { throw '创建微信采集构建环境失败' }
$buildPython = Join-Path $buildRoot 'Scripts\python.exe'
& $buildPython -m pip install --only-binary=:all: --no-cache-dir -r (Join-Path $scriptRoot 'requirements-windows.txt')
if ($LASTEXITCODE -ne 0) { throw '安装微信采集构建依赖失败' }
& $buildPython -c "import cryptography, zstandard; print('wechat collector build dependencies ready')"
if ($LASTEXITCODE -ne 0) { throw '微信采集构建依赖校验失败' }

$buildDirectory = Join-Path $buildRoot 'pyinstaller-build'
$distribution = Join-Path $buildRoot 'dist'
& (Join-Path $buildRoot 'Scripts\pyinstaller.exe') `
  --noconfirm --clean --onefile --name hyyd-wechat-collector `
  --paths (Join-Path $scriptRoot 'vendor') `
  --collect-all cryptography --collect-all zstandard `
  --workpath $buildDirectory --distpath $distribution `
  (Join-Path $scriptRoot 'collector.py')
if ($LASTEXITCODE -ne 0) { throw '微信无界面采集程序构建失败' }
$built = Join-Path $distribution 'hyyd-wechat-collector.exe'
if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw 'PyInstaller 未生成微信采集程序' }
Copy-Item -LiteralPath $built -Destination (Join-Path $scriptRoot 'hyyd-wechat-collector.exe') -Force
Remove-Item -LiteralPath $buildRoot -Recurse -Force
