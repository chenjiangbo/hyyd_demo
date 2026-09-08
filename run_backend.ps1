$env:DATABASE_URL = "postgresql://huanyu:huanyu_dev_pwd@127.0.0.1:5432/huanyu?schema=public"
$nodeExe = Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"
& $nodeExe "d:\hyyd\local_test_server.cjs"
