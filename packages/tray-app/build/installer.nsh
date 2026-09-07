!macro closeRunningTrayApp
  DetailPrint "正在关闭已运行的 tray-app..."
  ExecWait '"$SYSDIR\taskkill.exe" /F /IM "tray-app.exe"'
  ExecWait '"$SYSDIR\taskkill.exe" /F /IM "hyyd-capture-sidecar.exe"'
  Sleep 1000
!macroend

!macro customInit
  !insertmacro closeRunningTrayApp
!macroend

; 重新安装时覆盖旧桌面快捷方式，并始终以主程序的自定义图标作为图标源。
!macro customInstall
  Delete "$DESKTOP\\tray-app.lnk"
  CreateShortCut "$DESKTOP\\tray-app.lnk" "$INSTDIR\\tray-app.exe" "" "$INSTDIR\\tray-app.exe" 0
!macroend

!macro customUnInit
  !insertmacro closeRunningTrayApp
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "智能寰宇"
!macroend
