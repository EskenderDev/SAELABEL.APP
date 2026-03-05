!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring SAE.STUDIO.Api as a Windows Service..."
  
  ; Stop and delete the service if it already exists to ensure a clean install
  ExecWait 'sc.exe stop "SAE.STUDIO.Api"'
  ExecWait 'sc.exe delete "SAE.STUDIO.Api"'
  
  ; Create the service using the bundled server executable
  ; Note: $INSTDIR is the main installation folder
  ExecWait 'sc.exe create "SAE.STUDIO.Api" binPath= "$INSTDIR\server.exe" start= auto displayname= "SAE STUDIO Server"'
  
  ; Configure service to recover on failure
  ExecWait 'sc.exe failure "SAE.STUDIO.Api" reset= 0 actions= restart/60000/restart/60000/restart/60000'
  
  ; Start the service
  ExecWait 'sc.exe start "SAE.STUDIO.Api"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing SAE.STUDIO.Api Service..."
  ExecWait 'sc.exe stop "SAE.STUDIO.Api"'
  ExecWait 'sc.exe delete "SAE.STUDIO.Api"'
!macroend
