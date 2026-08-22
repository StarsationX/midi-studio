!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"
  !include "MUI2.nsh"
  !include "FileFunc.nsh"

  Var ForgeStorageDir
  Var ForgeStorageInput

  !macro customInit
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
    ${NSD_CreateLabel} 0 76u 100% 24u "Your MIDI files remain in Documents\MIDI Studio. This setting only controls the Forge engine, dependencies, and models."
    Pop $0
    nsDialogs::Show
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
    ${EndIf}
  FunctionEnd

  Function ForgeStoragePageLeave
    ${NSD_GetText} $ForgeStorageInput $ForgeStorageDir
    ${If} $ForgeStorageDir == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "Choose a Forge storage folder."
      Abort
    ${EndIf}
    GetFullPathName $ForgeStorageDir "$ForgeStorageDir"
    ClearErrors
    CreateDirectory "$ForgeStorageDir"
    FileOpen $0 "$ForgeStorageDir\.midi-studio-write-test" w
    IfErrors ForgeStorageNotWritable
    FileWrite $0 "ok"
    FileClose $0
    Delete "$ForgeStorageDir\.midi-studio-write-test"
    Return

    ForgeStorageNotWritable:
      MessageBox MB_ICONEXCLAMATION|MB_OK "That folder is not writable. Choose another location."
      Abort
  FunctionEnd

  !macro customInstall
    WriteRegStr HKCU "Software\StarsationX\MIDI Studio" "ForgeStorageDir" "$ForgeStorageDir"
    DetailPrint "Configuring Forge storage..."
    ExecWait '\"$appExe\" --configure-forge-storage \"$ForgeStorageDir\"' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "MIDI Studio was installed, but Forge storage could not be configured. You can choose it later in Settings."
    ${EndIf}
  !macroend
!endif
