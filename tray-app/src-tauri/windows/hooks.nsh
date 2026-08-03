; Install/uninstall hooks. The daemon is an npm global package the user never
; consciously installed — removing the app removes it too. Everything is
; best-effort: a machine without npm must still uninstall cleanly.
;
; $UpdateMode = 1 when this uninstaller runs as part of a tray self-update —
; the daemon and its data must survive those, so the uninstall hooks no-op then.

!macro NSIS_HOOK_POSTINSTALL
  ; Legacy autostart shortcut left by pre-plugin builds — a second, flagless
  ; launch entry next to the plugin's Run key. Healed on every install
  ; (updates included) so existing machines lose the duplicate.
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Workday.lnk"
  ; Installing is intent to track: a manual-stop marker left by an earlier
  ; uninstall (its "workday stop" writes one) would keep the daemon down
  ; until the next login. Updates skip this — a deliberate stop survives them.
  ${If} $UpdateMode <> 1
    Delete "$PROFILE\.workday\daemon.stopped"
  ${EndIf}
!macroend

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
    ; Autostart traces: the plugin's Run entry, its Startup-apps toggle state,
    ; and the legacy shortcut. The init marker goes too so a future reinstall
    ; re-enables autostart like a true first run.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "workday"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "workday"
    Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Workday.lnk"
    Delete "$PROFILE\.workday\tray.autostart-initialized"
    ; Our own PREUNINSTALL stop just wrote this marker — left behind it would
    ; keep a future reinstall's daemon down until the next login.
    Delete "$PROFILE\.workday\daemon.stopped"
    ; The template's own app-data cleanup covers only the WebView folder —
    ; with the checkbox ticked the daemon home (config, secrets, day logs)
    ; goes too.
    ${If} $DeleteAppDataCheckboxState = 1
      RMDir /r "$PROFILE\.workday"
    ${EndIf}
  ${EndIf}
!macroend
