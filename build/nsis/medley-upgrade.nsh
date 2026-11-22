; Called before *either* old uninstaller and again before replacing files. A
; wizard may change install/storage paths after the maintenance page. The copy
; is idempotent, so check the final paths too (also covers /S, /P and /UPDATE).
Var MsMedleyStatus
Var MsMedleyParentElevated
Var MsMedleyDiagnostic
Var MsMedleyWixDir
Var MsMedleyHelpersPrepared

; Pin the exact packaged bytes (including checkout line endings). The elevated
; process interprets only a matching in-memory snapshot, never a temp script.
!tempfile MS_SHARED_HASH_FILE
!system `node -e "const fs=require('fs');fs.writeFileSync(process.argv[2],require('crypto').createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "${__FILEDIR__}\shared-medley.ps1" "${MS_SHARED_HASH_FILE}"` = 0
!define /file MS_SHARED_SCRIPT_HASH "${MS_SHARED_HASH_FILE}"
!delfile "${MS_SHARED_HASH_FILE}"

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
    StrCpy $MsMedleyHelpersPrepared 1
  ${EndIf}

  ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $0 == ""
    ReadRegStr $0 SHCTX "${UNINSTKEY}" "InstallLocation"
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
  ${IfThen} $5 != "" ${|} StrCpy $4 "tauri" ${|}
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
  StrCpy $9 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\preserve-medley.ps1" -Installer'

  System::Call 'advapi32::OpenProcessToken(p -1, i 8, *p .r0) i.r1'
  StrCmp $1 0 medley_done
  System::Call 'advapi32::GetTokenInformation(p r0, i 20, *i .r2, i 4, *i .r3) i.r1'
  System::Call 'kernel32::CloseHandle(p r0)'
  StrCmp $1 0 medley_done
  StrCpy $MsMedleyParentElevated $2
  System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_WAS_ELEVATED", w r2)'
  ${If} $2 = 0
    ; The helper might perform a long offline conversion: no nsExec timeout.
    nsExec::ExecToLog '$9'
    Pop $MsMedleyStatus
  ${Else}
    ; Do not start PowerShell elevated, even temporarily to drop privileges.
    ; Borrow the interactive shell's primary token, verify TokenElevation=0,
    ; then wait synchronously for the process handle (not a writable sentinel).
    System::Call 'user32::GetShellWindow() p.r0'
    StrCmp $0 0 medley_done
    System::Call 'user32::GetWindowThreadProcessId(p r0, *i .r1) i.r2'
    StrCmp $2 0 medley_done
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r1) p.r0'
    StrCmp $0 0 medley_done
    System::Call 'advapi32::OpenProcessToken(p r0, i 0xB, *p .r1) i.r2'
    System::Call 'kernel32::CloseHandle(p r0)'
    StrCmp $2 0 medley_done
    System::Call 'advapi32::GetTokenInformation(p r1, i 20, *i .r2, i 4, *i .r3) i.r0'
    StrCmp $0 0 medley_close_token
    StrCmp $2 0 0 medley_close_token
    System::Call 'kernel32::GetEnvironmentStringsW() p.r2'
    StrCmp $2 0 medley_close_token
    ; The NSIS installer process is x86 even when its payload is x64.
    System::Call 'kernel32::GlobalAlloc(i 0x40, p 68) p.r3'
    System::Call '*$3(i 68)'
    System::Alloc 16
    Pop $4
    System::Call 'advapi32::CreateProcessWithTokenW(p r1, i 0, w "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe", w r9, i 0x08000400, p r2, w "$SYSDIR", p r3, p r4) i.r0'
    ${If} $0 <> 0
      System::Call '*$4(p .r5, p .r6)'
      System::Call 'kernel32::CloseHandle(p r6)'
      System::Call 'kernel32::WaitForSingleObject(p r5, i -1) i.r0'
      ${If} $0 = 0
        System::Call 'kernel32::GetExitCodeProcess(p r5, *i .r6) i.r0'
        ${IfThen} $0 <> 0 ${|} StrCpy $MsMedleyStatus $6 ${|}
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p r5)'
    ${EndIf}
    System::Free $4
    System::Call 'kernel32::GlobalFree(p r3)'
    System::Call 'kernel32::FreeEnvironmentStringsW(p r2)'
    medley_close_token:
    System::Call 'kernel32::CloseHandle(p r1)'
  ${EndIf}
  medley_done:
  ${If} $MsMedleyStatus == 25
    System::Call 'kernel32::SetEnvironmentVariableW(w "MS_MEDLEY_OPERATION", w "CheckHeadlessTarget")'
    Call MidiStudioProtectedOperation
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
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\medley-error.txt" r
    ${IfNot} ${Errors}
      FileReadUTF16LE $0 $MsMedleyDiagnostic
      FileClose $0
    ${EndIf}
    ${If} $MsMedleyStatus = 22
      MessageBox MB_ICONSTOP|MB_OK "Update stopped before removing the old app. Medley needs a verified local conversion. Close setup; in normal (non-administrator) PowerShell use your Forge python.exe with the offline import_medley_checkpoint.py in your Local AppData\midi-studio\medley-import-${VERSION} folder. Keep the original checkpoint and YAML. Rerun setup after conversion.$\r$\n$\r$\n$MsMedleyDiagnostic" /SD IDOK
    ${Else}
      MessageBox MB_ICONSTOP|MB_OK "Update stopped before removing or replacing MIDI Studio. Could not safely preserve Medley (code $MsMedleyStatus). Sign in as the user of the old app. Back up the original model, use a local Forge folder outside the old install, and retry. Do not manually uninstall the old app first.$\r$\n$\r$\n$MsMedleyDiagnostic" /SD IDOK
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
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop'; $$b=[IO.File]::ReadAllBytes($$env:MS_MEDLEY_SHARED_SCRIPT); if ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($$b)).Replace('-','') -ne '${MS_SHARED_SCRIPT_HASH}') { exit 26 }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($$b)))"`
  Pop $MsMedleyStatus
FunctionEnd
