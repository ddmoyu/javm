#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef RuntimeDirectory
  #error RuntimeDirectory is required
#endif

[Setup]
AppId={{AF953D87-B68D-481B-82AA-B98D476CC95B}
AppName=JAVM
AppVersion={#AppVersion}
AppVerName=JAVM {#AppVersion}
AppPublisher=DDMUOYU
AppPublisherURL=https://github.com/ddmoyu/javm
AppSupportURL=https://github.com/ddmoyu/javm/issues
AppUpdatesURL=https://github.com/ddmoyu/javm/releases
DefaultDirName={localappdata}\Programs\JAVM
DefaultGroupName=JAVM
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
DisableProgramGroupPage=yes
DisableDirPage=no
UsePreviousAppDir=yes
UninstallDisplayIcon={app}\JAVM.exe
OutputDir={#OutputDirectory}
OutputBaseFilename=JAVM-{#AppVersion}-windows-x64-setup
SetupIconFile=..\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#NumericVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductVersion={#NumericVersion}
VersionInfoProductTextVersion={#AppVersion}
UninstallDisplayName=JAVM {#AppVersion}

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
Name: "protocol"; Description: "Open javm:// links with JAVM"

[Files]
Source: "{#RuntimeDirectory}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Bootstrapper}"; DestName: "MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\JAVM"; Filename: "{app}\JAVM.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\JAVM"; Filename: "{app}\JAVM.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\javm"; ValueType: string; ValueName: ""; ValueData: "URL:JAVM Protocol"; Tasks: protocol
Root: HKCU; Subkey: "Software\Classes\javm"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Tasks: protocol
Root: HKCU; Subkey: "Software\Classes\javm\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\JAVM.exe"" ""%1"""; Tasks: protocol

[Run]
Filename: "{app}\JAVM.exe"; Description: "Launch JAVM"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
function HasWebView2: Boolean;
var
  Version: String;
  Key: String;
begin
  Key := 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := (RegQueryStringValue(HKLM32, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
  if not Result then
    Result := (RegQueryStringValue(HKCU, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if not HasWebView2 then begin
    ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
    if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
      Result := 'WebView2 could not be installed. Connect to the internet and try again.'
    else if not HasWebView2 then
      Result := Format('WebView2 installation did not complete (code %d). Connect to the internet and try again.', [ExitCode]);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Command: String;
begin
  if CurUninstallStep = usUninstall then
    if RegQueryStringValue(HKCU, 'Software\Classes\javm\shell\open\command', '', Command) then
      if CompareText(Command, '"' + ExpandConstant('{app}\JAVM.exe') + '" "%1"') = 0 then
        RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\javm');
end;
