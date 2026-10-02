; Bust Windows shortcut icon cache on upgrade (same .lnk path keeps stale icons).
!macro NSIS_HOOK_POSTINSTALL
  ; Versioned sidecar ICO — rename on each brand change so Explorer reloads.
  File "/oname=$INSTDIR\markelle-icon-094.ico" "${INSTALLERICON}"
  Delete "$INSTDIR\markelle-icon-091.ico"
  Delete "$INSTDIR\markelle-icon-092.ico"
  Delete "$INSTDIR\markelle-icon-093.ico"

  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\markelle-icon-094.ico" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

  ${If} $AppStartMenuFolder != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\markelle-icon-094.ico" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${Else}
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\markelle-icon-094.ico" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}

  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\markelle-icon-094.ico$\""

  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\markelle-icon-091.ico"
  Delete "$INSTDIR\markelle-icon-092.ico"
  Delete "$INSTDIR\markelle-icon-093.ico"
  Delete "$INSTDIR\markelle-icon-094.ico"
!macroend
