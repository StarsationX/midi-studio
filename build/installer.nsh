!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"
  !include "MUI2.nsh"
  !include "FileFunc.nsh"

  Var ForgeStorageDir
  Var ForgeStorageInput
  Var ForgeStorageFree

  !macro customInit
    ; The app bundles its own python.exe under $INSTDIR. If a previous run was
    ; force-killed, that child is still alive and electron-builder's
    ; "is the app running" check refuses to continue - with a dialog naming
    ; MIDI Studio, which the user has already closed. Clear that child only -
    ; a running app is still the installer's own prompt to handle.
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq \"python.exe\" -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(\"$INSTDIR\") } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
    Pop $0
    Pop $1

    ReadRegStr $ForgeStorageDir HKCU "Software\StarsationX\MIDI Studio" "ForgeStorageDir"
    ${If} $ForgeStorageDir == ""
      StrCpy $ForgeStorageDir "$LOCALAPPDATA\midi-studio\forge-env"
    ${EndIf}
  !macroend

  !macro customPageAfterChangeDir
    Page custom ForgeStoragePageCreate ForgeStoragePageLeave
  !macroend

  Function ForgeStoragePageCreate
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
      ${If} $1 == "MIDI Studio Forge"
      ${OrIf} $1 == "forge-env"
        StrCpy $ForgeStorageDir "$0"
      ${Else}
        StrCpy $ForgeStorageDir "$0\MIDI Studio Forge"
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
    ; Create BEFORE resolving: GetFullPathName blanks the variable when the path
    ; does not exist yet, which is always true on a first install — that is why
    ; choosing a custom folder silently fell back to the default.
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

  !macro customInstall
    WriteRegStr HKCU "Software\StarsationX\MIDI Studio" "ForgeStorageDir" "$ForgeStorageDir"
    DetailPrint "Configuring Forge storage..."
    ExecWait '\"$appExe\" --configure-forge-storage \"$ForgeStorageDir\"' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "MIDI Studio was installed, but Forge storage could not be configured. You can choose it later in Settings." /SD IDOK
    ${EndIf}
  !macroend
!endif
