; Montr Server Windows Installer
; Requires NSIS 3.x with MUI2

!include "MUI2.nsh"
!include "FileFunc.nsh"

; ── General ──────────────────────────────────────────────────
!define PRODUCT_NAME "Montr Server"
!define PRODUCT_VERSION "1.0.0"
!define PRODUCT_PUBLISHER "Montr Contributors"
!define PRODUCT_URL "https://github.com/Malco-Enterprises-of-Nevada/Montr"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MontrServer"
!define DATA_DIR "$COMMONPROGRAMDATA\Montr Server"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "..\..\..\..\build\montr-server-setup-${PRODUCT_VERSION}.exe"
InstallDir "$PROGRAMFILES\Montr Server"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

; ── MUI Settings ─────────────────────────────────────────────
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

; ── Pages ────────────────────────────────────────────────────
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── Sections ─────────────────────────────────────────────────

Section "Core Files (required)" SecCore
    SectionIn RO ; Read-only — always installed

    SetOutPath "$INSTDIR"

    ; Application files
    File /r "..\..\..\server\dist\*.*"
    File "..\..\..\server\package.json"

    ; node_modules (production only — run npm ci --omit=dev before building installer)
    SetOutPath "$INSTDIR\node_modules"
    File /r "..\..\..\server\node_modules\*.*"

    SetOutPath "$INSTDIR"

    ; Create data directories
    CreateDirectory "${DATA_DIR}"
    CreateDirectory "${DATA_DIR}\data"
    CreateDirectory "${DATA_DIR}\storage"
    CreateDirectory "${DATA_DIR}\logs"

    ; Configuration — only copy if not already present (preserve existing config)
    IfFileExists "${DATA_DIR}\montr-server.env" +2 0
    CopyFiles /SILENT "..\..\..\server\.env.example" "${DATA_DIR}\montr-server.env"

    ; Write uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; Registry entries for Add/Remove Programs
    WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
    WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
    WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
    WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "URLInfoAbout" "${PRODUCT_URL}"
    WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
    WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "InstallLocation" "$INSTDIR"

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Windows Service (WinSW)" SecService
    SetOutPath "$INSTDIR"

    ; Bundle WinSW — must be placed in the build directory before running makensis
    File "WinSW.exe"

    ; Create WinSW configuration
    FileOpen $0 "$INSTDIR\montr-server-service.xml" w
    FileWrite $0 '<service>$\r$\n'
    FileWrite $0 '  <id>MontrServer</id>$\r$\n'
    FileWrite $0 '  <name>Montr Media Server</name>$\r$\n'
    FileWrite $0 '  <description>Montr distributed media playlist server</description>$\r$\n'
    FileWrite $0 '  <executable>node</executable>$\r$\n'
    FileWrite $0 '  <arguments>"$INSTDIR\dist\index.js"</arguments>$\r$\n'
    FileWrite $0 '  <workingdirectory>$INSTDIR</workingdirectory>$\r$\n'
    FileWrite $0 '  <env name="NODE_ENV" value="production" />$\r$\n'
    FileWrite $0 '  <env name="PORT" value="3000" />$\r$\n'
    FileWrite $0 '  <env name="HOST" value="0.0.0.0" />$\r$\n'
    FileWrite $0 '  <env name="DB_TYPE" value="sqlite" />$\r$\n'
    FileWrite $0 '  <env name="DB_PATH" value="${DATA_DIR}\data\montr.db" />$\r$\n'
    FileWrite $0 '  <env name="STORAGE_PATH" value="${DATA_DIR}\storage" />$\r$\n'
    FileWrite $0 '  <env name="LOG_FILE" value="${DATA_DIR}\logs\server.log" />$\r$\n'
    FileWrite $0 '  <logpath>${DATA_DIR}\logs</logpath>$\r$\n'
    FileWrite $0 '  <log mode="roll-by-size">$\r$\n'
    FileWrite $0 '    <sizeThreshold>10240</sizeThreshold>$\r$\n'
    FileWrite $0 '    <keepFiles>5</keepFiles>$\r$\n'
    FileWrite $0 '  </log>$\r$\n'
    FileWrite $0 '  <onfailure action="restart" delay="10 sec" />$\r$\n'
    FileWrite $0 '  <onfailure action="restart" delay="30 sec" />$\r$\n'
    FileWrite $0 '  <startmode>Automatic</startmode>$\r$\n'
    FileWrite $0 '</service>$\r$\n'
    FileClose $0

    ; Rename WinSW to match the service XML name
    Rename "$INSTDIR\WinSW.exe" "$INSTDIR\montr-server-service.exe"

    ; Install and start the service
    nsExec::ExecToLog '"$INSTDIR\montr-server-service.exe" install'
    nsExec::ExecToLog '"$INSTDIR\montr-server-service.exe" start'
SectionEnd

Section "Start Menu Shortcuts" SecShortcuts
    CreateDirectory "$SMPROGRAMS\Montr Server"

    CreateShortCut "$SMPROGRAMS\Montr Server\Open Dashboard.lnk" \
        "http://localhost:3000" "" "" "" "" "" "Open Montr web dashboard"

    CreateShortCut "$SMPROGRAMS\Montr Server\Edit Configuration.lnk" \
        "notepad.exe" "${DATA_DIR}\montr-server.env"

    CreateShortCut "$SMPROGRAMS\Montr Server\Uninstall.lnk" \
        "$INSTDIR\uninstall.exe"
SectionEnd

; ── Section Descriptions ─────────────────────────────────────
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
    !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "Core server files (required)"
    !insertmacro MUI_DESCRIPTION_TEXT ${SecService} "Install as a Windows Service using WinSW (auto-start on boot)"
    !insertmacro MUI_DESCRIPTION_TEXT ${SecShortcuts} "Create Start Menu shortcuts"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ── Uninstaller ──────────────────────────────────────────────

Section "Uninstall"
    ; Stop and remove the WinSW service if installed
    IfFileExists "$INSTDIR\montr-server-service.exe" 0 +3
    nsExec::ExecToLog '"$INSTDIR\montr-server-service.exe" stop'
    nsExec::ExecToLog '"$INSTDIR\montr-server-service.exe" uninstall'

    ; Remove application files
    RMDir /r "$INSTDIR"

    ; Remove Start Menu shortcuts
    RMDir /r "$SMPROGRAMS\Montr Server"

    ; Remove registry keys
    DeleteRegKey HKLM "${PRODUCT_UNINST_KEY}"

    ; Ask about data removal
    MessageBox MB_YESNO "Remove server data (database, storage, logs)?$\r$\nLocation: ${DATA_DIR}" IDYES removeData IDNO skipData
    removeData:
        RMDir /r "${DATA_DIR}"
    skipData:
SectionEnd
