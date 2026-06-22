# 运维手册 · SSH 登录 Windows 机器 & 发布应用

> **写作时间：2026-06-12**　面向：维护本项目的人 / AI。
> 配套：[`AI交接_当前状态_v2新UI与管理后台.md`](AI交接_当前状态_v2新UI与管理后台.md)（整体状态）、`TRAYAPP_AI_交接文档.md`（业务背景）。
> 一句话：tray-app 跑在一台 **Windows 机器**上，后端跑在 **Mac** 上；改完 tray 代码用 **`pnpm deploy:win`** 推过去，再在那台机器上跑起来验证。

---

## 1. 目标机器 & 拓扑

| | 当前值 | 说明 |
|---|---|---|
| Windows 机器 | **192.168.99.110 : 22**，用户 `chenj` | 荣耀笔记本，公司内网。凭证在**根 `.env` 的 `WIN_VM_*`**（不写进本文档） |
| 后端 | Mac，**192.168.99.165 : 13000** | 笔记本走内网访问。Mac 是 DHCP，IP 变了要改写死地址（见 §6） |
| MinIO | Mac，19000 | 附件/录音/图片 presigned URL |

> Windows 完整身份是 `zhijian\chenj`，但 **SSH 用户名只用 `chenj`**。
> 历史：之前目标是「Mac 上的 Windows VM」(`192.168.202.131`, ARM64)，现已迁到这台 x64 笔记本。`.env` 里的键名仍叫 `WIN_VM_*`（沿用，懒得改名）。

---

## 2. SSH 登录

### 2.1 手动连（在 Mac 终端）
```bash
ssh chenj@192.168.99.110
# 输入密码（见根 .env 的 WIN_VM_PASSWORD）
```
进去后是 **cmd** 提示符（OpenSSH 默认 shell）。跑 PowerShell：`powershell -NoProfile -Command "..."`。

### 2.2 脚本里连（Node ssh2，给 AI/自动化用）
`ssh2` 是根 `devDependencies`。**从仓库根目录**跑临时脚本（否则 require 找不到 ssh2）：
```js
// 存成 仓库根/tmp-ssh.cjs，跑完删掉
const { Client } = require('ssh2')
const fs = require('fs')
const env = Object.fromEntries(
  fs.readFileSync('.env','utf8').split('\n').filter(l=>l.includes('='))
    .map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')]})
)
const c = new Client()
function exec(cmd){return new Promise(res=>{c.exec(cmd,(e,s)=>{if(e)return res('ERR '+e.message);
  let o='';s.on('data',d=>o+=d);s.stderr.on('data',d=>o+=d);s.on('close',code=>res(o.trim()+' [exit '+code+']'))})})}
c.on('ready', async ()=>{
  console.log(await exec('cmd /c "echo %PROCESSOR_ARCHITECTURE% & node -v"'))
  c.end()
}).on('error',e=>console.log('SSH ERROR', e.message))
 .connect({
   host: env.WIN_VM_HOST, port: +env.WIN_VM_PORT||22,
   username: env.WIN_VM_USERNAME, password: env.WIN_VM_PASSWORD,
   readyTimeout: 60000           // ⚠️ 见 §5 限流，别用默认 20s
 })
```
```bash
cp tmp-ssh.cjs ./x.cjs && node ./x.cjs ; rm -f ./x.cjs   # 必须在仓库根跑
```

### 2.3 三条铁律（踩过的坑）
1. **别短时间狂连** → 触发 Windows OpenSSH 的 `MaxStartups` 限流，表现为 `Timed out while waiting for handshake`。连接间留间隔；`readyTimeout` 给 60–90s；必要时退避重试（等 20–30s 再试）。
2. **中文会 GBK 乱码**（`系统找不到指定的路径` 变 `ϵͳ�Ҳ���...`）。尽量用 ASCII 命令；要中文输出加 `chcp 65001>nul &`。
3. **长命令别依赖我的 SSH 连接稳定**：跑 `pnpm install` 这类长任务，连接一抖就装一半。要么本地跑，要么输出重定向到远端文件再读。

---

## 3. 发布应用：`pnpm deploy:win`

### 3.1 什么时候发
改了 **`packages/tray-app` / `packages/extension` / `shared-types` / `capture-sidecar`** 后。
**后端（`packages/backend`）改动不用发**——后端在 Mac 跑，笔记本走网络访问。

### 3.2 发之前先改版本号
每次把代码更新到 Windows 机器前，必须先递增相关版本号，避免现场机器看不出更新、Chrome 插件不触发自动更新。

- Chrome 插件：改 `packages/extension/public/manifest.json` 的 `version`，必须递增。
- 如果本次会重新打 Windows 安装包：同步改 `packages/tray-app/package.json` 的 `version`。
- 改完版本后，再执行 `pnpm deploy:win`、插件打包或安装包构建。

