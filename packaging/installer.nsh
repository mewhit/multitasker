!include "nsDialogs.nsh"
!ifndef BUILD_UNINSTALLER
Var StartupEnabled
Var StartupCheckbox

!macro customInit
  StrCpy $StartupEnabled "1"
!macroend

!macro customPageAfterChangeDir
  Page custom MultitaskerStartupPage MultitaskerStartupLeave

  Function MultitaskerStartupPage
    !insertmacro MUI_HEADER_TEXT "Automatic startup" "Choose when Multitasker opens."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 12u 100% 24u "Start Multitasker when I sign in to Windows"
    Pop $StartupCheckbox
    ${NSD_SetState} $StartupCheckbox $StartupEnabled
    nsDialogs::Show
  FunctionEnd

  Function MultitaskerStartupLeave
    ${NSD_GetState} $StartupCheckbox $StartupEnabled
  FunctionEnd
!macroend

!macro customInstall
  ${If} $StartupEnabled == "1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Multitasker" '"$INSTDIR\Multitasker.exe"'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Multitasker"
  ${EndIf}
!macroend

!endif
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Multitasker"
!macroend
