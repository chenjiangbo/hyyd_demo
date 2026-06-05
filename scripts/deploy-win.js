const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require('ssh2');

// 1. 无依赖加载根目录下的 .env 文件
function loadEnv() {
  const envPath = path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ [ERROR] 找不到根目录下的 .env 配置文件，请复制 .env.example 并配置您的 Windows VM 信息。');
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, 'utf8');
  const config = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;
    const key = trimmed.substring(0, index).trim();
    const val = trimmed.substring(index + 1).trim().replace(/^['"]|['"]$/g, '');
    config[key] = val;
  });
  return config;
}

const env = loadEnv();
const host = env.WIN_VM_HOST;
const port = parseInt(env.WIN_VM_PORT || '22', 10);
const username = env.WIN_VM_USERNAME;
const password = env.WIN_VM_PASSWORD;
// 统一将反斜杠转换为正斜杠，避开 Windows cmd/ssh 双重转义地狱
const targetDir = env.WIN_VM_TARGET_DIR.replace(/\\/g, '/');

// 注入用户环境变量路径和 Electron 极速淘宝镜像，保障 Windows 端 Node 环境和大文件下载 100% 顺畅
const vlmInjection = [
  'HYYD_VLM_BASE_URL',
  'HYYD_VLM_API_KEY',
  'HYYD_VLM_MODEL',
  'GATEWAY_BASE_URL',
  'GATEWAY_APP_ID',
  'GATEWAY_API_KEY'
]
  .filter((key) => env[key])
  .map((key) => ` $env:${key}='${String(env[key]).replace(/'/g, "''")}';`)
  .join('');
const pathInjection = `$env:Path += ';C:/Users/${username}/AppData/Local/pnpm;C:/Users/${username}/AppData/Roaming/npm;C:/Program Files/nodejs'; $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/';${vlmInjection}`;

if (!host || !username || !password || !targetDir) {
  console.error('❌ [ERROR] .env 配置文件缺少关键部署参数 (WIN_VM_HOST, WIN_VM_USERNAME, WIN_VM_PASSWORD, WIN_VM_TARGET_DIR)');
  process.exit(1);
}

for (const key of ['HYYD_VLM_BASE_URL', 'HYYD_VLM_API_KEY', 'HYYD_VLM_MODEL']) {
  if (!env[key]) {
    console.error(`❌ [ERROR] .env 配置文件缺少必需采集参数 ${key}`);
    process.exit(1);
  }
}

// 2. 本地打包源码
const archiveName = 'temp_project.tar.gz';
const archivePath = path.join(__dirname, `../${archiveName}`);

