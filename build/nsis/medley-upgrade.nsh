; Both the maintenance page and the Install section can destroy an old app.
; Preserve local Medley AND manifest-verified public Forge components first.
Var MsMedleyStatus
Var MsMedleyParentElevated
Var MsMedleyDiagnostic
Var MsMedleyWixDir
Var MsRemovedTauriDir
Var MsMedleyHelpersPrepared
Var MsUserProgram
Var MsUserCommand
Var MsWaitForHelper

; Pin the exact packaged bytes (including checkout line endings). The elevated
; process interprets only a matching in-memory snapshot, never a temp script.
!macro MS_PIN_FILE SYMBOL PATH
  !tempfile MS_PIN_OUTPUT
  !system `node -e "const fs=require('fs');fs.writeFileSync(process.argv[2],require('crypto').createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "${PATH}" "${MS_PIN_OUTPUT}"` = 0
  !define /file ${SYMBOL} "${MS_PIN_OUTPUT}"
  !delfile "${MS_PIN_OUTPUT}"
  !undef MS_PIN_OUTPUT
!macroend
!define MS_NATIVE_MANIFEST "${__FILEDIR__}\..\..\tools\forge-components.json"
!insertmacro MS_PIN_FILE MS_SHARED_SCRIPT_HASH "${__FILEDIR__}\shared-medley.ps1"
!insertmacro MS_PIN_FILE MS_NATIVE_SCRIPT_HASH "${__FILEDIR__}\preserve-native.ps1"
!insertmacro MS_PIN_FILE MS_NATIVE_MANIFEST_HASH "${MS_NATIVE_MANIFEST}"
!ifdef MS_ELECTRON_GUID
  !define MS_LEGACY_PIN "${MS_ELECTRON_UNINSTALLER_SHA256}"
!else
  !define MS_LEGACY_PIN "disabled"
!endif
; Only the headless exception needs an unambiguous registration. Interactive
; preservation still inspects every old tree supplied by the installer.
!macro MS_CHECK_OTHER_REGISTRATION HIVE
  ReadRegStr $6 ${HIVE} "${MANUPRODUCTKEY}" ""
  ReadRegStr $7 ${HIVE} "${UNINSTKEY}" "InstallLocation"
  ReadRegStr $8 ${HIVE} "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$6$7$8" != "" ${|} StrCpy $4 "ambiguous" ${|}
  !ifdef MS_ELECTRON_GUID
    ReadRegStr $6 ${HIVE} "${MS_ELECTRON_INSTKEY}" "InstallLocation"
    ReadRegStr $7 ${HIVE} "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
    ${IfThen} "$6$7" != "" ${|} StrCpy $4 "ambiguous" ${|}
  !endif
!macroend

