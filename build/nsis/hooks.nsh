; MIDI Studio installer hooks (Tauri NSIS). The successor to build/installer.nsh,
; the electron-builder include:
;   * the Forge storage page, and the ForgeStorageDir value it records under
;     HKCU with an HKLM mirror (fpaths.rs query_forge_storage_dir reads both);
;   * the Temp-folder checks before anything unpacks;
;   * closing a running MIDI Studio without a prompt and WITHOUT taskkill /t;
;   * a first install over the Electron build: same scope and folder, then
;     the Electron uninstaller run silently so Programs and Features is left
;     with one MIDI Studio. Its user data (%APPDATA%\midi-studio: settings,
;     mappings, the localStorage migrate.rs carries over) is kept.
;
; build/nsis/installer.nsi includes this after its variables and MultiUser.nsh
; and calls MIDISTUDIO_FORGE_PAGE, MIDISTUDIO_ONINIT_EARLY and
; MIDISTUDIO_ONINIT_LATE; the Install section calls the two NSIS_HOOK_* macros.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; MANUPRODUCTKEY is Software\StarsationX\MIDI Studio for the real product, the
; key the Electron installer used. A renamed test build gets its own key.
!define MS_FORGE_KEY "${MANUPRODUCTKEY}"
!define MS_FORGE_VALUE "ForgeStorageDir"
!define MS_FORGE_FOLDER "MIDI Studio Forge"

; The Electron build's electron-builder identity: UUID v5 of the appId
; com.starsationx.midistudio in electron-builder's namespace. Only the real
; product looks for it, so a test build can never uninstall the user's app.
!if "${BUNDLEID}" == "com.starsationx.midistudio"
  !define MS_ELECTRON_GUID "ab5bc8e7-f120-5de1-b7c5-f5b41892fd91"
  !define MS_ELECTRON_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${MS_ELECTRON_GUID}"
  !define MS_ELECTRON_INSTKEY "Software\${MS_ELECTRON_GUID}"
  !define MS_ELECTRON_UNINSTALLER "Uninstall MIDI Studio.exe"
  ; From the published MIDI-Studio-3.0.1-Setup.exe (SHA-256 d78af42b31dc5edda6f3c7495beefda520a371b16988555868a8c256fcf02654).
  !define MS_ELECTRON_UNINSTALLER_SHA256 "ba57a8cab4ae8f25db45950065af3da63a23982b4d80bfac474089193171bcf8"
!endif

Var ForgeStorageDir
Var ForgeStorageInput
Var ForgeStorageFree
Var ExistingForgeStorage
Var MsSweepDir
!ifdef MS_ELECTRON_GUID
  Var MsElectronDir
!endif
!include "${__FILEDIR__}\medley-upgrade.nsh"

; ---- Temp checks and the Forge default (.onInit, before SetContext) --------

!macro MIDISTUDIO_ONINIT_EARLY
  ; Windows unpacks the installer's plugins through Temp on C: whatever the
  ; target drive. A full or unwritable Temp otherwise fails with a random
  ; nsXXXX.tmp path that explains nothing.
  StrCpy $2 $TEMP 3
  ${DriveSpace} "$2" "/D=F /S=M" $3
  ${If} $3 != ""
  ${AndIf} $3 < 64
    MessageBox MB_ICONSTOP|MB_OK "Not enough free space on $2 to unpack the installer.$\r$\n$\r$\nFree: $3 MB, needed: at least 64 MB.$\r$\n$\r$\nWindows unpacks installers through the Temp folder on $2 even when you install MIDI Studio to another drive. Free some space on $2 and run this again." /SD IDOK
    Abort
  ${EndIf}
  ClearErrors
  InitPluginsDir
  ${If} $PLUGINSDIR == ""
    MessageBox MB_ICONSTOP|MB_OK "Windows Temp folder is not writable:$\r$\n$TEMP$\r$\n$\r$\nThat is where installers unpack. Check the folder exists and that antivirus is not blocking it, then run this again." /SD IDOK
    Abort
  ${EndIf}
  !ifdef MS_ELECTRON_GUID
    StrCpy $ForgeStorageDir "$LOCALAPPDATA\midi-studio\forge-env"
  !else
    StrCpy $ForgeStorageDir "$LOCALAPPDATA\${PRODUCTNAME}\forge-env"
  !endif
!macroend

