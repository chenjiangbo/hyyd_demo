# WeCom collector

`vendor/upstream/src-tauri/src/bin/hyyd_native_collector.rs` is the headless entrypoint. It calls the upstream read-only source discovery, key probe, snapshot, parser, and media pipeline without launching the Tauri interface.

The desktop sends the currently enabled session IDs over the JSON-lines protocol. The source reader applies those IDs to the SQLite message query before parsing messages or resolving media. It still reads the conversation directory metadata so administrators can configure newly discovered sessions. An empty selection reads no message rows.

Build the Windows executable with `build-windows.ps1` on a Windows machine with Rust 1.98.1 and the MSVC C++ build tools installed. The script writes `hyyd-wxwork-collector.exe` into this directory.