Function MidiStudioPreserveMedley
  System::Store S
  StrCpy $MsMedleyStatus 25
  StrCpy $MsMedleyDiagnostic ""
  ${If} $MsMedleyHelpersPrepared != 1
    InitPluginsDir
    File /oname=$PLUGINSDIR\preserve-medley.ps1 "${__FILEDIR__}\preserve-medley.ps1"
    File /oname=$PLUGINSDIR\import_medley_checkpoint.py "${__FILEDIR__}\..\..\python-engine\import_medley_checkpoint.py"
    File /oname=$PLUGINSDIR\export_bsrofo_body.py "${__FILEDIR__}\..\..\forge-rs\tools\export_bsrofo_body.py"
    File /oname=$PLUGINSDIR\shared-medley.ps1 "${__FILEDIR__}\shared-medley.ps1"
    File /oname=$PLUGINSDIR\preserve-native.ps1 "${__FILEDIR__}\preserve-native.ps1"
    File /oname=$PLUGINSDIR\forge-components.json "${MS_NATIVE_MANIFEST}"
    StrCpy $MsMedleyHelpersPrepared 1
  ${EndIf}

  ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
  ReadRegStr $6 SHCTX "${UNINSTKEY}" "InstallLocation"
  ${If} $0 == ""
    StrCpy $0 $6
  ${EndIf}
  ReadRegStr $1 SHCTX "${UNINSTKEY}" "DisplayVersion"
  StrCpy $2 ""
  StrCpy $4 "none"
  !ifdef MS_ELECTRON_GUID
    ReadRegStr $2 SHCTX "${MS_ELECTRON_INSTKEY}" "InstallLocation"
    ReadRegStr $5 SHCTX "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
    ${IfThen} $5 != "" ${|} StrCpy $4 "electron" ${|}
  !endif
  ReadRegStr $5 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $5 != ""
    ; Public Tauri installers record all three paths in this exact form.
    ; Never parse registry command text, or let Tauri mask an Electron entry.
    ${If} $4 == "none"
    ${AndIf} $2 == ""
    ${AndIf} $6 == "$\"$0$\""
    ${AndIf} $5 == "$\"$0\uninstall.exe$\""
      StrCpy $4 "tauri"
      !if "${INSTALLMODE}" == "both"
        ${If} $MultiUser.InstallMode == "AllUsers"
          !insertmacro MS_CHECK_OTHER_REGISTRATION HKCU
        ${Else}
          !insertmacro MS_CHECK_OTHER_REGISTRATION HKLM
        ${EndIf}
      !endif
    ${Else}
      StrCpy $4 "ambiguous"
    ${EndIf}
  ${ElseIf} $0 == $MsRemovedTauriDir
  ${AndIf} "$1$6" == ""
    ; A successful maintenance uninstall keeps MANUPRODUCTKEY (preferences)
    ; but removes its uninstall registration. Do not call that a broken app.
    StrCpy $0 ""
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_REGISTERED", w r4)'
  StrCpy $3 ""
  ${If} $WixMode = 1
    ReadRegStr $3 HKLM "$R6" "InstallLocation"
    ${If} $3 != ""
      StrCpy $MsMedleyWixDir $3
    ${Else}
      StrCpy $3 $MsMedleyWixDir
    ${EndIf}
    ${If} $3 == ""
      ; Unknown destructive tree: do not guess the install directory.
      StrCpy $MsMedleyStatus 24
      Goto medley_done
    ${EndIf}
  ${EndIf}
  ; Registry values, wizard inputs and paths never become PowerShell source or
  ; command-line options. Override *every* helper input on every invocation.
  StrCpy $4 "0"
  !if "${INSTALLMODE}" == "both"
    ${IfThen} $MultiUser.InstallMode == "AllUsers" ${|} StrCpy $4 "1" ${|}
  !else if "${INSTALLMODE}" == "perMachine"
    StrCpy $4 "1"
  !endif
  ${IfThen} $WixMode = 1 ${|} StrCpy $4 "1" ${|}
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_ALL_USERS", w r4)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_TARGET", w d)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_TAURI", w r0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_OLD_VERSION", w r1)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_ELECTRON", w r2)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_WIX", w r3)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_PRODUCT", w "${PRODUCTNAME}")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_VERSION", w "${VERSION}")'
  StrCpy $4 "$ForgeStorageDir"
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_STORAGE", w r4)'
  StrCpy $4 "$ExistingForgeStorage"
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_OLD_STORAGE", w r4)'
  StrCpy $MsUserProgram "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  StrCpy $MsUserCommand '"$MsUserProgram" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\preserve-medley.ps1" -Installer'
  StrCpy $MsWaitForHelper 1
  Call MidiStudioRunAsDesktop
  medley_done:
  ${If} $MsMedleyStatus == 25
    ; Never use the absence of a desktop to bypass a model check. Only the
    ; inspected headless case can use the protected public-component cache.
    System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_OPERATION", w "CheckHeadlessTarget")'
    Call MidiStudioProtectedOperation
    ${If} $MsMedleyStatus == 0
      System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_OPERATION", w "PreserveNative")'
      Call MidiStudioProtectedOperation
    ${EndIf}
  ${ElseIf} $MsMedleyParentElevated != 0
    !if "${INSTALLMODE}" == "both"
      ${If} $MultiUser.InstallMode == "AllUsers"
    !endif
    !if "${INSTALLMODE}" != "currentUser"
      ${If} $MsMedleyStatus == 0
      ${OrIf} $MsMedleyStatus == 10
        ; Preserve the public components for the other users, not only in the
        ; signed-in user's chosen location. Do not mask the Medley handoff.
        Push $MsMedleyStatus
        System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_OPERATION", w "PreserveNative")'
        Call MidiStudioProtectedOperation
        Pop $0
        ${IfThen} $MsMedleyStatus == 0 ${|} StrCpy $MsMedleyStatus $0 ${|}
      ${EndIf}
    !endif
    !if "${INSTALLMODE}" == "both"
      ${EndIf}
    !endif
  ${EndIf}
  ${If} $MsMedleyStatus == 10
    ; Only for weights formerly available in a registered machine-wide app.
    ; All user-controlled input to this fixed script is treated as data.
    StrCpy $MsMedleyStatus 26
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\medley-shared-input.txt" r
    ${IfNot} ${Errors}
      FileReadUTF16LE $0 $1
      FileClose $0
      System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_SHARED_INPUT", w r1)'
      System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_OPERATION", w "PreserveShared")'
      Call MidiStudioProtectedOperation
    ${EndIf}
  ${EndIf}
  ${If} $MsMedleyStatus != 0
    ${If} $MsMedleyDiagnostic == ""
      ClearErrors
      FileOpen $0 "$PLUGINSDIR\medley-error.txt" r
      ${IfNot} ${Errors}
        FileReadUTF16LE $0 $MsMedleyDiagnostic
        FileClose $0
      ${EndIf}
    ${EndIf}
    ${If} $MsMedleyStatus = 22
      MessageBox MB_ICONSTOP|MB_OK "Update stopped before removing the old app. Medley needs a verified local conversion. Close setup; in normal (non-administrator) PowerShell use your Forge python.exe with the offline import_medley_checkpoint.py in your Local AppData\midi-studio\medley-import-${VERSION} folder. Keep the original checkpoint and YAML. Rerun setup after conversion.$\r$\n$\r$\n$MsMedleyDiagnostic" /SD IDOK
    ${Else}
      MessageBox MB_ICONSTOP|MB_OK "Update stopped before removing or replacing MIDI Studio. Could not safely preserve Forge files (code $MsMedleyStatus). Back up the named file, sign in as the old app's user, and choose storage outside the old install. Do not manually uninstall the old app first.$\r$\n$\r$\n$MsMedleyDiagnostic" /SD IDOK
    ${EndIf}
    SetErrorLevel 1
    System::Store L
    Quit
  ${EndIf}
  System::Store L
