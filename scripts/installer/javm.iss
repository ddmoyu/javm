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
#ifndef LegacyUninstallKey
  #define LegacyUninstallKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\javm"
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
#ifdef InstallationKindFile
Source: "{#InstallationKindFile}"; DestDir: "{app}"; DestName: "installation-kind.json"; Flags: ignoreversion
#endif

[Icons]
Name: "{group}\JAVM"; Filename: "{app}\JAVM.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\JAVM"; Filename: "{app}\JAVM.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\JAVM.exe"; Description: "{cm:LaunchProgram,JAVM}"; Flags: nowait postinstall skipifsilent

; 不设置 UninstallDelete；卸载只删除安装器登记的文件，保留数据库与用户文件。

[Code]
var
  LegacyUpdate: Boolean;
  LegacyDirectory: String;
  LegacyRegistryRoot: Integer;

function IsLegacyUpdate: Boolean;
var
  I: Integer;
begin
  Result := False;
  { /ARGS 后是旧应用自己的参数，不能作为安装器选项处理。 }
  for I := 1 to ParamCount do begin
    if CompareText(ParamStr(I), '/ARGS') = 0 then Exit;
    if CompareText(ParamStr(I), '/UPDATE') = 0 then Result := True;
  end;
end;

function ReadLegacyDirectory(Root: Integer; var Directory: String): Boolean;
var
  Name, BinaryName: String;
begin
  Result := False;
  if not RegQueryStringValue(Root, '{#LegacyUninstallKey}', 'DisplayName', Name) then Exit;
  if CompareText(Name, 'javm') <> 0 then Exit;
  if not RegQueryStringValue(Root, '{#LegacyUninstallKey}', 'MainBinaryName', BinaryName) then Exit;
  if CompareText(BinaryName, 'javm.exe') <> 0 then Exit;
  if not RegQueryStringValue(Root, '{#LegacyUninstallKey}', 'InstallLocation', Directory) then Exit;
  Directory := RemoveQuotes(Trim(Directory));
  if (Length(Directory) < 4) or (Copy(Directory, 2, 2) <> ':\') then Exit;
  Directory := RemoveBackslashUnlessRoot(ExpandFileName(Directory));
  Result := FileExists(AddBackslash(Directory) + 'javm.exe') and
    FileExists(AddBackslash(Directory) + 'uninstall.exe');
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  LegacyUpdate := IsLegacyUpdate;
  if not LegacyUpdate then Exit;
  LegacyRegistryRoot := HKCU64;
  if not ReadLegacyDirectory(LegacyRegistryRoot, LegacyDirectory) then begin
    LegacyRegistryRoot := HKCU32;
    if not ReadLegacyDirectory(LegacyRegistryRoot, LegacyDirectory) then begin
      MsgBox('无法确认旧版 JAVM 安装目录，已停止升级，旧程序保持不变。', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure InitializeWizard;
begin
  { Tauri 会关闭旧应用后交接此安装器；保留可取消的安装确认页面。 }
  if LegacyUpdate then WizardForm.DirEdit.Text := LegacyDirectory;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := LegacyUpdate and (PageID = wpSelectDir);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Directory: String;
begin
  Result := '';
  if not LegacyUpdate then Exit;
  if not ReadLegacyDirectory(LegacyRegistryRoot, Directory) or
      (CompareText(Directory, LegacyDirectory) <> 0) or
      (CompareText(RemoveBackslashUnlessRoot(ExpandConstant('{app}')), LegacyDirectory) <> 0) then
    Result := '旧版安装目录发生变化，已停止升级。';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Directory: String;
begin
  { 仅在成功完成同目录安装后移除旧卸载入口，避免它误删新版 JAVM.exe。 }
  if LegacyUpdate and (CurStep = ssDone) and
      ReadLegacyDirectory(LegacyRegistryRoot, Directory) and
      (CompareText(Directory, LegacyDirectory) = 0) then
    if not RegDeleteKeyIncludingSubkeys(LegacyRegistryRoot, '{#LegacyUninstallKey}') then
      Log('未能移除旧版 JAVM 卸载入口');
end;
