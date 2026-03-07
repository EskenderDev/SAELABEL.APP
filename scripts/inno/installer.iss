;===========================================================
;  SAE STUDIO APP - INSTALLER
;===========================================================
#define MyAppName "SAE.STUDIO.APP"
#define MyAppVersion "0.5.6"
#define MyPublisher "EskenderDev"
#define MyAppExeName "sae_studio_app.exe"
#define MyServiceExe "SAE.STUDIO.Api.exe"
#define MyServiceName "SAE.STUDIO.Api"

#ifndef SourceDir
  #define SourceDir "..\..\src-tauri\target\release"
#endif

#ifndef ApiSourceDir
  #define ApiSourceDir "..\..\src-tauri\bin"
#endif

[Setup]
AppId={{D3F4A5B6-C7D8-E9F0-A1B2-C3D4E5F6A7B8}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyPublisher}
DefaultDirName={commonpf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=..\Output
OutputBaseFilename=SAE_Studio_Setup_v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
PrivilegesRequired=admin
DisableDirPage=no
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; SetupIconFile=..\icons\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
WizardStyle=modern

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Tauri App Files
Source: "{#SourceDir}\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion; Permissions: users-full
Source: "{#SourceDir}\*.dll"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist; Permissions: users-full

; API Service Files (Standalone EXE)
Source: "{#ApiSourceDir}\{#MyServiceExe}"; DestDir: "{app}"; Flags: ignoreversion; Permissions: system-full users-full
Source: "{#ApiSourceDir}\Schemas\*"; DestDir: "{app}\Schemas"; Flags: ignoreversion recursesubdirs createallsubdirs; Permissions: system-full users-full

[Dirs]
Name: "{app}"; Permissions: system-full users-full
Name: "{app}\Schemas"; Permissions: system-full users-full

[Run]
; 1. Stopping and deleting old service if exists
Filename: "sc"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated
Filename: "sc"; Parameters: "delete {#MyServiceName}"; Flags: runhidden waituntilterminated

; 2. Create the service with robust quoting (crucial for paths with spaces)
; Note the space after 'binPath= ' is required by sc.exe
Filename: "sc"; Parameters: "create {#MyServiceName} binPath= ""\""{app}\{#MyServiceExe}\"""" start= auto DisplayName= ""SAE Studio Server"" type= own"; Flags: runhidden waituntilterminated; StatusMsg: "Instalando servicio..."

; 3. Configure failure actions
Filename: "sc"; Parameters: "failure {#MyServiceName} reset= 86400 actions= restart/60000/restart/60000/restart/60000"; Flags: runhidden waituntilterminated

; 4. Set description
Filename: "sc"; Parameters: "description {#MyServiceName} ""SAE Studio Printing and Template API Server Service"""; Flags: runhidden waituntilterminated

; 5. Start the service
Filename: "sc"; Parameters: "start {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Iniciando servidor..."

; 6. Launch app after install
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Ensure service is stopped and removed using sc.exe independently
Filename: "sc"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated
Filename: "sc"; Parameters: "delete {#MyServiceName}"; Flags: runhidden waituntilterminated
; Extra cleanup just in case
Filename: "taskkill"; Parameters: "/F /IM {#MyServiceExe} /T"; Flags: runhidden

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Code]
// Future customization logic can go here (e.g. port selection)
