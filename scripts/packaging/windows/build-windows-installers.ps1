# Montr Windows Installer Build Script
# Prerequisites: Node.js 20+, Rust toolchain, NSIS 3.x (makensis in PATH)

param(
    [switch]$ServerOnly,
    [switch]$ClientOnly,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path "$ScriptDir\..\..\..\"
$BuildDir = "$ProjectRoot\build"

Write-Host "=== Montr Windows Installer Build ===" -ForegroundColor Cyan

# Create build output directory
if (-not (Test-Path $BuildDir)) {
    New-Item -ItemType Directory -Path $BuildDir | Out-Null
}

# ── Build Server ──────────────────────────────────────────────
if (-not $ClientOnly) {
    Write-Host "`n--- Building Server ---" -ForegroundColor Yellow

    if (-not $SkipBuild) {
        Push-Location "$ProjectRoot\server"
        try {
            Write-Host "Installing dependencies..."
            npm ci --legacy-peer-deps

            Write-Host "Compiling TypeScript..."
            npx tsc
            if (-not (Test-Path "dist\database")) {
                New-Item -ItemType Directory -Path "dist\database" | Out-Null
            }
            Copy-Item "src\database\schema.sql" "dist\database\"
            Copy-Item -Recurse "src\web" "dist\web" -Force

            Write-Host "Pruning to production dependencies..."
            npm ci --omit=dev --legacy-peer-deps
        } finally {
            Pop-Location
        }
    }

    # Download WinSW if not present
    $WinSWPath = "$ScriptDir\WinSW.exe"
    if (-not (Test-Path $WinSWPath)) {
        Write-Host "Downloading WinSW..."
        $WinSWUrl = "https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-x64.exe"
        Invoke-WebRequest -Uri $WinSWUrl -OutFile $WinSWPath
    }

    Write-Host "Building server installer..."
    makensis "$ScriptDir\server-installer.nsi"
    Write-Host "Server installer: $BuildDir\montr-server-setup-1.0.0.exe" -ForegroundColor Green
}

# ── Build Client ──────────────────────────────────────────────
if (-not $ServerOnly) {
    Write-Host "`n--- Building Client ---" -ForegroundColor Yellow

    if (-not $SkipBuild) {
        Push-Location "$ProjectRoot\client"
        try {
            Write-Host "Compiling Rust client (release)..."
            cargo build --release
        } finally {
            Pop-Location
        }
    }

    Write-Host "Building client installer..."
    makensis "$ScriptDir\client-installer.nsi"
    Write-Host "Client installer: $BuildDir\montr-client-setup-1.0.0.exe" -ForegroundColor Green
}

Write-Host "`n=== Build Complete ===" -ForegroundColor Cyan