FunctionEnd

Function MidiStudioCheckMachineUninstaller
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_OPERATION", w "VerifyMachineUninstaller")'
  Call MidiStudioProtectedOperation
FunctionEnd

Function MidiStudioProtectedOperation
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_SHARED_SCRIPT", w "$PLUGINSDIR\shared-medley.ps1")'
  ; Keep the protected helper's stderr in the pipe, not an elevated log file.
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop'; try { $$b=[IO.File]::ReadAllBytes($$env:MS_MEDLEY_SHARED_SCRIPT); if ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($$b)).Replace('-','') -ne '${MS_SHARED_SCRIPT_HASH}') { throw 'The packaged preservation helper failed verification.' }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($$b))) '${MS_NATIVE_SCRIPT_HASH}' '${MS_NATIVE_MANIFEST_HASH}' '${MS_LEGACY_PIN}'; exit $$LASTEXITCODE } catch { [Console]::Error.WriteLine($$_.Exception.Message); exit 26 }"`
  Pop $MsMedleyStatus
  Pop $MsMedleyDiagnostic
  DetailPrint "$MsMedleyDiagnostic"
FunctionEnd

; No ShellExecute/elevation fallback. Use the verified non-admin shell token
; even if Setup was run with another administrator's credentials. Only the
; preservation helper inherits explicit installer environment data and waits.
Function MidiStudioRunAsDesktop
  System::Store S
  StrCpy $MsMedleyStatus 25
  StrCpy $MsMedleyParentElevated 1
  StrCpy $9 $MsUserCommand
  System::Call 'advapi32::OpenProcessToken(p -1, i 8, *p .r0) i.r1'
  StrCmp $1 0 desktop_done
  System::Call 'advapi32::GetTokenInformation(p r0, i 20, *i .r2, i 4, *i .r3) i.r1'
  System::Call 'kernel32::CloseHandle(p r0)'
  StrCmp $1 0 desktop_done
  StrCpy $MsMedleyParentElevated $2
  ${If} $MsWaitForHelper = 1
    System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_WAS_ELEVATED", w r2)'
  ${EndIf}
  ${If} $2 = 0
    ${If} $MsWaitForHelper = 1
      nsExec::ExecToLog '$9'
      Pop $MsMedleyStatus
    ${Else}
      ClearErrors
      Exec '$9'
      ${IfNotThen} ${Errors} ${|} StrCpy $MsMedleyStatus 0 ${|}
    ${EndIf}
    Goto desktop_done
  ${EndIf}
  System::Call 'user32::GetShellWindow() p.r0'
  StrCmp $0 0 desktop_done
  System::Call 'user32::GetWindowThreadProcessId(p r0, *i .r1) i.r2'
  StrCmp $2 0 desktop_done
  System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r1) p.r0'
  StrCmp $0 0 desktop_done
  System::Call 'advapi32::OpenProcessToken(p r0, i 0xB, *p .r1) i.r2'
  System::Call 'kernel32::CloseHandle(p r0)'
  StrCmp $2 0 desktop_done
  System::Call 'advapi32::GetTokenInformation(p r1, i 20, *i .r2, i 4, *i .r3) i.r0'
  StrCmp $0 0 desktop_close_token
  StrCmp $2 0 0 desktop_close_token
  StrCpy $8 0
  ${If} $MsWaitForHelper = 1
    System::Call 'kernel32::GetEnvironmentStringsW() p.r2'
    StrCmp $2 0 desktop_close_token
    StrCpy $8 0x08000400
  ${EndIf}
  ; x86 installer: STARTUPINFOW=68 and PROCESS_INFORMATION=16 bytes.
  System::Call 'kernel32::GlobalAlloc(i 0x40, p 68) p.r3'
  ${If} $3 <> 0
    System::Call '*$3(i 68)'
    System::Alloc 16
    Pop $4
    ${If} $4 <> 0
      StrCpy $7 $MsUserProgram
      System::Call 'advapi32::CreateProcessWithTokenW(p r1, i 0, w r7, w r9, i r8, p r2, w "$SYSDIR", p r3, p r4) i.r0'
      ${If} $0 <> 0
        System::Call '*$4(p .r5, p .r6)'
        System::Call 'kernel32::CloseHandle(p r6)'
        ${If} $MsWaitForHelper = 1
          System::Call 'kernel32::WaitForSingleObject(p r5, i -1) i.r0'
          ${If} $0 = 0
            System::Call 'kernel32::GetExitCodeProcess(p r5, *i .r6) i.r0'
            ${IfThen} $0 <> 0 ${|} StrCpy $MsMedleyStatus $6 ${|}
          ${EndIf}
        ${Else}
          StrCpy $MsMedleyStatus 0
        ${EndIf}
        System::Call 'kernel32::CloseHandle(p r5)'
      ${EndIf}
      System::Free $4
    ${EndIf}
    System::Call 'kernel32::GlobalFree(p r3)'
  ${EndIf}
  ${If} $2 <> 0
    System::Call 'kernel32::FreeEnvironmentStringsW(p r2)'
  ${EndIf}
  desktop_close_token:
  System::Call 'kernel32::CloseHandle(p r1)'
  desktop_done:
  System::Store L
FunctionEnd
