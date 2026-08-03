; Uninstall hooks. The daemon is an npm global package the user never
; consciously installed — removing the app removes it too. Everything is
; best-effort: a machine without npm must still uninstall cleanly.
;
; $UpdateMode = 1 when this uninstaller runs as part of a tray self-update —
; the daemon and its data must survive those, so both hooks no-op then.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ; Stop the daemon so npm can unlink the running package. PATH is rebuilt
    ; the same way the app does it (GUI processes may miss npm locations).
    nsExec::Exec 'cmd /C "set PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH% && workday stop"'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    nsExec::Exec 'cmd /C "set PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH% && npm uninstall -g workday-daemon"'
    ; The template's own app-data cleanup covers only the WebView folder —
    ; with the checkbox ticked the daemon home (config, secrets, day logs)
    ; goes too.
    ${If} $DeleteAppDataCheckboxState = 1
      RMDir /r "$PROFILE\.workday"
    ${EndIf}
  ${EndIf}
!macroend
