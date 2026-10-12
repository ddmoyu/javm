export interface ProtocolState {
  state: "missing" | "current" | "other";
  command: string;
  entry: string;
}
export type ProtocolOperation = "status" | "register" | "remove";
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** A test may use an isolated HKCU subkey; production always uses Software\Classes\javm. */
export function protocolScript(
  entry: string,
  operation: ProtocolOperation,
  expected = "",
  key = "Software\\Classes\\javm",
) {
  entry = entry.replaceAll("/", "\\");
  if (
    !/^[a-z]:\\(?:.*\\)?JAVM\.exe$/i.test(entry) ||
    entry.includes('"') ||
    Array.from(entry).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("请选择完整便携版中的 JAVM.exe。");
  const command = `"${entry}" "%1"`;
  return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$javmKey=${literal(key)}; $javmEntry=${literal(entry)}; $javmDesired=${literal(command)}; $javmExpected=${literal(expected)};
$javmBase=[Microsoft.Win32.Registry]::CurrentUser;
function Read-JavmCommand {
  $key=$javmBase.OpenSubKey($javmKey+'\\shell\\open\\command');
  try { if($null -eq $key) { return '' }; return [string]$key.GetValue('','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { if($null -ne $key) { $key.Dispose() } }
}
$javmCurrent=Read-JavmCommand;
try {
${
  operation === "register"
    ? `
  if(![IO.File]::Exists($javmEntry)) { throw '便携版程序不存在，请先解压完整软件包。' }
  if($javmCurrent -and $javmCurrent -ine $javmDesired -and $javmCurrent -cne $javmExpected) { throw '链接关联已变化，请刷新后重新确认。' }
  $javmRoot=$javmBase.CreateSubKey($javmKey);
  try { $javmRoot.SetValue('','URL:JAVM Protocol'); $javmRoot.SetValue('URL Protocol','');
    $javmCommand=$javmRoot.CreateSubKey('shell\\open\\command'); try { $javmCommand.SetValue('',$javmDesired) } finally { $javmCommand.Dispose() }
  } finally { $javmRoot.Dispose() }
`
    : operation === "remove"
      ? `
  if($javmCurrent -and $javmCurrent -ine $javmDesired) { throw '链接关联属于另一份程序，未作修改。' }
  if($javmCurrent) { $javmBase.DeleteSubKeyTree($javmKey,$false) }
`
      : ""
}
  $javmCurrent=Read-JavmCommand;
  $javmRoot=$javmBase.OpenSubKey($javmKey);
  try { $javmProtocol=$null -ne $javmRoot -and $javmRoot.GetValueNames().Contains('URL Protocol') } finally { if($null -ne $javmRoot) { $javmRoot.Dispose() } }
  $javmState=if(!$javmCurrent) {'missing'} elseif($javmCurrent -ieq $javmDesired -and $javmProtocol) {'current'} else {'other'};
  @{state=$javmState;command=$javmCurrent;entry=$javmEntry} | ConvertTo-Json -Compress;
} catch { @{error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1 }`;
}
