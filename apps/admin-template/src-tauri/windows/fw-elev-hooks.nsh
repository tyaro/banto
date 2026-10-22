; NSIS hooks of the Tauri installer (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; Issue #219 stage 2, ADR-0021 decision 3 (docs/adr/0021-firewall-elevated-helper.md):
; - Installing creates NO firewall rule. Allowing is an admin's explicit action in the app.
; - Uninstalling asks the helper to remove the one rule this app owns
;   (`firewall-remove`; the helper checks ownership by content, decision 6, and
;   never touches a rule it does not own).
; - A failure never stops the uninstall: it only prints how to remove the rule by hand.
;
; No name is written here: the helper is `<main binary>-fw-elev.exe` next to the main
; exe (ADR-0021 decisions 7 and 8; `apps/admin-template/elev` tests check that its
; [[bin]] name follows this) and the rule is `<identifier>.lan.tcp.program`
; (decision 5). Both come from Tauri's own defines (MAINBINARYNAME, BUNDLEID), so
; renaming the app needs no edit here.
;
; The uninstaller of a perMachine install runs elevated, so ExecWait can start the
; helper (requireAdministrator) without another UAC prompt. `$UpdateMode` is the
; Tauri template's flag for an update in place (same install path, so the rule
; still names the right exe): the rule is kept then.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    Push $0
    DetailPrint "Removing the Windows Firewall rule ${BUNDLEID}.lan.tcp.program (only if this app created it)..."
    ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}-fw-elev.exe"
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}-fw-elev.exe" firewall-remove' $0
      ${If} ${Errors}
        StrCpy $0 "not started"
      ${EndIf}
    ${Else}
      StrCpy $0 "helper not found"
    ${EndIf}
    ${If} $0 == 0
      DetailPrint "The firewall rule was removed (or there was none)."
    ${Else}
      ; The helper's exit codes: 2 = the installation is not trusted (not under
      ; Program Files, or writable by non-admins), 4 = a rule of that name that this
      ; app does not own (e.g. changed by an administrator), others = failed.
      DetailPrint "The firewall rule could not be removed (result: $0). The uninstall continues."
      DetailPrint "To remove it by hand, run in an administrator PowerShell:"
      DetailPrint "  Remove-NetFirewallRule -Name '${BUNDLEID}.lan.tcp.program'"
      DetailPrint "or delete the inbound rule '${BUNDLEID} LAN (TCP-In, program)' (group ${BUNDLEID})"
      DetailPrint "in 'Windows Defender Firewall with Advanced Security'. Check first that it is the rule you expect."
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend
