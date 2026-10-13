; 只包含经过清单校验的暂存文件，不从用户安装目录收集文件。
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef JavmAppId
  #define JavmAppId "net.ddmoyu.javm.neutralino"
#endif
#ifndef JavmGroup
  #define JavmGroup "JAVM"
#endif

[Setup]
AppId={#JavmAppId}
AppName=JAVM
AppVersion={#AppVersion}
AppVerName=JAVM {#AppVersion}
AppPublisher=JAVM
AppPublisherURL=https://github.com/ddmoyu/javm
AppSupportURL=https://github.com/ddmoyu/javm/issues
AppUpdatesURL=https://github.com/ddmoyu/javm/releases
DefaultDirName={localappdata}\Programs\JAVM
DefaultGroupName={#JavmGroup}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDirectory}
OutputBaseFilename={#OutputName}
SetupIconFile={#ProjectRoot}\resources\icon.ico
UninstallDisplayIcon={app}\JAVM.exe
VersionInfoVersion={#NumericVersion}
VersionInfoProductVersion={#NumericVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
SetupMutex={#JavmAppId}.setup

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PayloadDirectory}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#NoticesFile}"; DestDir: "{app}"; DestName: "THIRD-PARTY-NOTICES.txt"; Flags: ignoreversion

[Icons]
Name: "{group}\JAVM"; Filename: "{app}\JAVM.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\JAVM"; Filename: "{app}\JAVM.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\JAVM.exe"; Description: "{cm:LaunchProgram,JAVM}"; Flags: nowait postinstall skipifsilent

; 不设置 UninstallDelete；卸载只删除安装器登记的文件，保留数据库与用户文件。
