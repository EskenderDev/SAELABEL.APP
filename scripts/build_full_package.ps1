#===========================================================
# SAE STUDIO - FULL BUILD ORCHESTRATOR
#===========================================================
$ErrorActionPreference = "Stop"

$ScriptsDir = $PSScriptRoot
$RootDir = Split-Path -Parent $ScriptsDir
$TauriDir = Join-Path $RootDir "src-tauri"
$InnoDir = Join-Path $ScriptsDir "inno"
$ISCC = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Starting Full Production Build Workflow" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Build API Server
Write-Host "`n[1/3] Building .NET API Server (Single-File)..." -ForegroundColor Yellow
& "$ScriptsDir\build_server.ps1"

# 2. Build Tauri Frontend & Rust Core
Write-Host "`n[2/3] Building Tauri Application (Release)..." -ForegroundColor Yellow
Set-Location $RootDir
npm run tauri:build -- --no-bundle
Set-Location $ScriptsDir

# 3. Generate Inno Setup Installer
Write-Host "`n[3/3] Compiling Inno Setup Installer..." -ForegroundColor Yellow
if (Test-Path $ISCC) {
    & $ISCC "/DSourceDir=$TauriDir\target\release" "/DApiSourceDir=$TauriDir\bin" "$InnoDir\installer.iss"
    Write-Host "`n[SUCCESS] Installer generated in scripts\Output\" -ForegroundColor Green
} else {
    Write-Host "`n[ERROR] Inno Setup Compiler (ISCC.exe) not found at $ISCC" -ForegroundColor Red
    Write-Host "Please install Inno Setup 6 to generate the final installer." -ForegroundColor Red
}

Write-Host "`nDone!" -ForegroundColor Cyan
