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
;
; Order (Tauri 2.12.3 installer.nsi, Section Uninstall): this hook runs first, then
; Tauri's CheckIfAppIsRunning (whose Cancel aborts the uninstall), then the files are
; deleted. So the hook runs that same check itself BEFORE touching the rule: a Cancel
; then aborts with the rule still in place, and Tauri's own call afterwards finds the
; app already closed. There is no other abort point before the files are deleted.
;
; Trust before launching the helper elevated (ADR-0021 decision 8). The install folder
; is chosen by the user, so the hook checks cheaply, and starts nothing if:
; - $INSTDIR is not strictly inside a Program Files folder ($PROGRAMFILES64 or
;   $PROGRAMFILES; compared at a path-component boundary, case-insensitively), or
; - the helper exe, $INSTDIR, or any folder from there up to AND including that
;   Program Files folder is a reparse point (junction, symbolic link, ...). This is
;   the same chain the helper checks itself.
; The effective-ACL check is NOT repeated here: Windows runs this uninstaller as
; `$INSTDIR\uninstall.exe` (the UninstallString Tauri writes), from the same folder as
; the helper. Whoever can replace the helper there can replace uninstall.exe as well,
; so starting the helper from it crosses no new elevation boundary. The helper's own
; checks at startup (exit 2) stay as defence in depth.

; Sets $1 to `pf` if $INSTDIR is strictly inside it ("<pf>\" plus at least one more
; character; StrCmp ignores case) and $1 is still empty. Uses $2 and $3.
!macro _FW_ELEV_INSIDE pf
  ${If} $1 == ""
    StrCpy $2 "${pf}\"
    StrLen $3 $2
    StrCpy $3 $INSTDIR $3
    ${If} $3 == $2
    ${AndIf} $INSTDIR != $2
      StrCpy $1 "${pf}"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ; May abort the uninstall (Cancel at the close prompt); nothing is changed yet.
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

    Push $0
    Push $1
    Push $2
    Push $3
    DetailPrint "Removing the Windows Firewall rule ${BUNDLEID}.lan.tcp.program (only if this app created it)..."
    ; $0 = the result: empty while the checks pass, else the reason or the exit code.
    StrCpy $0 ""
    ${IfNot} ${FileExists} "$INSTDIR\${MAINBINARYNAME}-fw-elev.exe"
      StrCpy $0 "helper not found"
    ${EndIf}

    ; $1 = the Program Files folder $INSTDIR is strictly inside ("" if none).
    StrCpy $1 ""
    ${If} $0 == ""
      !insertmacro _FW_ELEV_INSIDE $PROGRAMFILES64
      !insertmacro _FW_ELEV_INSIDE $PROGRAMFILES
      ${If} $1 == ""
        StrCpy $0 "not installed under Program Files: $INSTDIR"
      ${EndIf}
    ${EndIf}

    ${If} $0 == ""
      ClearErrors
      ${GetFileAttributes} "$INSTDIR\${MAINBINARYNAME}-fw-elev.exe" "REPARSE_POINT" $3
      ${If} ${Errors}
        StrCpy $0 "could not check the helper: $INSTDIR\${MAINBINARYNAME}-fw-elev.exe"
      ${ElseIf} $3 <> 0
        StrCpy $0 "a reparse point is on the path: $INSTDIR\${MAINBINARYNAME}-fw-elev.exe"
      ${EndIf}
    ${EndIf}
    ${If} $0 == ""
      ; Walk $INSTDIR -> ... -> the Program Files folder ($1), checking each one.
      StrCpy $2 $INSTDIR
      ${Do}
        ClearErrors
        ${GetFileAttributes} $2 "REPARSE_POINT" $3
        ${If} ${Errors}
          StrCpy $0 "could not check the folder: $2"
          ${ExitDo}
        ${ElseIf} $3 <> 0
          StrCpy $0 "a reparse point is on the path: $2"
          ${ExitDo}
        ${EndIf}
        ${If} $2 == $1
          ${ExitDo}
        ${EndIf}
        ${GetParent} $2 $2
        ${If} $2 == ""
          StrCpy $0 "could not check the folders up to Program Files"
          ${ExitDo}
        ${EndIf}
      ${Loop}
    ${EndIf}

    ${If} $0 == ""
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}-fw-elev.exe" firewall-remove' $0
      ${If} ${Errors}
        StrCpy $0 "not started"
      ${EndIf}
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
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend
