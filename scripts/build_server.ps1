# Scripts/build_server.ps1

$ErrorActionPreference = "Stop"

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
# We publish as self-contained and SINGLE-FILE to ensure all dependencies 
# are bundled within the executable for easy deployment via Tauri sidecars.
dotnet publish "$ProjectDir\SAE.STUDIO.Api.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$OutputDir"

$ExePath = Join-Path $OutputDir "SAE.STUDIO.Api.exe"
$TargetName = "SAE.STUDIO.Api-x86_64-pc-windows-msvc.exe"
$TargetPath = Join-Path $OutputDir $TargetName

Write-Host "Renaming the executable to match Tauri sidecar requirements..."
if (Test-Path $ExePath) {
    if (Test-Path $TargetPath) { Remove-Item -Force $TargetPath }
    # We copy instead of move/rename because the NSIS hook might need the original name
    Copy-Item -Path $ExePath -Destination $TargetPath -Force
    Write-Host "Successfully prepared $TargetName"
} else {
    throw "Published executable $ExePath was not found!"
}

# Ensure Schemas directory is in the output
$SourceSchemas = Join-Path $ProjectDir "Schemas"
$DestSchemas = Join-Path $OutputDir "Schemas"
if (Test-Path $SourceSchemas) {
    if (Test-Path $DestSchemas) { Remove-Item -Path $DestSchemas -Recurse -Force }
    Copy-Item -Path $SourceSchemas -Destination $OutputDir -Recurse -Force
    Write-Host "Copied Schemas directory to output."
}

Write-Host "Server compiled and copied successfully."
