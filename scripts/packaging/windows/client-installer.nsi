; Montr Client Windows Installer
; Requires NSIS 3.x with MUI2

!include "MUI2.nsh"
!include "FileFunc.nsh"

; ── General ──────────────────────────────────────────────────
!define PRODUCT_NAME "Montr Client"
!define PRODUCT_VERSION "1.0.0"
!define PRODUCT_PUBLISHER "Montr Contributors"
!define PRODUCT_URL "https://github.com/Malco-Enterprises-of-Nevada/Montr"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MontrClient"
!define DATA_DIR "$COMMONPROGRAMDATA\Montr"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "..\..\..\..\build\montr-client-setup-${PRODUCT_VERSION}.exe"
InstallDir "$PROGRAMFILES\Montr Client"
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

    ; Client binary
    File "..\..\..\client\target\release\montr-client.exe"

    ; Create data directories
    CreateDirectory "${DATA_DIR}"
    CreateDirectory "${DATA_DIR}\cache"
    CreateDirectory "${DATA_DIR}\logs"

    ; Configuration — only copy if not already present (preserve existing config)
    IfFileExists "${DATA_DIR}\config.toml" +2 0
    CopyFiles /SILENT "..\..\..\client\config.example.toml" "${DATA_DIR}\config.toml"

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

Section "Windows Service" SecService
    ; Register as Windows Service using built-in support
    nsExec::ExecToLog '"$INSTDIR\montr-client.exe" --install-service'

    ; Start the service
    nsExec::ExecToLog 'net start MontrClient'
SectionEnd

Section "Start Menu Shortcuts" SecShortcuts
    CreateDirectory "$SMPROGRAMS\Montr Client"

    CreateShortCut "$SMPROGRAMS\Montr Client\Montr Client.lnk" \
        "$INSTDIR\montr-client.exe" \
        '--config "${DATA_DIR}\config.toml"' \
        "" "" "" "" "Run Montr Client"

    CreateShortCut "$SMPROGRAMS\Montr Client\Edit Configuration.lnk" \
        "notepad.exe" "${DATA_DIR}\config.toml"

    CreateShortCut "$SMPROGRAMS\Montr Client\Uninstall.lnk" \
        "$INSTDIR\uninstall.exe"
SectionEnd

; ── Section Descriptions ─────────────────────────────────────
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
    !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "Core client files (required)"
    !insertmacro MUI_DESCRIPTION_TEXT ${SecService} "Install as a Windows Service (auto-start on boot)"
    !insertmacro MUI_DESCRIPTION_TEXT ${SecShortcuts} "Create Start Menu shortcuts"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ── Uninstaller ──────────────────────────────────────────────

Section "Uninstall"
    ; Uninstall the Windows Service
    nsExec::ExecToLog '"$INSTDIR\montr-client.exe" --uninstall-service'

    ; Remove application files
    RMDir /r "$INSTDIR"

    ; Remove Start Menu shortcuts
    RMDir /r "$SMPROGRAMS\Montr Client"

    ; Remove registry keys
    DeleteRegKey HKLM "${PRODUCT_UNINST_KEY}"

    ; Ask about data removal
    MessageBox MB_YESNO "Remove client data (cache, logs, config)?$\r$\nLocation: ${DATA_DIR}" IDYES removeData IDNO skipData
    removeData:
        RMDir /r "${DATA_DIR}"
    skipData:
SectionEnd