; SetContext has now selected the same registry view as the x64 Electron installer.
!macro MIDISTUDIO_READ_FORGE_STORAGE

  ; $ExistingForgeStorage stays empty unless a choice is recorded; the
  ; post-install step uses it to never replace a real choice with a default.
  ; An elevated run reads the ADMIN's HKCU, hence the HKLM mirror.
  ReadRegStr $ExistingForgeStorage HKCU "${MS_FORGE_KEY}" "${MS_FORGE_VALUE}"
  ${If} $ExistingForgeStorage == ""
    ReadRegStr $ExistingForgeStorage HKLM "${MS_FORGE_KEY}" "${MS_FORGE_VALUE}"
  ${EndIf}
  ${If} $ExistingForgeStorage != ""
    StrCpy $ForgeStorageDir $ExistingForgeStorage
  ${EndIf}
!macroend

; ---- Following the Electron install (.onInit, after MULTIUSER_INIT) --------

!macro MIDISTUDIO_ONINIT_LATE
  !ifdef MS_ELECTRON_GUID
    ; Only while this Tauri build has never been installed: after that, its
    ; own recorded mode and folder are the ones to keep.
    ReadRegStr $0 HKLM "${UNINSTKEY}" "UninstallString"
    ReadRegStr $1 HKCU "${UNINSTKEY}" "UninstallString"
    ${If} "$0$1" == ""
      ReadRegStr $2 HKLM "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
      ${If} $2 != ""
        !if "${INSTALLMODE}" == "both"
          ${If} $MultiUser.Privileges == "Admin"
          ${OrIf} $MultiUser.Privileges == "Power"
            Call MultiUser.InstallMode.AllUsers
          ${EndIf}
        !endif
      ${Else}
        ReadRegStr $2 HKCU "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
        ${If} $2 != ""
          !if "${INSTALLMODE}" == "both"
            Call MultiUser.InstallMode.CurrentUser
          !endif
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !endif
!macroend

; ---- The Forge storage page ------------------------------------------------

!macro MIDISTUDIO_FORGE_PAGE
  Page custom ForgeStoragePageCreate ForgeStoragePageLeave
!macroend

Function ForgeStoragePageCreate
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  !insertmacro MUI_HEADER_TEXT "Forge storage" "Choose where the AI engine and models are stored."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 26u "Choose a local drive for Forge's engine and models. Setup checks for an existing Medley model before replacing the app."
  Pop $0
  ${NSD_CreateLabel} 0 38u 100% 10u "Forge storage folder:"
  Pop $0
  ${NSD_CreateText} 0 52u 78% 13u "$ForgeStorageDir"
  Pop $ForgeStorageInput
  ${NSD_CreateBrowseButton} 80% 51u 20% 15u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 ForgeStorageBrowse
  ${NSD_CreateLabel} 0 70u 100% 10u ""
  Pop $ForgeStorageFree
  Call ForgeStorageShowFree
  ${NSD_CreateLabel} 0 82u 100% 20u "Setup downloads ~4 GB and needs about 15 GB free on this drive. Your MIDI files stay in Documents\MIDI Studio."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function ForgeStorageShowFree
  StrCpy $2 $ForgeStorageDir 3
  ${DriveSpace} "$2" "/D=F /S=G" $3
  ${If} $3 == ""
    ${NSD_SetText} $ForgeStorageFree ""
  ${Else}
    ${NSD_SetText} $ForgeStorageFree "$3 GB free on $2"
  ${EndIf}
FunctionEnd

Function ForgeStorageBrowse
  ${NSD_GetText} $ForgeStorageInput $ForgeStorageDir
  nsDialogs::SelectFolderDialog "Choose a drive or parent folder for Forge storage" "$ForgeStorageDir"
  Pop $0
  ${If} $0 != error
    ${GetFileName} "$0" $1
    ${If} $1 == "${MS_FORGE_FOLDER}"
    ${OrIf} $1 == "forge-env"
      StrCpy $ForgeStorageDir "$0"
    ${Else}
      StrCpy $ForgeStorageDir "$0\${MS_FORGE_FOLDER}"
    ${EndIf}
    ${NSD_SetText} $ForgeStorageInput "$ForgeStorageDir"
    Call ForgeStorageShowFree
  ${EndIf}
FunctionEnd

Function ForgeStoragePageLeave
  ${NSD_GetText} $ForgeStorageInput $ForgeStorageDir
  ${If} $ForgeStorageDir == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Choose a Forge storage folder." /SD IDOK
    Abort
  ${EndIf}
  ; The app creates its own storage as its normal user. Never probe an
  ; arbitrary typed/registry path (or a planted write-test file) as admin.
  ${GetRoot} "$ForgeStorageDir" $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Choose an absolute local Forge storage folder." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

