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
!endif

Var ForgeStorageDir
Var ForgeStorageInput
Var ForgeStorageFree
Var ExistingForgeStorage
Var MsSweepDir
!ifdef MS_ELECTRON_GUID
  Var MsElectronDir
!endif

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
  FileOpen $4 "$TEMP\.midi-studio-temp-test" w
  ${If} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "Windows Temp folder is not writable:$\r$\n$TEMP$\r$\n$\r$\nThat is where installers unpack. Check the folder exists and that antivirus is not blocking it, then run this again." /SD IDOK
    Abort
  ${EndIf}
  FileWrite $4 "ok"
  FileClose $4
  Delete "$TEMP\.midi-studio-temp-test"

  ; $ExistingForgeStorage stays empty unless a choice is recorded; the
  ; post-install step uses it to never replace a real choice with a default.
  ; An elevated run reads the ADMIN's HKCU, hence the HKLM mirror.
  ReadRegStr $ExistingForgeStorage HKCU "${MS_FORGE_KEY}" "${MS_FORGE_VALUE}"
  ${If} $ExistingForgeStorage == ""
    ReadRegStr $ExistingForgeStorage HKLM "${MS_FORGE_KEY}" "${MS_FORGE_VALUE}"
  ${EndIf}
  StrCpy $ForgeStorageDir $ExistingForgeStorage
  ${If} $ForgeStorageDir == ""
    ; Still the user's shell context here, so this is their own LocalAppData
    ; and not C:\ProgramData.
    StrCpy $ForgeStorageDir "$LOCALAPPDATA\midi-studio\forge-env"
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
        ReadRegStr $MsElectronDir HKLM "${MS_ELECTRON_INSTKEY}" "InstallLocation"
        !if "${INSTALLMODE}" == "both"
          ${If} $MultiUser.Privileges == "Admin"
          ${OrIf} $MultiUser.Privileges == "Power"
            Call MultiUser.InstallMode.AllUsers
          ${EndIf}
        !endif
      ${Else}
        ReadRegStr $2 HKCU "${MS_ELECTRON_UNINSTKEY}" "UninstallString"
        ${If} $2 != ""
          ReadRegStr $MsElectronDir HKCU "${MS_ELECTRON_INSTKEY}" "InstallLocation"
          !if "${INSTALLMODE}" == "both"
            Call MultiUser.InstallMode.CurrentUser
          !endif
        ${EndIf}
      ${EndIf}
      ${If} $MsElectronDir != ""
        StrCpy $INSTDIR $MsElectronDir
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

  ${NSD_CreateLabel} 0 0 100% 26u "Forge downloads several GB of engine and model files. Choose a writable drive with enough free space. Existing managed files will be moved during setup."
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
  ; Create BEFORE resolving: GetFullPathName blanks the variable for a path
  ; that does not exist yet, which on a first install it never does.
  ClearErrors
  CreateDirectory "$ForgeStorageDir"
  GetFullPathName $1 "$ForgeStorageDir"
  ${If} $1 != ""
    StrCpy $ForgeStorageDir $1
  ${EndIf}
  ClearErrors
  FileOpen $0 "$ForgeStorageDir\.midi-studio-write-test" w
  IfErrors ForgeStorageNotWritable
  FileWrite $0 "ok"
  FileClose $0
  Delete "$ForgeStorageDir\.midi-studio-write-test"
  Return

  ForgeStorageNotWritable:
    MessageBox MB_ICONEXCLAMATION|MB_OK "That folder is not writable. Choose another location." /SD IDOK
    Abort
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
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$MsSweepDir' + '\'; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne $1 -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
FunctionEnd

; ---- Install section --------------------------------------------------------

!macro NSIS_HOOK_PREINSTALL
  ; No "MIDI Studio is running" dialog: close it and carry on.
  ;
  ; NO /t. The in-app updater starts this installer, and /t kills the whole
  ; tree of the named process, which once included the installer itself:
  ; "check for updates" closed the app and then did nothing. The updater now
  ; starts it through Start-Process, outside the app's tree, and this still
  ; names only the image. Anything else of ours is swept by folder below.
  DetailPrint "Closing ${PRODUCTNAME} if it is running..."
  nsExec::Exec 'taskkill /f /im "${MAINBINARYNAME}.exe"'
  Pop $0
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
    ${AndIf} $MsElectronDir != ""
    ${AndIf} ${FileExists} "$MsElectronDir\${MS_ELECTRON_UNINSTALLER}"
      DetailPrint "Removing the previous MIDI Studio (Electron) from $MsElectronDir..."
      StrCpy $MsSweepDir "$MsElectronDir"
      Call MidiStudioSweep
      Sleep 700
      StrCpy $3 "/currentuser"
      !if "${INSTALLMODE}" == "both"
        ${If} $MultiUser.InstallMode == "AllUsers"
          StrCpy $3 "/allusers"
        ${EndIf}
      !else if "${INSTALLMODE}" == "perMachine"
        StrCpy $3 "/allusers"
      !endif
      CopyFiles /SILENT "$MsElectronDir\${MS_ELECTRON_UNINSTALLER}" "$PLUGINSDIR\electron-uninstaller.exe"
      ClearErrors
      ExecWait '"$PLUGINSDIR\electron-uninstaller.exe" /S /KEEP_APP_DATA --updated $3 _?=$MsElectronDir' $0
      ${If} ${Errors}
        DetailPrint "The previous MIDI Studio's uninstaller could not be started; its files stay in $MsElectronDir."
      ${ElseIf} $0 != 0
        DetailPrint "The previous MIDI Studio's uninstaller exited with $0; continuing."
      ${Else}
        DetailPrint "Previous MIDI Studio removed. Settings and Forge files are kept."
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