function packLocally() {
  console.log('📦 [1/5] [Mac] 正在增量打包源码项目...');
  try {
    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }
    
    // 排除所有的 node_modules、.git、打包产物及临时文件，大幅度缩减上传包大小
    const excludePatterns = [
      'node_modules',
      '.git',
      '.idea',
      '.vscode',
      '.gemini',
      '._*',
      '**/._*',
      'dist',
      'packages/*/node_modules',
      'packages/*/dist',
      archiveName,
      '*.log'
    ];
    
    const excludeFlags = excludePatterns.map(p => `--exclude="${p}"`).join(' ');
    const cmd = `tar -czf "${archivePath}" ${excludeFlags} .`;
    
    execSync(cmd, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1'
      }
    });
    console.log(`✅ [Mac] 打包成功，生成归档包: ${archiveName} (${(fs.statSync(archivePath).size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.error('❌ [ERROR] 本地打包源码失败:', err.message);
    process.exit(1);
  }
}

// 3. 建立 SSH 远程连接并执行流水线
const conn = new Client();

conn.on('ready', () => {
  console.log('📡 [2/5] [SSH] 已成功连接到 Windows 虚拟机！');
  
  // 诊断：输出 Windows 系统当前的 %PATH%，查明 node/pnpm 到底在不在里面
  conn.exec('cmd /c "echo %path%"', (err, stream) => {
    if (!err) {
      stream.on('data', (data) => {
        console.log('\n🔍 [DIAGNOSTIC] Windows 系统的 PATH 环境变量为:');
        console.log(data.toString().trim());
        console.log('==================================================\n');
      });
    }
  });

  // 诊断 2：测试 Windows 网络是否能连上淘宝镜像并下载 Electron ARM64 包，查明是否网络阻碍
  const netTestCmd = `powershell -Command "try { $start = Get-Date; Invoke-WebRequest -Uri 'https://npmmirror.com/mirrors/electron/31.0.0/electron-v31.0.0-win32-arm64.zip' -OutFile 'test_elec.zip' -TimeoutSec 10; $end = Get-Date; $size = (Get-Item test_elec.zip).Length; Remove-Item test_elec.zip; echo '📶 [NET TEST] 下载成功! 大小: ' + ($size/1024/1024).ToString('F2') + ' MB, 耗时: ' + ($end - $start).TotalSeconds.ToString('F2') + ' 秒' } catch { echo '❌ [NET TEST] 下载失败: ' + $_.Exception.Message }"`;
  conn.exec(netTestCmd, (err, stream) => {
    if (!err) {
      stream.on('data', (data) => {
        console.log('🔍 [DIAGNOSTIC] ' + data.toString().trim());
      });
    }
  });
  
  // 3.1 确保目标文件夹在 Windows 上存在
  console.log(`📂 [SSH] 正在确保 Windows 目标路径存在: ${targetDir}`);
  // 使用单引号包裹正斜杠路径，在 PowerShell 中最健壮，避开所有双引号转义问题
  const mkdirCmd = `powershell -Command "if (!(Test-Path '${targetDir}')) { New-Item -ItemType Directory -Force -Path '${targetDir}' }"`;
  
  conn.exec(mkdirCmd, (err, stream) => {
    if (err) {
      console.error('❌ [SSH] 创建远程目录指令发送失败:', err.message);
      cleanupAndExit(1);
      return;
    }
    
    // 监听输出，防止缓冲区堵塞导致挂起，并方便抓取报错
    stream.on('data', (data) => {
      console.log(`[SSH stdout] ${data.toString().trim()}`);
    }).stderr.on('data', (data) => {
      console.error(`[SSH stderr] ${data.toString().trim()}`);
    });
    
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ [SSH] 在 Windows 上创建目录失败，退出码: ${code}`);
        cleanupAndExit(1);
        return;
      }
      
      // 3.2 先清理旧 Electron / sidecar 进程，避免文件锁和单实例锁影响本次发布。
      stopRemoteDesktopProcesses(uploadArchive);
    });
  });
}).on('error', (err) => {
  console.error('❌ [SSH] 连接 Windows 虚拟机失败，请确认 VM IP/账号/密码是否正确，且 SSH 服务已开启放行防火墙。');
  console.error(`原因: ${err.message}`);
  cleanupAndExit(1);
}).connect({
  host,
  port,
  username,
  password
});

function stopRemoteDesktopProcesses(next) {
  console.log('🛑 [SSH] 正在停止旧 Electron / 采集 sidecar 进程...');
  const taskkillCmd = `powershell -Command "taskkill /F /IM electron.exe /T 2>$null; taskkill /F /IM tray-app.exe /T 2>$null; taskkill /F /IM hyyd-capture-sidecar.exe /T 2>$null; exit 0"`;
  conn.exec(taskkillCmd, (err, stream) => {
    if (err) {
      console.error('❌ [SSH] 发送 taskkill 指令出错:', err.message);
      cleanupAndExit(1);
      return;
    }
    stream.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[SSH stdout] ${text}`);
    }).stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.error(`[SSH stderr] ${text}`);
    });
    stream.on('close', () => {
      console.log('✅ [SSH] 旧桌面进程清理完成');
      next();
    });
  });
}

// SFTP 上传归档包
function uploadArchive() {
  console.log('🚀 [3/5] [SFTP] 正在向 Windows 高速上传源码压缩包...');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('❌ [SFTP] 无法建立 SFTP 会话:', err.message);
      cleanupAndExit(1);
      return;
    }
    
    // 替换为正斜杠路径上传
    const remoteArchivePath = `${targetDir}/${archiveName}`;
    
    sftp.fastPut(archivePath, remoteArchivePath, {}, (putErr) => {
      if (putErr) {
        console.error('❌ [SFTP] 上传文件失败:', putErr.message);
        cleanupAndExit(1);
        return;
      }
      console.log('✅ [SFTP] 源码压缩包上传完成！');
      
      // 3.3 远程解压缩并删除临时压缩包
      extractRemoteArchive();
    });
  });
}

// 远程解包
function extractRemoteArchive() {
  console.log('🔓 [4/5] [SSH] 正在 Windows 上解压源码包并清理临时文件...');
  
  // 在 Windows 远程解压命令：转到目标路径，执行 tar 提取，之后删除 tar 包
  const extractCmd = `powershell -Command "cd '${targetDir}'; tar -xf ${archiveName}; Remove-Item -Force ${archiveName}; Get-ChildItem -Path . -Recurse -Force -Filter '._*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue"`;
  
  conn.exec(extractCmd, (err, stream) => {
    if (err) {
      console.error('❌ [SSH] 发送远程解压指令出错:', err.message);
      cleanupAndExit(1);
      return;
    }
    
    // 监听输出，防止缓冲区堵塞导致挂起
    stream.on('data', (data) => {
      console.log(`[SSH stdout] ${data.toString().trim()}`);
    }).stderr.on('data', (data) => {
      console.error(`[SSH stderr] ${data.toString().trim()}`);
    });
    
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ [SSH] 远程解压缩失败，退出码: ${code}`);
        cleanupAndExit(1);
        return;
      }
      console.log('✅ [SSH] 源码解包与覆盖完成！');
      
      // 3.4 远程自动安装依赖
      installRemoteDependencies();
    });
  });
}

