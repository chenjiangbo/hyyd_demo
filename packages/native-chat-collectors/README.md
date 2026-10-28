# Native chat collectors

Windows-only, headless child processes for local WeChat and WeCom message acquisition. The desktop process supplies the backend URL and employee identity through its authenticated API calls; collector stdin/stdout use newline-delimited JSON. The backend's enabled conversation rules decide which discovered sessions receive message subscriptions. Both collectors read only subscribed conversations; WeCom still refreshes the session directory when the selection is empty.

The collector protocol is documented in `protocol.md`. Windows packaging requires Python 3.12.10 x64 to build the standalone WeChat collector with `wechat/prepare-runtime.ps1 -PythonExe <path>`, then the Rust 1.98.1/MSVC toolchain to build the WeCom headless executable with `wxwork/build-windows.ps1`. Both generated executables are required before making a Windows installer.

## Third-party notices

The WeChat database and media reader files in `wechat/vendor/wechatauto/` are from `wechatauto-replica` 1.2.7.0 and retain its Apache-2.0 license in `wechat/LICENSE`. The WeCom Windows source reader, parser and snapshot code in `wxwork/vendor/upstream/` are from `wecom-archive` 0.0.11 and retain its MIT license in `wxwork/LICENSE`. The produced Electron installer contains only the collector executable and license notice, not the upstream desktop executable or interface assets.
