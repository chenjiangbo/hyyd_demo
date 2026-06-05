# Huanyu Med MVP -- Windows Auto-Deployment & Monitoring Documentation

In order to achieve high-efficiency cross-platform development where the Mac host runs core coding and the Windows VM runs the Electron client and WeChat message collection, this project is built with a one-click automatic deployment and real-time log pushing pipeline.

This document records the architecture, working principle, configuration, and guide for this system, so that subsequent AI Coder tools or developers can seamlessly understand and reuse it.

---

## 1. Why do we need this automation?

When developing desktop clients or Windows-specific modules, direct folder sharing (like Samba or VM Shared Folders) or manual copying causes fatal issues:
1. Native Addons Crash: node_modules installed on Mac contain macOS native binaries. If shared and run on Windows directly, the app crashes immediately due to architecture mismatch.
2. Low Efficiency: Every modification requires manual packaging or copying, and looking at logs in the VM console splits the developer experience.

---

## 2. Architecture & Working Principle

This system is built upon Mac Node.js (ssh2) -> Windows Remote SSH Control. The entire process requires only one single command: pnpm deploy:win.

```
[1. Mac Host] ---> A. Pack Source Code ---> [project.tar.gz Archive]
   |
   +---> B. SFTP High Speed Transmission ---> [2. Windows VM]
   |
   +---> C. Send SSH Commands --------------> [2. Windows VM]
                                                 |
                                                 +---> D. Extract Code (tar -xf)
                                                 +---> E. Local pnpm install (Windows Native modules)
                                                 +---> F. Run pnpm tray:dev
                                                 +---> G. Pipe logs back to Mac console (Real-time Logger)
```

### Core Logics:
1. Packing: The Mac host uses Node.js to execute local tar tool, automatically excluding node_modules, .git, dist, and packaging only source code into project.tar.gz (usually takes milliseconds).
2. SSH/SFTP Channel: Connecting to Windows VM SSH server using WIN_VM_* environment credentials.
3. SFTP Upload: Transferring the archive to the VM destination folder.
4. Remote Extraction: Extracting the zip using native tar -xf command on Windows, overriding existing files.
5. Old Process Cleanup: Before overwriting and rebuilding, the script runs `taskkill` for `electron.exe`, `tray-app.exe`, and `hyyd-capture-sidecar.exe`. This prevents file locks, stale single-instance locks, and an old sidecar from surviving into the next run.
6. Windows Native Build: Running pnpm install inside Windows. This guarantees that native dependencies (like Electron binaries, sqlite3, etc.) are built for Windows architecture.
7. Sidecar Build: Running `pnpm sidecar:build:win` inside Windows. The build script picks `win-arm64` or `win-x64` from the VM architecture and writes `hyyd-capture-sidecar.exe` into `packages/tray-app/resources/capture-sidecar`.
8. Runtime Env Injection: The deploy script injects required VLM variables from root `.env`. The sidecar path is not an environment variable; Tray App resolves it from `resources/capture-sidecar/hyyd-capture-sidecar.exe`.
9. Real-time Logger: Pipelining standard outputs (stdout/stderr) of electron process back to the Mac console, providing unified output log.

---

## 3. Environment & Configurations

This needs to be configured once before development:

### 3.1 Windows VM Configuration
1. Install Node.js (>=20.x recommended).
2. Install Git.
3. Start and enable OpenSSH Server on Windows:
   Run PowerShell as Administrator, and execute:
   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Start-Service sshd
   Set-Service -Name sshd -StartupType 'Automatic'
   # Open firewall port 22
   New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
   ```
4. Find the VM IP address, username, and password.

### 3.2 Mac Host Configuration
Create a .env file in the workspace root directory (already added to .gitignore):

```env
# Windows VM SSH Deployment Configurations
WIN_VM_HOST=192.168.202.128          # Windows VM IP
WIN_VM_PORT=22                        # SSH Port (default 22)
WIN_VM_USERNAME=chenjiangbo           # Windows Login Username
WIN_VM_PASSWORD=con1trol2             # Windows Login Password
WIN_VM_TARGET_DIR=C:/Users/chenjiangbo/hyyd_demo  # Target Dir on Windows VM
```

---

## 4. DevOps Pitfalls & Self-healing Mechanisms (Crucial for AI tools)

To resolve Windows on ARM (Apple Silicon virtualization) and non-interactive SSH issues, this system implements the following 4 self-healing features:

### 1. Windows SSH Non-login Shell Path Loss
* Issue: Windows OpenSSH starts a non-login non-interactive Shell. It only loads System PATH, and does NOT load User PATH containing node/pnpm shims. Executing command directly returns "pnpm not found".
* Solution (Path Injection): Every command prepends Path injection variables in PowerShell:
  `$env:Path += ';C:/Users/${username}/AppData/Local/pnpm;C:/Users/${username}/AppData/Roaming/npm;C:/Program Files/nodejs';`
  This injects shims PATH dynamically.

### 2. pnpm 10+ Lockfile Supply-chain verification Prompt
* Issue: pnpm v10+ blocks non-interactive installation by asking confirmation on lockfile supply-chain verification, and minimumReleaseAge cuts off newly updated packages (like @babel packages published within 24h).
* Solution (pnpm@9 Locking): The installer script automatically installs and locks pnpm to the stable **pnpm@9** on Windows:
  `npm install -g pnpm@9`
  This fully satisfies workspace root engine requirements and bypasses all supply-chain safety checking prompts.

### 3. Electron GitHub Downloader Timeout & Corruption (Electron uninstall error)
* Issue: Electron prebuilt packages (70MB+) download very slowly from GitHub in VMs, causing postinstall timeouts and leaving a half-extracted directory. This throws "Error: Electron uninstall" upon start.
* Solution (淘宝 Mirror + Native Repair):
  1. Injecting Taobao fast mirror variables:
     `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/';`
  2. Forcing a native .NET download and zip extraction under PowerShell, bypassing Node.js script issues:
     `cd '${targetDir}/packages/tray-app/node_modules/electron'; node install.js`
     This restores `dist/electron.exe` and `path.txt` perfectly.

### 4. pnpm onlyBuiltDependencies Whitelist
* Issue: pnpm v9+ blocks all postinstall scripts by default unless trusted.
* Solution: Configured `pnpm.onlyBuiltDependencies` in workspace root package.json to authorize "electron" and "esbuild".

### 5. Stale Electron / Sidecar Processes
* Issue: A previous `pnpm tray:dev` run can leave `electron.exe` or `hyyd-capture-sidecar.exe` alive. This can lock files, keep the old single-instance app running, or make the new sidecar build look successful while the UI is still connected to an old process.
* Solution: `scripts/deploy-win.js` runs:
  ```powershell
  taskkill /F /IM electron.exe /T
  taskkill /F /IM tray-app.exe /T
  taskkill /F /IM hyyd-capture-sidecar.exe /T
  ```
  The command is intentionally non-interactive and ignores "process not found". A fresh deploy must always start from a clean desktop process state.

---

## 5. How to use?

Run on your Mac workspace root:

```bash
pnpm deploy:win
```

### Steps:
1. Pack source code into temp_project.tar.gz.
2. SFTP file transfer to Windows VM.
3. Extract files remotely.
4. Auto-upgrade/ensure pnpm@9 is installed globally.
5. Execute pnpm install (extremely fast).
6. Auto-repair electron prebuilt packages via mirror.
7. Build `hyyd-capture-sidecar.exe`.
8. Run pnpm tray:dev with required VLM variables injected.
9. Pipe logs to your Mac terminal.
10. Press Ctrl+C on Mac terminal to gracefully exit both Mac and Windows processes.