// 远程 pnpm install 编译 Windows 原生依赖
function installRemoteDependencies() {
  console.log('⚙️ [5/5] [SSH] 正在 Windows 本地检测并确保已安装成熟稳健的 pnpm@9...');
  
  // 强行安装 pnpm@9 版本，彻底从根源上避开 pnpm 10/11 极度繁杂且无法自动跳过的交互式供应链政策审核卡死问题
  const checkAndInstallPnpmCmd = `powershell -Command "${pathInjection} npm install -g pnpm@9"`;
  
  conn.exec(checkAndInstallPnpmCmd, (err, stream) => {
    if (err) {
      console.error('❌ [SSH] 发送 pnpm 检测/安装指令出错:', err.message);
      cleanupAndExit(1);
      return;
    }
    
    stream.on('data', (data) => {
      process.stdout.write(data);
    }).stderr.on('data', (data) => {
      process.stderr.write(data);
    });
    
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ [SSH] 确保 pnpm 安装失败，退出码: ${code}`);
        cleanupAndExit(1);
        return;
      }
      
      console.log('⚙️ [SSH] 正在 Windows 本地执行依赖安装与原生编译 (pnpm install)...');
      const installCmd = `powershell -Command "${pathInjection} cd '${targetDir}'; pnpm install"`;
      
      conn.exec(installCmd, (installErr, installStream) => {
        if (installErr) {
          console.error('❌ [SSH] 发送远程依赖安装指令出错:', installErr.message);
          cleanupAndExit(1);
          return;
        }
        
        installStream.on('data', (data) => {
          process.stdout.write(data);
        }).stderr.on('data', (data) => {
          process.stderr.write(data);
        });
        
        installStream.on('close', (installCode) => {
          if (installCode !== 0) {
            console.error(`❌ [SSH] 远程依赖安装失败，退出码: ${installCode}`);
            cleanupAndExit(1);
            return;
          }
          
          console.log('⚙️ [SSH] 正在使用国内高速镜像强制运行 Electron 二进制安装脚本 (node install.js)...');
          const rebuildCmd = `powershell -Command "${pathInjection} cd '${targetDir}/packages/tray-app/node_modules/electron'; node install.js"`;
          
          conn.exec(rebuildCmd, (rebuildErr, rebuildStream) => {
            if (rebuildErr) {
              console.error('❌ [SSH] 发送 Electron 重建指令出错:', rebuildErr.message);
              cleanupAndExit(1);
              return;
            }
            
            rebuildStream.on('data', (data) => {
              process.stdout.write(data);
            }).stderr.on('data', (data) => {
              process.stderr.write(data);
            });
            
            rebuildStream.on('close', (rebuildCode) => {
              if (rebuildCode !== 0) {
                console.error(`❌ [SSH] Electron 重建失败，退出码: ${rebuildCode}`);
                cleanupAndExit(1);
                return;
              }
              
              console.log('✅ [SSH] 依赖包原生编译与 Electron 重建安装全部完成！');

              // 3.4.4 构建 Chrome 插件 (extension/dist)。
              // 部署归档排除了所有 dist 目录，所以必须在 Windows 端重新构建，
              // 否则 Chrome 加载的还是上一次的旧 bundle。
              console.log('🔨 [SSH] 正在 Windows 端构建 Chrome 插件 (pnpm --filter @hyyd/extension build)...');
              const extBuildCmd = `powershell -Command "${pathInjection} cd '${targetDir}'; pnpm --filter @hyyd/extension build"`;
              conn.exec(extBuildCmd, (extErr, extStream) => {
                if (extErr) {
                  console.warn('⚠️ [SSH] 触发 extension 构建失败（不阻塞主流程）:', extErr.message);
                  proceedBuildSidecar();
                  return;
                }
                extStream.on('data', (d) => process.stdout.write(d));
                extStream.stderr.on('data', (d) => process.stderr.write(d));
                extStream.on('close', (code) => {
                  if (code !== 0) {
                    console.warn(`⚠️ [SSH] extension 构建退出码 ${code}（不阻塞主流程）`);
                  } else {
                    console.log('✅ [SSH] Chrome 插件构建完成，请在浏览器 chrome://extensions 点"刷新"按钮');
                  }
                  proceedBuildSidecar();
                });
              });

              function proceedBuildSidecar() {
                console.log('🔨 [SSH] 正在 Windows 端构建采集 sidecar (pnpm sidecar:build:win)...');
                const sidecarBuildCmd = `powershell -Command "${pathInjection} cd '${targetDir}'; pnpm sidecar:build:win"`;
                conn.exec(sidecarBuildCmd, (sidecarErr, sidecarStream) => {
                  if (sidecarErr) {
                    console.error('❌ [SSH] 触发 sidecar 构建失败:', sidecarErr.message);
                    cleanupAndExit(1);
                    return;
                  }
                  sidecarStream.on('data', (d) => process.stdout.write(d));
                  sidecarStream.stderr.on('data', (d) => process.stderr.write(d));
                  sidecarStream.on('close', (code) => {
                    if (code !== 0) {
                      console.error(`❌ [SSH] sidecar 构建失败，退出码: ${code}`);
                      cleanupAndExit(1);
                      return;
                    }
                    console.log('✅ [SSH] 采集 sidecar 构建完成');
                    proceedNormalizePath();
                  });
                });
              }

              function proceedNormalizePath() {
              // 3.4.5 归一化 Electron 的 path.txt
              // 已知坑：某些 Electron 版本在 Windows-on-ARM 上 install.js 会把
              // path.txt 写成 "dist/electron.exe\r\n"，而 Electron 自身的
              // getElectronPath() 会再拼一次 "dist/"，导致路径变成
              // dist/dist/electron.exe\r\n —— ENOENT。
              // 此处强制覆写为单行 "electron.exe"（无换行符）。
              console.log('🔧 [SSH] 归一化 Electron path.txt，避免 dist/dist 拼接 BUG...');
              const normalizePathTxtCmd = `powershell -Command "${pathInjection} $p = Get-ChildItem -Path '${targetDir}/node_modules/.pnpm' -Filter 'electron@*' -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'node_modules/electron/path.txt' } | Where-Object { Test-Path $_ }; foreach ($f in $p) { [System.IO.File]::WriteAllText($f, 'electron.exe'); echo ('修复: ' + $f) }"`;

              conn.exec(normalizePathTxtCmd, (npErr, npStream) => {
                if (npErr) {
                  console.warn('⚠️ [SSH] 归一化 path.txt 命令发送失败（不阻塞）:', npErr.message);
                  proceedDiagnostic();
                  return;
                }
                npStream.on('data', d => process.stdout.write(d));
                npStream.stderr.on('data', d => process.stderr.write(d));
                npStream.on('close', () => {
                  console.log('✅ [SSH] path.txt 已归一化');
                  proceedDiagnostic();
                });
              });

              function proceedDiagnostic() {
              // 诊断：打印 Windows 端 node_modules/electron 下的所有文件，查明为何 getElectronPath 报错
              console.log('\n🔍 [DIAGNOSTIC] 正在检查 Windows 端 node_modules/electron 目录下的文件列表...');
              const checkDirCmd = `powershell -Command "Get-ChildItem -Path '${targetDir}/node_modules/electron' -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"`;
              conn.exec(checkDirCmd, (cErr, cStream) => {
                if (!cErr) {
                  cStream.on('data', (cData) => {
                    console.log(cData.toString().trim());
                  });
                  cStream.on('close', () => {
                    console.log('==================================================\n');
                    // 3.5 启动应用并实时拉取日志
                    runRemoteApplication();
                  });
                } else {
                  runRemoteApplication();
                }
              });
              } // end proceedDiagnostic
              } // end proceedNormalizePath
            });
          });
        });
      });
    });
  });
}

// 远程启动应用并实时回传日志管道
let remoteProcessStream = null;

function runRemoteApplication() {
  // 先杀掉残留的 electron 进程，避免 SingletonLock (Error code: 32) 导致新实例起不来。
  // 已知坑：上一个 tray app 没退干净时，新进程会因为锁文件冲突直接退出。
  console.log('🧹 [SSH] 清理 Windows 上残留的 electron 进程...');
  const killCmd = `powershell -Command "taskkill /F /IM electron.exe /T 2>$null; exit 0"`;
  conn.exec(killCmd, (killErr, killStream) => {
    if (killErr) {
      console.warn('⚠️ [SSH] 发送 taskkill 指令失败（不阻塞）:', killErr.message);
      launchApp();
      return;
    }
    killStream.on('data', (d) => process.stdout.write(`[taskkill] ${d.toString().trim()}\n`));
    killStream.stderr.on('data', () => {/* 没有进程时会报错，忽略 */});
    killStream.on('close', () => {
      console.log('✅ [SSH] 旧 electron 进程已清理');
      launchApp();
    });
  });
}

function launchApp() {
  console.log('\n✨ ================================================== ✨');
  console.log('🚀 [SSH] 在 Windows 上以独立进程(detached)拉起客户端 (pnpm tray:dev)...');
  console.log('ℹ️  [LOGGER] 不再 tail 远程日志：启动命令会立即返回，app 在 VM 上后台继续运行。');
  console.log('✨ ================================================== ✨\n');

  // 用 Start-Process 起一个独立进程：命令立即返回，关闭 SSH 连接后 app 仍继续运行，
  // 避免之前“脚本挂着 tail 日志一直不返回、误以为卡住而提前手动重启”的连锁问题。
  const startProcess =
    `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c pnpm tray:dev' ` +
    `-WorkingDirectory '${targetDir}' -WindowStyle Hidden`;
  const runCmd = `powershell -Command "${pathInjection} ${startProcess}"`;

  conn.exec(runCmd, (err, stream) => {
    if (err) {
      console.error('❌ [SSH] 远程启动应用命令发送失败:', err.message);
      cleanupAndExit(1);
      return;
    }

    stream.on('data', (data) => process.stdout.write(data));
    stream.stderr.on('data', (data) => process.stderr.write(data));

    stream.on('close', () => {
      console.log('\n✅ [SSH] 客户端已在 VM 后台启动（detached），本次部署到此返回。');
      console.log('   · app 需要约 10~20 秒构建后才会出现窗口/托盘图标，请稍候。');
      console.log('   · 如需查看实时日志，可在 VM 上手动运行：pnpm tray:dev');
      cleanupAndExit(0);
    });
  });
}

// 优雅退出与清理
function cleanupAndExit(exitCode = 0) {
  // 清理 Mac 本地产生的临时 tar.gz
  try {
    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }
  } catch (e) {}
  
  // 关闭 SSH 连接
  try {
    conn.end();
  } catch (e) {}
  
  console.log('👋 [DevOps] 本地与远程状态清理完毕，退出。');
  process.exit(exitCode);
}

// 捕获 Ctrl + C (SIGINT)，确保优雅杀死 Windows 端服务并退出
process.on('SIGINT', () => {
  console.log('\n\n🧹 [SIGINT] 捕获到退出信号，正在切断 SSH 连接并通知 Windows 退出远程进程...');
  
  if (remoteProcessStream) {
    try {
      // 向远程流发送终止信号，或者直接关闭 SSH 连接，Windows sshd 会随之清理关联的 Job 进程
      remoteProcessStream.close();
    } catch (e) {}
  }
  
  cleanupAndExit(0);
});

// 执行打包入口
packLocally();