; ---- Closing what runs from a folder ----------------------------------------

; Every process whose executable lives under $MsSweepDir: the app, a Forge
; job's forge-rs.exe, and for the Electron build its bundled python sidecar,
; which outlived a force-killed app. Matched on the folder plus a backslash so
; "MIDI Studio" never matches "MIDI Studio Test". The installer's own process
; is excluded by id, whatever folder it was started from.
Function MidiStudioSweep
  StrLen $0 $MsSweepDir
  ${If} $0 < 4
    Return
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i .r1'
  ; Pass paths as data: apostrophes in a user's install directory are valid.
  System::Call 'kernel32::SetEnvironmentVariableW(w "MIDI_STUDIO_SWEEP_DIR", w "$MsSweepDir") i'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$d = $$env:MIDI_STUDIO_SWEEP_DIR + '\'; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne $1 -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
FunctionEnd

; ---- Install section --------------------------------------------------------

!macro NSIS_HOOK_PREINSTALL
  !ifdef MS_ELECTRON_GUID
    !if "${INSTALLMODE}" == "both"
      ${If} $MultiUser.InstallMode == "AllUsers"
        ReadRegStr $0 HKCU "${MS_ELECTRON_INSTKEY}" "InstallLocation"
      ${Else}
        ReadRegStr $0 HKLM "${MS_ELECTRON_INSTKEY}" "InstallLocation"
      ${EndIf}
      ${If} $0 != ""
      ${AndIf} $0 == $INSTDIR
        MessageBox MB_ICONSTOP|MB_OK "This folder belongs to MIDI Studio installed for a different scope. Select its original install scope or choose another folder." /SD IDOK
        Abort
      ${EndIf}
    !endif
  !endif
  Call MidiStudioPreserveMedley
  ; Close only processes from the install folder, never the updater's tree
  ; or another user's installation with the same executable name.
  DetailPrint "Closing ${PRODUCTNAME} if it is running..."
  StrCpy $MsSweepDir "$INSTDIR"
  Call MidiStudioSweep

  !ifdef MS_ELECTRON_GUID
    ; The Electron build, in the scope being installed to. Its uninstaller is
    ; copied out first (electron-builder's own upgrade does the same), run
    ; silently, told this is an update so app data is kept, and pointed at
    ; its folder with _?= so it waits.
    ReadRegStr $2 SHCTX "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
    ReadRegStr $MsElectronDir SHCTX "${MS_ELECTRON_INSTKEY}" "InstallLocation"
    ${If} $2 != ""
      ${If} $MsElectronDir == ""
      ${OrIfNot} ${FileExists} "$MsElectronDir\${MS_ELECTRON_UNINSTALLER}"
        MessageBox MB_ICONSTOP|MB_OK "The previous MIDI Studio installation is incomplete. Repair or remove it before installing this update." /SD IDOK
        Abort
      ${EndIf}
      ; Electron removes its entire tree, including a custom Forge store
      ; under it. Changing the wizard field alone does not move those files.
      ${If} $ExistingForgeStorage != ""
        GetFullPathName $0 "$ExistingForgeStorage"
        GetFullPathName $1 "$MsElectronDir"
        StrCpy $1 "$1\"
        StrLen $4 $1
        StrCpy $0 "$0\" $4
        ${If} $0 == $1
          MessageBox MB_ICONSTOP|MB_OK "Forge storage is inside the old install folder. Move it using MIDI Studio's storage settings before running this update." /SD IDOK
          Abort
        ${EndIf}
      ${EndIf}
      DetailPrint "Removing the previous MIDI Studio (Electron) from $MsElectronDir..."
      ${If} $MsElectronDir != $INSTDIR
        StrCpy $MsSweepDir "$MsElectronDir"
        Call MidiStudioSweep
      ${EndIf}
      Sleep 700
      StrCpy $3 "/currentuser"
      !if "${INSTALLMODE}" == "both"
        ${If} $MultiUser.InstallMode == "AllUsers"
          StrCpy $3 "/allusers"
        ${EndIf}
      !else if "${INSTALLMODE}" == "perMachine"
        StrCpy $3 "/allusers"
      !endif
      ${If} $MsElectronDir == $INSTDIR
        ; Same exe name, path and AppUserModelID: keep existing pins and links.
        StrCpy $3 "$3 --keep-shortcuts"
      ${EndIf}
      ClearErrors
      ; Copy to one exact file (not Shell CopyFiles' directory semantics).
      System::Call 'kernel32::CopyFileW(w "$MsElectronDir\${MS_ELECTRON_UNINSTALLER}", w "$PLUGINSDIR\electron-uninstaller.exe", i 0) i.r0'
      ${If} $0 = 0
        MessageBox MB_ICONSTOP|MB_OK "Could not copy the previous uninstaller. Remove the old version from Settings > Apps first." /SD IDOK
        Abort
      ${EndIf}
      ; A per-user installation is writable. Never elevate a binary just
      ; because it lives there. Lock our copy against replacement from the
      ; hash check through ExecWait, and use the system PowerShell by path.
      System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR\electron-uninstaller.exe", i 0x80000000, i 1, p 0, i 3, i 0, p 0) p .r5'
      ${If} $5 = -1
        MessageBox MB_ICONSTOP|MB_OK "Could not verify the previous uninstaller. Remove the old version from Settings > Apps first." /SD IDOK
        Abort
      ${EndIf}
      ; nsExec's child cwd is not $OUTDIR. Hash the very file locked above
      ; without module lookup or interpreting a filesystem path as shell code.
      System::Call 'kernel32::SetEnvironmentVariableW(w "MS_STUDIO_LEGACY_UNINSTALLER", w "$PLUGINSDIR\electron-uninstaller.exe") i.r0'
      ${If} $0 != 0
        SetOutPath "$SYSDIR"
        nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "try { $$f=[IO.File]::OpenRead($$env:MS_STUDIO_LEGACY_UNINSTALLER); try { $$h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($$f)).Replace('-',''); if ($$h -eq '${MS_ELECTRON_UNINSTALLER_SHA256}') { exit 0 } } finally { $$f.Dispose() } } catch { }; exit 1"`
        Pop $0
      ${Else}
        StrCpy $0 1
      ${EndIf}
      ${If} $0 != 0
        System::Call 'kernel32::CloseHandle(p r5)'
        MessageBox MB_ICONSTOP|MB_OK "This is not the published MIDI Studio 3.0.1 uninstaller. To keep your data, remove the old version from Settings > Apps without deleting app data, then run this setup again." /SD IDOK
        Abort
      ${EndIf}
      ClearErrors
      ExecWait '"$PLUGINSDIR\electron-uninstaller.exe" /S /KEEP_APP_DATA --updated $3 _?=$MsElectronDir' $0
      System::Call 'kernel32::CloseHandle(p r5)'
      ${If} ${Errors}
      ${OrIf} $0 != 0
        MessageBox MB_ICONSTOP|MB_OK "Could not remove the previous MIDI Studio. Close it and retry, or uninstall it from Settings > Apps before installing this update." /SD IDOK
        Abort
      ${EndIf}
      ReadRegStr $2 SHCTX "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
      ${If} $2 != ""
        MessageBox MB_ICONSTOP|MB_OK "The previous MIDI Studio is still registered. Remove it from Settings > Apps before installing this update." /SD IDOK
        Abort
      ${EndIf}
      Delete "$PLUGINSDIR\electron-uninstaller.exe"
      ; It may have removed this very folder; the files below need it back.
      SetOutPath $INSTDIR
    ${Else}
      ; Installed in the other scope (for all users vs just me): left alone,
      ; and said so in the log instead of uninstalling across scopes.
      ReadRegStr $2 HKLM "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
      ReadRegStr $4 HKCU "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
      ${If} "$2$4" != ""
        DetailPrint "A previous MIDI Studio is installed for a different scope; uninstall it from Settings > Apps."
      ${EndIf}
    ${EndIf}
  !endif
  Sleep 300
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Record the choice; the app reads it on first run (and syncs it back when
  ; it moves the env). Never launch the app from here: a process started
  ; mid-install, elevated, is what used to break shortcuts and the next
  ; install's running-app check.
  ;
  ; A silent run never shows the page, so $ForgeStorageDir is only the
  ; computed default; it must not replace a choice that is already recorded.
  ${If} ${Silent}
  ${AndIf} $ExistingForgeStorage != ""
    DetailPrint "Keeping existing Forge storage: $ExistingForgeStorage"
  ${Else}
    WriteRegStr HKCU "${MS_FORGE_KEY}" "${MS_FORGE_VALUE}" "$ForgeStorageDir"
    ; Mirrored for an ELEVATED installer next time, which sees the admin's
    ; HKCU. Fails harmlessly in a per-user, unelevated install.
    ClearErrors
    WriteRegStr HKLM "${MS_FORGE_KEY}" "${MS_FORGE_VALUE}" "$ForgeStorageDir"
    ClearErrors
  ${EndIf}
!macroend
