# Scripts/build_server.ps1

$ErrorActionPreference = "Stop"

# Use paths relative to the current working directory (repo root) 
# instead of PSScriptRoot which can be fragile in CI
$RepoRoot = (Get-Item .).FullName
$ProjectDir = Join-Path $RepoRoot "..\SAE.STUDIO\src\SAE.STUDIO.Api"

# If the SAE.STUDIO folder happens to be alongside SAELABEL.APP in CI, check that.
# In GitHub Actions, usually the repo is checked out into $GITHUB_WORKSPACE.
# We must ensure the .NET project actually exists in the CI environment!
if (-Not (Test-Path $ProjectDir)) {
    Write-Warning "ProjectDir not found: $ProjectDir"
    # Looking inside the current repo as fallback if the folder structure is different
    $ProjectDiralt = Join-Path $RepoRoot "SAE.STUDIO\src\SAE.STUDIO.Api"
    if (Test-Path $ProjectDiralt) {
        $ProjectDir = $ProjectDiralt
    } else {
        throw "Could not find SAE.STUDIO.Api project directory!"
    }
}

$OutputDir = Join-Path $RepoRoot "src-tauri\bin"

Write-Host "Creating output directory: $OutputDir"
if (-Not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

Write-Host "Publishing SAE.STUDIO.Api to $OutputDir"
# Publish as self-contained single file for Windows x64
# IncludeNativeLibrariesForSelfExtract is required for native DLLs like SQLite in single-file apps
dotnet publish "$ProjectDir\SAE.STUDIO.Api.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$OutputDir"

$ExePath = Join-Path $OutputDir "SAE.STUDIO.Api.exe"
$TargetName = "server-x86_64-pc-windows-msvc.exe"
$TargetPath = Join-Path $OutputDir $TargetName

Write-Host "Renaming the executable to match Tauri sidecar requirements..."
if (Test-Path $ExePath) {
    if (Test-Path $TargetPath) { Remove-Item -Force $TargetPath }
    Rename-Item -Path $ExePath -NewName $TargetName -Force
    Write-Host "Successfully renamed to $TargetName"
} else {
    throw "Published executable $ExePath was not found!"
}

Write-Host "Server compiled and copied successfully."
