// 在 Windows VM 上构建 tray-app 安装包（NSIS .exe）。
// 假设 deploy-win 已经把最新源码推上去并跑过 pnpm install。
// 仅做 build：electron-vite build + electron-builder --win。
// 完事打印新生成的 setup.exe 路径，方便从 VM 拷出来给员工装。

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

// ─── 复用 deploy-win 的 env 加载 ──────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ 找不到根目录 .env');
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    env[k] = v;
  }
  return env;
}

const env = loadEnv();
const host = env.WIN_VM_HOST;
const port = parseInt(env.WIN_VM_PORT || '22', 10);
const username = env.WIN_VM_USERNAME;
const password = env.WIN_VM_PASSWORD;
const targetDir = env.WIN_VM_TARGET_DIR.replace(/\\/g, '/');

if (!host || !username || !password || !targetDir) {
  console.error('❌ .env 缺少 WIN_VM_* 配置');
  process.exit(1);
}

function pwsh(cmd) {
  // 用 powershell -Command 包一层，避免 cmd 转义地狱
  return `powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`;
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream
        .on('data', (data) => {
          const s = data.toString();
          stdout += s;
          process.stdout.write(s);
        })
        .stderr.on('data', (data) => {
          const s = data.toString();
          stderr += s;
          process.stderr.write(s);
        });
      stream.on('close', (code) => {
        if (code !== 0) return reject(new Error(`命令退出 code=${code}\n${stderr}`));
        resolve(stdout);
      });
    });
  });
}

async function main() {
  const conn = new Client();
  await new Promise((res, rej) => {
    conn.on('ready', res).on('error', rej).connect({ host, port, username, password });
  });
  console.log(`📡 已连接 ${host}\n`);

  // 1. 构建 installer（electron-vite build + electron-builder --win）
  // 直接 cd 到项目根，电子构建工具会按 packages/tray-app/electron-builder.yml 出 NSIS
  console.log('🔨 [VM] 开始构建 tray-app installer（pnpm --filter tray-app build:win）...');
  console.log('   预计 2-4 分钟，请耐心等待。\n');
  await exec(
    conn,
    pwsh(`cd '${targetDir}'; pnpm --filter tray-app build:win`)
  );

  // 2. 列出生成的 .exe，给路径 + 大小
  console.log('\n📦 [VM] 构建产物：');
  const distOut = await exec(
    conn,
    pwsh(
      `Get-ChildItem -Path '${targetDir}/packages/tray-app/dist/*.exe' | ` +
        `Select-Object FullName, @{N='Size_MB';E={[math]::Round($_.Length/1MB,1)}}, LastWriteTime | Format-List`
    )
  );
  void distOut;

  conn.end();
  console.log('\n✅ 完成。把上面 FullName 那个 .exe 拷出来给员工装即可。');
  console.log('   建议先在 VM 上卸载旧版（控制面板 → 卸载程序），再装新的。');
}

main().catch((e) => {
  console.error('❌ 构建失败:', e.message);
  process.exit(1);
});