### 3.3 怎么发
```bash
# 在仓库根。建议后台跑，且【不要】 | tail（会把 install 日志丢掉，排错时看不到）
pnpm deploy:win
```
脚本 [`scripts/deploy-win.js`](../scripts/deploy-win.js) 依次做：
1. 本地 `tar` 打包源码（排除 `node_modules`/`dist`/`dist-artifacts`/`.windows-usb-work`/`debug`/`.claude`/`*.har`/`*.zip`/`.env`），上传到 `WIN_VM_TARGET_DIR`。
2. 远端解压 → `pnpm install`（下 electron + 编 better-sqlite3 等原生模块）。
3. 远端 `electron-vite build`（现加载 v2，产物 `out/renderer/index-v2.html`）+ 重建 extension + 重建 capture-sidecar（`dotnet publish`，需 .NET 8）。
4. `taskkill` 旧 electron/sidecar → detached 拉起 `pnpm tray:dev`。

### 3.4 ⚠️ 拉起常不留住 → 手动启动
脚本的 "detached 后台拉起" 在 VM 和笔记本上都**不稳**（部署成功但 app 没起来）。可靠做法是**在 Windows 机器本地终端**手动跑：
```
cd C:\Users\chenj\hyyd_demo
pnpm tray:dev
```
**保持终端开着**，约 15–20 秒出窗口。这条终端同时就是**实时日志**。

### 3.5 验证 app 起没起（SSH 查进程）
```
tasklist /FO CSV /FI "IMAGENAME eq electron.exe"
```
有 `electron.exe` 就是起来了；没有就去 §3.3 手动起、看终端报错。

---

## 4. 架构 / 首次装机要点

- **目标机架构**：用 `echo %PROCESSOR_ARCHITECTURE%` 确认。笔记本是 **AMD64(x64)**；旧 VM 是 **ARM64**。
- `deploy-win.js` 顶部 `archInjection` 控制原生模块按哪个 arch 编：
  - **x64 机器：留空 `const archInjection = ''`**（现状，原生默认即对）。
  - ARM64 机器：设 `$env:npm_config_arch='arm64'; ...`。
  - 装错 arch 会报 **`Error: Electron uninstall`** 或 `is not a valid Win32 application`。
- 新机器要装的：**OpenSSH Server（22 放行防火墙）/ Node ≥20 / pnpm 9.15.9（`packageManager` 锁定，corepack 装最准）/ .NET 8 SDK / Chrome**。详细命令见 `AI交接_当前状态_v2新UI与管理后台.md` 和聊天记录。

---

## 5. 常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Timed out while waiting for handshake` | 频繁 SSH 触发 sshd 限流 | 等 1–2 分钟，`readyTimeout` 调 60–90s，退避重试 |
| `Error: Electron uninstall` | electron 二进制缺失 / arch 不符 | ① 确认目标 arch 与 `archInjection` 一致；② electron 包没装全 → 在机器本地 `pnpm install` 完整跑一遍（别经不稳的 SSH） |
| `.pnpm/electron@x/node_modules/electron` 目录缺失 | `pnpm install` 被打断装一半 | 本地重跑 `pnpm install`；electron 在根 `node_modules/electron`（shamefully-hoist） |
| `dotnet not found` | 没装 .NET 8 SDK | 装 .NET 8 SDK（capture-sidecar 用 net8.0） |
| 上传包巨大 / Mac 磁盘满 (`ENOSPC`) | 排除清单漏了大目录 | 已加 `dist-artifacts/.windows-usb-work/debug/.claude/*.har/*.zip` 到排除；清 Mac 磁盘 |
| 部署"成功"但 app 没窗口 | detached 拉起没留住 | §3.3 本地手动 `pnpm tray:dev` |
| 中文输出乱码 | GBK | `chcp 65001` 或只用 ASCII 命令 |
| 后台命令日志只剩几行 | 部署命令被 `\| tail -N` 截断 | 别加 tail；要 tail 就 `tee` 到文件 |

---

## 6. 换机器 / Mac IP 变了：要改的写死地址

迁到新 Windows 机器，改根 `.env` 的 `WIN_VM_HOST/USERNAME/PASSWORD/TARGET_DIR`。
Mac 后端 IP 变了（DHCP），改这几处（都是旧值 → Mac 当前内网 IP）：

| 文件:行 | 改什么 |
|---|---|
| `packages/tray-app/src/renderer/src/v2/api.ts` `BACKEND_URL` | tray 连后端的地址（如 `http://192.168.99.165:13000`） |
| `packages/backend/.env` `MINIO_PUBLIC_HOST` | presigned URL 主机（否则附件/图片/录音裂） |
| `scripts/deploy-win.js` `archInjection` | 目标机 arch（x64 留空 / arm64 设值） |

> 强烈建议在路由器给 **Mac 绑固定内网 IP**，否则它一变，上面 tray/MinIO 地址全失效。

---

## 7. 速查命令

```bash
# 发布（仓库根）
pnpm deploy:win                       # 改 tray/extension 后

# 机器上手动起 app（在 Windows 终端，最可靠）
cd C:\Users\chenj\hyyd_demo && pnpm tray:dev

# SSH 查 app 进程
ssh chenj@192.168.99.110 'tasklist /FO CSV /FI "IMAGENAME eq electron.exe"'

# 验后端连通（从机器上）
ssh chenj@192.168.99.110 'powershell -NoProfile -Command "(Invoke-WebRequest http://192.168.99.165:13000/health -UseBasicParsing).StatusCode"'
```

