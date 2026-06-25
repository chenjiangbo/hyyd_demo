// 只上传 capture-sidecar 源码并在 VM 上编译（arm64 自包含单文件），不碰 tray-app。
// 用于独立测试微信采集。复用 deploy-win 的 env。
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

const env = loadEnv();
const host = env.WIN_VM_HOST;
const port = parseInt(env.WIN_VM_PORT || '22', 10);
const username = env.WIN_VM_USERNAME;
const password = env.WIN_VM_PASSWORD;
const targetDir = env.WIN_VM_TARGET_DIR.replace(/\\/g, '/');

const srcDir = path.join(__dirname, '../packages/capture-sidecar');
const remoteSidecarDir = `${targetDir}/packages/capture-sidecar`;
// pnpm / dotnet 的 PATH 注入（与 deploy-win 一致）
const pathInjection = `$env:Path += ';C:/Users/${username}/AppData/Local/pnpm;C:/Users/${username}/AppData/Roaming/npm;C:/Program Files/nodejs;C:/Program Files/dotnet';`;

const conn = new Client();

function exec(command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      stream.on('data', (d) => process.stdout.write(d)).stderr.on('data', (d) => process.stderr.write(d));
      stream.on('close', (code) => resolve(code));
    });
  });
}

function putFile(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
  });
}

conn
  .on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) {
        console.error('SFTP 失败:', err.message);
        process.exit(1);
      }
      // 上传 capture-sidecar 顶层源码（跳过 bin/obj）
      const files = fs
        .readdirSync(srcDir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);
      console.log(`📤 上传 ${files.length} 个 sidecar 源文件到 VM…`);
      for (const f of files) {
        await putFile(sftp, path.join(srcDir, f), `${remoteSidecarDir}/${f}`);
        console.log('   ✓ ' + f);
      }

      // 先杀掉可能正在运行的 sidecar（独立自测进程会锁住 exe，导致构建删旧产物时 EPERM）
      console.log('🧹 [VM] 结束可能正在运行的 sidecar…');
      await exec('powershell -NoProfile -Command "taskkill /F /IM hyyd-capture-sidecar.exe /T 2>$null; exit 0"');

      console.log('\n🔨 [VM] dotnet publish（arm64 自包含单文件）…');
      const code = await exec(`powershell -NoProfile -Command "${pathInjection} cd '${targetDir}'; pnpm sidecar:build:win"`);
      conn.end();
      if (code !== 0) {
        console.error(`\n❌ 构建失败，退出码 ${code}`);
        process.exit(code);
      }
      const exe = `${targetDir}/packages/tray-app/resources/capture-sidecar/hyyd-capture-sidecar.exe`.replace(/\//g, '\\');
      console.log('\n✅ 构建完成。exe 路径（VM 上）：\n   ' + exe);
      console.log('\n独立测试：在 VM 上开 PowerShell 跑：');
      console.log(`   & "${exe}" --standalone`);
      console.log('然后激活微信/企微、打字、滚动；截图会落到 %LOCALAPPDATA%\\HyydCaptureSidecar\\frames\\<日期>\\');
    });
  })
  .on('error', (e) => {
    console.error('SSH 失败:', e.message);
    process.exit(1);
  })
  .connect({ host, port, username, password });
