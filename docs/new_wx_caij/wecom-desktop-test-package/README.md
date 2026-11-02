# WeCom source comparison kit

This package compares the WeCom conversation metadata visible to the current headless collector across numeric data directories on one Windows machine. It is intended for the older Windows desktop used in the original validation.

## Run

1. Extract the ZIP to a normal folder.
2. Start and sign in to WeCom.
3. Open PowerShell from that same Windows desktop session, change to this folder, then run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\diagnose-wecom-sources.ps1
   ```

The script reports WeCom version and session ID, inventories `message.db`, `session.db`, `user.db`, and `account_data.db` under each numeric child of `Documents\WXWork`, then asks the collector for conversation metadata from each directory that contains `message.db`. It reports matching titles, conversation IDs, and participant names for the terms 孟宪宇、李卫旗、泰康、辽宁铂金、张文娟.

The collector must run in the same Windows logon session as `WXWork.exe`; the script checks this before scanning. Do not run it through SSH, a scheduled task, or a service. It does not read or print message bodies. Source databases are opened through the collector's read-only path. Temporary working data is written to `%TEMP%` and removed after each directory.

If a directory reports an error, it is uninspected. An error is not evidence that its conversations are absent. If the data root is not `%USERPROFILE%\Documents\WXWork`, stop and report the actual location before changing the script.

## Files

- `bin/hyyd-wxwork-collector.exe`: headless collector built on Windows on 2026-10-26. SHA-256: `FFFE8D9670AD5B1CF2601D731E04BE293FE04849DD87D0FE5EC0AD56848C3F84`.
- `diagnose-wecom-sources.ps1`: read-only metadata scan.
- `BACKGROUND-AND-TEST.md`: full background, current evidence, integration design, unresolved question, and interpretation guide for the old-desktop comparison.
- `source/wecom-archive-0.0.11/`: full Rust source snapshot for the upstream `wecom-archive` 0.0.11 core, including this project's headless collector entry point and parser changes.
- `source/project-integration/`: project code excerpts for current-account directory resolution and child-process/session integration.
- `source/LICENSE`: upstream MIT license.
- `source/build-windows.ps1`: Windows build script; rebuilding is not needed for this diagnostic.

The package is not a client installer and does not switch enterprises, send messages, or export message content.