---

## 8. 后端发布到 Aliyun ECS（生产环境，docker compose）

> 上面 §1–§7 讲的是**本地开发**拓扑（后端在 Mac、tray 在 Windows）。**生产/演示环境**后端跑在 **Aliyun ECS** 上，用 docker compose。
> 录音转写（Fun-ASR）必须用这套——它要阿里云公网下载 MinIO 录音，本地 Mac 的内网 MinIO 阿里云够不到。

### 8.1 机器 & 拓扑

| | 值 | 说明 |
|---|---|---|
| ECS | `ssh aliyun`（root@47.95.14.233，别名在 `~/.ssh/config`） | CentOS 8 |
| 项目目录 | `/opt/hyyd_demo` | docker compose 项目名 `hyyd` |
| 后端 | 公网 `47.95.14.233:9093` → 容器内 13000 | 手机/托盘/插件填这个地址 |
| MinIO | 公网 `47.95.14.233:9094` → 容器内 9000 | `MINIO_PUBLIC_HOST=47.95.14.233`，**公网可达 = Fun-ASR 能拉录音** |
| Postgres | 仅 `127.0.0.1:15432`（不公开） | |
| 配置 | `/opt/hyyd_demo/.env.production`（root 私有，**不在 git 里**） | Postgres/MinIO 密码、`DASHSCOPE_API_KEY`、Gateway 凭证等 |
| LLM Gateway | 同机 `blackwhite-ai-gateway`，compose 网络里叫 `http://ai-gateway:8080` | |

> ⚠️ 同一台 ECS 还跑着 blackwhite / realeasy 等别的 compose 项目。发布只动 `hyyd` 这个 project，别 `docker compose down` 整机。

### 8.2 发布/更新步骤（在 Mac 跑）

后端镜像由 `Dockerfile` 在 ECS 本地构建，只依赖 `packages/{backend,admin-web,shared-types}` + 根 `package.json/pnpm-lock/workspace`，**不碰 tray-app/sidecar**。代码经 GitHub 同步（ECS 能连 github）。

```bash
# 0. 本地：先把要上线的后端改动提交并推送到 main
git push origin main

# 1. ECS：备份（迁移是加列/加索引的增量改动，不删数据，但留还原点）
ssh aliyun 'cd /opt/hyyd_demo; TS=$(date +%Y%m%d-%H%M%S);
  cp .env.production /root/hyyd-env.production.bak-$TS;
  docker exec hyyd-huanyu-postgres-1 sh -lc "pg_dump -U huanyu huanyu" > /root/hyyd-db-backup-$TS.sql'

# 2. ECS：拉最新代码（.env.production 不在 git 里，reset --hard 不会动它）
ssh aliyun 'cd /opt/hyyd_demo && git fetch origin && git reset --hard origin/main'

# 3. ECS：重建后端镜像 + 重启（compose 启动命令会自动跑 prisma migrate deploy）
ssh aliyun 'cd /opt/hyyd_demo && docker compose --env-file .env.production up -d --build huanyu-backend'
```

> 首次给 ECS 的 git 加白名单：`git config --global --add safe.directory /opt/hyyd_demo`。

### 8.3 验证

```bash
# 健康检查（公网）
curl -s http://47.95.14.233:9093/health

# 容器状态 + 迁移登记 + 启动日志
ssh aliyun 'docker ps --filter name=hyyd- --format "{{.Names}}\t{{.Status}}"'
ssh aliyun 'docker exec hyyd-huanyu-postgres-1 sh -lc "psql -U huanyu -d huanyu -t -c \"SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;\""'
ssh aliyun 'docker logs --tail 20 hyyd-huanyu-backend-1'
```

### 8.4 端到端验录音转写

1. 手机 / 托盘 / sidecar 的后端地址都改成 `http://47.95.14.233:9093`。
2. 手机上传录音 → 进 ECS MinIO（公网 9094）→ 后端触发 Fun-ASR → 阿里云公网拉取转写 → 完成后写回 `asrText` 并触发该订单简报。
3. 查录音是否真上来：`ssh aliyun 'docker exec hyyd-huanyu-minio-1 sh -lc "mc alias set l http://localhost:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD >/dev/null; mc ls --recursive l/recordings"'`

### 8.5 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `dubious ownership in repository` | git 安全检查 | `git config --global --add safe.directory /opt/hyyd_demo` |
| 录音一直"待转写"、桶里没文件 | 客户端后端地址指向了别的（如 Mac 内网） | 把手机/托盘后端地址改成 `47.95.14.233:9093` |
| 录音上来了但转写不完成 | `MINIO_PUBLIC_HOST` 不是公网 IP，阿里云拉不到 | 确认 `.env.production` 里是 `47.95.14.233` |
| 改了 compose 变量不生效 | 没带 `--env-file` | compose 命令都要 `--env-file .env.production` |
| 回滚 | 镜像/迁移出问题 | 用 `/root/hyyd-db-backup-*.sql` 还原库，`git reset --hard <旧commit>` 重建 |
