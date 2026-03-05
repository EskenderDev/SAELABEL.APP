# Scripts/build_server.ps1

$ErrorActionPreference = "Stop"

# Use paths relative to the current working directory (repo root) 
# instead of PSScriptRoot which can be fragile in CI
$RepoRoot = (Get-Item .).FullName
$PotentialPaths = @(
    "..\SAE_STUDIO\src\SAE.STUDIO.Api",
    "..\SAE.STUDIO\src\SAE.STUDIO.Api",
    "SAE_STUDIO\src\SAE.STUDIO.Api",
    "SAE.STUDIO\src\SAE.STUDIO.Api"
)

$ProjectDir = $null
foreach ($Path in $PotentialPaths) {
    $TestPath = Join-Path $RepoRoot $Path
    if (Test-Path $TestPath) {
        $ProjectDir = $TestPath
        Write-Host "Found API project at: $ProjectDir"
        break
    }
}

if (-Not $ProjectDir) {
    throw "Could not find SAE.STUDIO.Api project directory in any expected location!"
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
$TargetName = "SAE.STUDIO.Api-x86_64-pc-windows-msvc.exe"
$TargetPath = Join-Path $OutputDir $TargetName

Write-Host "Renaming the executable to match Tauri sidecar requirements..."
if (Test-Path $ExePath) {
    if (Test-Path $TargetPath) { Remove-Item -Force $TargetPath }
    Rename-Item -Path $ExePath -NewName $TargetName -Force
    Write-Host "Successfully renamed to $TargetName"
} else {
    throw "Published executable $ExePath was not found!"
}

# Copy the Schemas directory if it exists in the published output so Tauri can bundle it
$PublishedSchemas = Join-Path $OutputDir "Schemas"
if (-Not (Test-Path $PublishedSchemas)) {
    # If not in output, copy direct from source to output dir
    $SourceSchemas = Join-Path $ProjectDir "Schemas"
    Copy-Item -Path $SourceSchemas -Destination $OutputDir -Recurse -Force
    Write-Host "Copied Schemas directory to $OutputDir"
}

Write-Host "Server compiled and copied successfully."
