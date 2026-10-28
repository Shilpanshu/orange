; Orange 2.0 installer hooks: replace an Orange 1.x (Electron) install cleanly.
; See docs/MIGRATION.md. Everything is per user (HKCU); nothing needs administrator rights.
;
; 1.x was installed by electron-builder to %LOCALAPPDATA%\Programs\Orange, with an uninstall key
; named by a GUID derived from its appId, so it never collides with 2.0's key ("Orange").
; We find it by its uninstaller name, run it silently, then remove what the 1.x *app* (not its
; installer) wrote: the Explorer menu and the login item. 1.x settings in %APPDATA%\Orange are
; left alone (1.x never deletes app data on uninstall); 2.0 imports them on first run.

Var Orange1xUninst
Var Orange1xDir
Var Orange1xFound

!macro ORANGE_FIND_1X
  StrCpy $Orange1xFound 0
  StrCpy $0 0
  loop_1x:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" done_1x
    IntOp $0 $0 + 1
    StrCmp $1 "${PRODUCTNAME}" loop_1x ; 2.x's own key
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ClearErrors
    ${WordFind} "$2" "Uninstall Orange.exe" "E#" $3
    IfErrors loop_1x
    ReadRegStr $Orange1xDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "InstallLocation"
    StrCpy $Orange1xUninst $2
    StrCpy $Orange1xFound 1
  done_1x:
  ; Fallback: the default 1.x location even if its uninstall key is gone.
  ${If} $Orange1xFound = 0
  ${AndIf} ${FileExists} "$LOCALAPPDATA\Programs\Orange\Uninstall Orange.exe"
    StrCpy $Orange1xDir "$LOCALAPPDATA\Programs\Orange"
    StrCpy $Orange1xUninst '"$LOCALAPPDATA\Programs\Orange\Uninstall Orange.exe"'
    StrCpy $Orange1xFound 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ORANGE_FIND_1X
  ${If} $Orange1xFound = 1
    DetailPrint "Removing Orange 1.x"
    ; The 1.x uninstaller closes a still-running 1.x itself (electron-builder's uninstaller does).
    ; _?= runs the uninstaller in place and waits for it. /S = silent.
    ; Never RMDir an empty or unexpected path: only a folder that holds the 1.x uninstaller.
    ${If} $Orange1xDir != ""
    ${AndIf} ${FileExists} "$Orange1xDir\Uninstall Orange.exe"
      ExecWait '$Orange1xUninst /S _?=$Orange1xDir'
      Delete "$Orange1xDir\Uninstall Orange.exe"
      RMDir /r "$Orange1xDir"
    ${Else}
      ExecWait '$Orange1xUninst /S'
    ${EndIf}
    ; Explorer menu written by 1.x (src/main/context-menu.ts).
    DeleteRegKey HKCU "Software\Classes\*\shell\Orange"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Orange"
    ; Login item written by Electron's setLoginItemSettings (value named by the AppUserModelId).
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.orange.converter"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Orange"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "app.orange.converter"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.Orange"
    ; Tells 2.0's first run that it came from 1.x (settings import, re-register menu/autostart).
    WriteRegDWORD HKCU "Software\Orange" "MigratedFrom1x" 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Start Menu entry, also for silent installs and updates (Tauri only creates it on the installer's
  ; own screens). Without it, someone who quit Orange could not find how to start it again. Same path
  ; the interactive installer uses, so nothing is duplicated; the uninstaller removes it.
  CreateShortCut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; electron-updater (the 1.x bridge) runs us with "/S --updated --force-run"; Tauri only
  ; relaunches on "/R", so honour --force-run too.
  ${If} ${Silent}
    ${GetOptions} $CMDLINE "--force-run" $R0
    ${IfNot} ${Errors}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
!macroend
