; TreeBoss Windows installer hooks (electron-builder NSIS; wired in electron-builder.yml as nsis.include).
;
; One extra page after "choose folder" with four checkboxes, all on by default (like VS Code's installer):
;   - "Open with TreeBoss" on folders (right-click a folder, and the background of an open folder)
;   - "Open with TreeBoss" on files
;   - register TreeBoss as an editor for the code and text file types (Open with, not the default app)
;   - add trb to the user PATH (resources\bin holds trb.exe, the CLI)
; Everything is written under SHELL_CONTEXT (HKCU for a per-user install, HKLM for all users) and removed on uninstall.
; The PATH entry is only removed when this installer added it.

; Installer only: the uninstaller build never reads these, and NSIS treats an unused variable as an error here.
!ifndef BUILD_UNINSTALLER
  Var TB_BoxDir
  Var TB_BoxFile
  Var TB_BoxEditor
  Var TB_BoxPath
  Var TB_CtxDir
  Var TB_CtxFile
  Var TB_Editor
  Var TB_Path
!endif

; Extensions TreeBoss opens as an editor: the code and text types the daemon reads (src/lab/sessions.ts).
!macro TB_ASSOC_REG EXT
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "TreeBoss.File"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\TreeBoss.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro TB_ASSOC_UNREG EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "TreeBoss.File"
!macroend

!macro TB_EACH_EXT ACTION
  !insertmacro ${ACTION} "ts"
  !insertmacro ${ACTION} "tsx"
  !insertmacro ${ACTION} "js"
  !insertmacro ${ACTION} "jsx"
  !insertmacro ${ACTION} "mjs"
  !insertmacro ${ACTION} "cjs"
  !insertmacro ${ACTION} "py"
  !insertmacro ${ACTION} "rs"
  !insertmacro ${ACTION} "go"
  !insertmacro ${ACTION} "rb"
  !insertmacro ${ACTION} "java"
  !insertmacro ${ACTION} "kt"
  !insertmacro ${ACTION} "swift"
  !insertmacro ${ACTION} "c"
  !insertmacro ${ACTION} "cc"
  !insertmacro ${ACTION} "cpp"
  !insertmacro ${ACTION} "h"
  !insertmacro ${ACTION} "hpp"
  !insertmacro ${ACTION} "cs"
  !insertmacro ${ACTION} "php"
  !insertmacro ${ACTION} "vue"
  !insertmacro ${ACTION} "svelte"
  !insertmacro ${ACTION} "css"
  !insertmacro ${ACTION} "scss"
  !insertmacro ${ACTION} "html"
  !insertmacro ${ACTION} "sql"
  !insertmacro ${ACTION} "md"
  !insertmacro ${ACTION} "json"
  !insertmacro ${ACTION} "yaml"
  !insertmacro ${ACTION} "yml"
  !insertmacro ${ACTION} "toml"
  !insertmacro ${ACTION} "sh"
!macroend

; Defaults for the checkboxes; a silent install (/S) never shows the page, so these apply there.
!macro customInit
  StrCpy $TB_CtxDir "1"
  StrCpy $TB_CtxFile "1"
  StrCpy $TB_Editor "1"
  StrCpy $TB_Path "1"
!macroend

; The page. Defined in the macro so it is only compiled into the installer, where nsDialogs and LogicLib are loaded.
!macro customPageAfterChangeDir
  Function TreeBossIntegrationPage
    ${If} ${Silent}
      Abort
    ${EndIf}
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    nsDialogs::CreateControl STATIC 0x50000000 0 0 0 300 24 "Choose how Windows should work with TreeBoss. You can uninstall to remove these."
    Pop $0

    nsDialogs::CreateControl BUTTON 0x50010003 0 0 34 300 12 "Add Open with TreeBoss to folder right-click menus"
    Pop $TB_BoxDir
    SendMessage $TB_BoxDir 0xF1 $TB_CtxDir 0

    nsDialogs::CreateControl BUTTON 0x50010003 0 0 52 300 12 "Add Open with TreeBoss to file right-click menus"
    Pop $TB_BoxFile
    SendMessage $TB_BoxFile 0xF1 $TB_CtxFile 0

    nsDialogs::CreateControl BUTTON 0x50010003 0 0 70 300 12 "Register TreeBoss as an editor for code and text files"
    Pop $TB_BoxEditor
    SendMessage $TB_BoxEditor 0xF1 $TB_Editor 0

    nsDialogs::CreateControl BUTTON 0x50010003 0 0 88 300 12 "Add trb to PATH, so trb . opens a folder from any terminal"
    Pop $TB_BoxPath
    SendMessage $TB_BoxPath 0xF1 $TB_Path 0

    nsDialogs::Show
  FunctionEnd

  Function TreeBossIntegrationLeave
    SendMessage $TB_BoxDir 0xF0 0 0 $TB_CtxDir
    SendMessage $TB_BoxFile 0xF0 0 0 $TB_CtxFile
    SendMessage $TB_BoxEditor 0xF0 0 0 $TB_Editor
    SendMessage $TB_BoxPath 0xF0 0 0 $TB_Path
  FunctionEnd

  Page custom TreeBossIntegrationPage TreeBossIntegrationLeave
!macroend

; electron-builder only includes GetProcessInfo when no customCheckAppRunning is defined, and the stock check needs it.
!include "getProcessInfo.nsh"
Var pid

; Runs before the installer closes TreeBoss and copies files. Stop the daemon the way quitting the app does,
; so trb.exe is not locked, then run the stock check (it closes TreeBoss.exe). Without this hook the
; stock check runs alone and leaves the daemon running.
!macro customCheckAppRunning
  IfFileExists "$INSTDIR\resources\bin\trb.exe" 0 +3
    nsExec::Exec `"$INSTDIR\resources\bin\trb.exe" daemon stop`
    Pop $0
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

; $appExe is set by the install section before this runs.
!macro customInstall
  ${If} $TB_CtxDir == "1"
    WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\TreeBoss" "" "Open with TreeBoss"
    WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\TreeBoss" "Icon" "$appExe,0"
    WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\TreeBoss\command" "" `"$appExe" "%V"`
    WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\TreeBoss" "" "Open with TreeBoss"
    WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\TreeBoss" "Icon" "$appExe,0"
    WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\TreeBoss\command" "" `"$appExe" "%V"`
  ${EndIf}

  ${If} $TB_CtxFile == "1"
    WriteRegStr SHELL_CONTEXT "Software\Classes\*\shell\TreeBoss" "" "Open with TreeBoss"
    WriteRegStr SHELL_CONTEXT "Software\Classes\*\shell\TreeBoss" "Icon" "$appExe,0"
    WriteRegStr SHELL_CONTEXT "Software\Classes\*\shell\TreeBoss\command" "" `"$appExe" "%1"`
  ${EndIf}

  ${If} $TB_Editor == "1"
    WriteRegStr SHELL_CONTEXT "Software\Classes\TreeBoss.File" "" "TreeBoss file"
    WriteRegStr SHELL_CONTEXT "Software\Classes\TreeBoss.File\DefaultIcon" "" "$appExe,0"
    WriteRegStr SHELL_CONTEXT "Software\Classes\TreeBoss.File\shell\open\command" "" `"$appExe" "%1"`
    WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\TreeBoss.exe" "FriendlyAppName" "TreeBoss"
    WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\TreeBoss.exe\shell\open\command" "" `"$appExe" "%1"`
    !insertmacro TB_EACH_EXT TB_ASSOC_REG
  ${EndIf}

  ${If} $TB_Path == "1"
    ; NSIS strings are capped at NSIS_MAX_STRLEN, so a long PATH cannot be edited here. PowerShell edits the raw
    ; registry value instead (no length cap, %VARS% kept unexpanded). Exit code 10 means the entry was added.
    System::Call 'Kernel32::SetEnvironmentVariable(t "TB_BIN", t "$INSTDIR\resources\bin")'
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$$true); $$p=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$b=$$env:TB_BIN; if(($$p -split ';') -contains $$b){exit 0}; if($$p){$$p=$$p+';'+$$b}else{$$p=$$b}; $$k.SetValue('Path',$$p,[Microsoft.Win32.RegistryValueKind]::ExpandString); $$k.Close(); exit 10"`
    Pop $0
    ${If} $0 == "10"
      WriteRegStr HKCU "Software\TreeBoss\Integration" "PathAdded" "1"
      SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
    ${ElseIf} $0 != "0"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Could not add $INSTDIR\resources\bin to your PATH. Add it by hand to use trb."
    ${EndIf}
  ${EndIf}

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Directory\shell\TreeBoss"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Directory\Background\shell\TreeBoss"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\*\shell\TreeBoss"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\TreeBoss.File"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\TreeBoss.exe"
  !insertmacro TB_EACH_EXT TB_ASSOC_UNREG

  ; Take our entry back out of PATH, and only ours: it is the last item, as customInstall appended it.
  ReadRegStr $1 HKCU "Software\TreeBoss\Integration" "PathAdded"
  ${If} $1 == "1"
    System::Call 'Kernel32::SetEnvironmentVariable(t "TB_BIN", t "$INSTDIR\resources\bin")'
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$$true); $$p=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$s=';'+$$env:TB_BIN; if($$p.EndsWith($$s,[StringComparison]::OrdinalIgnoreCase)){$$k.SetValue('Path',$$p.Substring(0,$$p.Length-$$s.Length),[Microsoft.Win32.RegistryValueKind]::ExpandString); $$k.Close(); exit 10}; $$k.Close(); exit 0"`
    Pop $0
    ${If} $0 == "10"
      SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
  DeleteRegKey HKCU "Software\TreeBoss\Integration"

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
