!macro closeRunningTrayApp
  DetailPrint "正在关闭已运行的 tray-app..."
  ExecWait '"$SYSDIR\taskkill.exe" /F /IM "tray-app.exe"'
  ExecWait '"$SYSDIR\taskkill.exe" /F /IM "hyyd-capture-sidecar.exe"'
  Sleep 1000
!macroend

!macro customInit
  !insertmacro closeRunningTrayApp
!macroend

!macro customUnInit
  !insertmacro closeRunningTrayApp
!macroend
