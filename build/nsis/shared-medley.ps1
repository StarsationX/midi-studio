# The installer hashes this *script's bytes* against its compile-time pin
# before interpreting them. No user-selected destination or executable is
# accepted for elevated publication, including on a headless machine.
param([string]$NativeScriptPin,[string]$ManifestPin,[string]$LegacyPin)
$ErrorActionPreference = 'Stop'
$pin = 'fa89f1997f7120f1eb3cac19e7590653d6e6b92ba9dd2d486645d86c0667aede'
function Digest([IO.Stream]$f) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($f)).Replace('-','') } finally { $sha.Dispose() }
}
function Read-PinnedBytes([string]$path,[string]$expected) {
    $b = [IO.File]::ReadAllBytes($path)
    $stream = [IO.MemoryStream]::new($b,$false)
    try { if ((Digest $stream) -ne $expected) { throw "The packaged $([IO.Path]::GetFileName($path)) failed verification." } } finally { $stream.Dispose() }
    return ,$b
}
function Assert-Protected([string]$path, [bool]$file) {
    if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) { throw "Shared path is a link: $path" }
    if ($file) { $acl = [IO.File]::GetAccessControl($path) } else { $acl = [IO.Directory]::GetAccessControl($path) }
    $sid = [Security.Principal.SecurityIdentifier]
    $trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') # System, Administrators, TrustedInstaller
    if ($acl.GetOwner($sid).Value -notin $trusted) { throw "Shared path lacks a trusted owner: $path" }
    $rx = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute
    $writes = 0xD0156 # write data/children, append, attributes, delete, write ACL/owner
    $readable = $false
    foreach ($rule in $acl.GetAccessRules($true,$true,$sid)) {
        if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        if ($rule.AccessControlType -eq 'Deny') { throw "Unexpected deny ACL on shared path: $path" }
        if ($rule.IdentityReference.Value -notin $trusted -and ([int]$rule.FileSystemRights -band $writes)) { throw "Shared path is writable by another account: $path" }
        if ($rule.IdentityReference.Value -in 'S-1-5-32-545','S-1-5-11','S-1-1-0' -and (([int]$rule.FileSystemRights -band $rx) -eq $rx)) { $readable = $true }
    }
    if (!$readable) { throw "Shared path is not readable to other users: $path" }
}
function Protected-Child([string]$parent, [string]$leaf) {
    $dir = [IO.Path]::Combine($parent,$leaf)
    # Check the parent before creating even a single child. An existing child
    # is not trusted just because it is below Program Files. A failed access
    # check is terminal; never attempt to repair someone else's ACL.
    if (![IO.Directory]::Exists($dir)) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true,$false)
        foreach ($id in 'S-1-5-18','S-1-5-32-544','S-1-5-32-545') {
            $s = [Security.Principal.SecurityIdentifier]::new($id)
            $rights = if ($id -eq 'S-1-5-32-545') { 'ReadAndExecute' } else { 'FullControl' }
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,$rights,'ContainerInherit, ObjectInherit','None','Allow'))
        }
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        [void][IO.Directory]::CreateDirectory($dir,$acl)
    }
    Assert-Protected $dir $false
    $dir
}
function Local-Path([string]$path) {
    if ($path -notmatch '^[A-Z]:\\[^\\]' -or $path.Substring(2) -match '[:"*?<>|/\x00-\x1f]|~\d|[ .](?=\\|$)' -or [IO.DriveInfo]::new($path.Substring(0,3)).DriveType -ne 'Fixed') { throw "Unsafe local path: $path" }
    [IO.Path]::GetFullPath($path).TrimEnd('\')
}
function Local-Attributes([string]$path) {
    # Check each component before descending; missing is distinct from denied.
    $path = Local-Path $path
    $p = $path.Substring(0,3)
    foreach ($name in $path.Substring(3).Split('\')) {
        $p = [IO.Path]::Combine($p,$name)
        try { $attr = [IO.File]::GetAttributes($p) }
        catch [IO.FileNotFoundException] { return $null }
        catch [IO.DirectoryNotFoundException] { return $null }
        if ($attr -band [IO.FileAttributes]::ReparsePoint) { throw "Cannot inspect through link: $p" }
    }
    $attr
}
function Read-StorageSettings([string]$path) {
    if ($null -eq (Local-Attributes $path)) { return }
    # No PowerShell module autoload or object deserialization here. The BCL
    # JSON reader exposes fields as XML text, with bounded input and depth.
    $f = [IO.File]::OpenRead($path)
    try {
        if ($f.Length -gt 1048576) { throw 'Cannot safely inspect oversized storage settings.' }
        $text = [IO.StreamReader]::new($f).ReadToEnd()
    } finally { $f.Dispose() }
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    [void][Reflection.Assembly]::Load('System.Runtime.Serialization, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
    $reader = [Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($bytes,[Xml.XmlDictionaryReaderQuotas]::new())
    $doc = [Xml.XmlDocument]::new()
    try { $doc.XmlResolver = $null; $doc.Load($reader) } finally { $reader.Dispose() }
    $paths = @{}
    foreach ($key in 'forgeEnvDir','modelsDir') {
        $nodes = $doc.SelectNodes('/root/paths/' + $key)
        if ($nodes.Count -gt 1) { throw 'Ambiguous storage settings.' }
        if ($nodes.Count) {
            if ($nodes[0].GetAttribute('type') -ne 'string') { throw 'Invalid storage path.' }
            $paths[$key] = $nodes[0].InnerText
        }
    }
    $paths
}
function Check-HeadlessTarget {
    # No interactive token. Only read metadata and inspect paths; never copy
    # a user file, run an old executable or parse commands. A known Medley app,
    # ambiguous storage choice, link, inaccessible path, model or checkpoint
    # requires the old user's own session. In particular this is NOT a general
    # fallback for a failed conversion, hash mismatch or failed preservation.
    $kind = $env:MS_MEDLEY_REGISTERED
    if ($env:MS_MEDLEY_WIX -or $kind -notin 'none','electron','tauri') { throw 'Mixed or unknown old installation. Sign in as the user of the old app.' }
    if ($kind -ne 'tauri' -and ($env:MS_MEDLEY_TAURI -or $env:MS_MEDLEY_OLD_VERSION)) { throw 'Incomplete or conflicting Tauri registration.' }
    $target = Local-Path $env:MS_MEDLEY_TARGET
    $old = $null
    if ($kind -eq 'tauri') {
        $version = $env:MS_MEDLEY_OLD_VERSION
        if ($env:MS_MEDLEY_ELECTRON -or $version -notin '3.1.2','3.1.3','3.1.4','3.1.5','3.1.6','3.1.7','3.1.8','3.1.9','3.1.10','3.1.11','3.1.12','3.1.13','3.1.14') { throw "Mixed registration or unrecognized nonbundled release ($version). Sign in as the user of the old app." }
        $old = Local-Path $env:MS_MEDLEY_TAURI
        if (![string]::Equals($old,$target,[StringComparison]::OrdinalIgnoreCase)) { throw 'The selected folder differs from the registered Tauri installation.' }
        $names = 'MIDI Studio.exe','uninstall.exe'
    } elseif ($kind -eq 'electron') {
        $old = Local-Path $env:MS_MEDLEY_ELECTRON
        $names = 'MIDI Studio.exe','Uninstall MIDI Studio.exe'
    } elseif ($env:MS_MEDLEY_ELECTRON) { throw 'Ambiguous prior Electron installation.' }
    if ($old) {
        foreach ($name in $names) {
            $attr = Local-Attributes ([IO.Path]::Combine($old,$name))
            if ($null -eq $attr -or ($attr -band [IO.FileAttributes]::Directory)) { throw "Missing or invalid installed file: $old\$name" }
        }
        if ($kind -eq 'tauri') {
            $info = [Diagnostics.FileVersionInfo]::GetVersionInfo([IO.Path]::Combine($old,'MIDI Studio.exe'))
            if ($info.ProductName -ne 'MIDI Studio' -or $info.CompanyName -ne 'StarsationX' -or $info.ProductVersion -ne $version -or $info.FileVersion -ne $version) { throw 'The installed MIDI Studio executable does not match its registered public release.' }
        }
        $stack = [Collections.Generic.Stack[string]]::new(); $stack.Push($old)
        while ($stack.Count) {
            foreach ($entry in [IO.DirectoryInfo]::new($stack.Pop()).EnumerateFileSystemInfos()) {
                if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cannot inspect link in the old app: $($entry.FullName)" }
                if ($kind -eq 'tauri' -and $entry.Name -in 'MIDI Studio Expressive.exe','Uninstall MIDI Studio.exe') { throw 'Conflicting old app files. Sign in as the user of the old app.' }
                if ($entry.Name -in 'bsrofo_sw_body.onnx','BS-Rofo-SW-Fixed.ckpt') { throw 'Old app includes a Medley model; sign in to preserve it before upgrading.' }
                if ($entry.Attributes -band [IO.FileAttributes]::Directory) { $stack.Push($entry.FullName) }
            }
        }
    }
    if ($target -ne $old -and $null -ne (Local-Attributes $target)) {
        $entries = [IO.Directory]::EnumerateFileSystemEntries($target).GetEnumerator()
        try { if ($entries.MoveNext()) { throw 'A nonempty/portable target requires its interactive user.' } } finally { $entries.Dispose() }
    }
    $product = $env:MS_MEDLEY_PRODUCT
    $stores = @($env:MS_MEDLEY_STORAGE,$env:MS_MEDLEY_OLD_STORAGE)
    $models = @()
    $profiles = @()
    if ($product -eq 'MIDI Studio') {
        $product = 'midi-studio'
        $stores += @($env:MIDI_STUDIO_FORGE_ENV_DIR,([Environment]::GetFolderPath('LocalApplicationData') + '\midi-forge'),([Environment]::GetFolderPath('CommonApplicationData') + '\midi-studio\forge-env'))
        $models += $env:MIDI_STUDIO_MODELS_DIR
        foreach ($drive in [IO.DriveInfo]::GetDrives()) {
            if ($drive.DriveType -eq 'Fixed' -and $drive.IsReady) { $stores += ($drive.Name + 'MIDI Studio Forge') }
        }
        foreach ($hive in 'CurrentUser','LocalMachine') { foreach ($view in 'Registry32','Registry64') {
            $reg = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
            try {
                $k = $reg.OpenSubKey('Software\StarsationX\MIDI Studio')
                if ($k) { try { $stores += $k.GetValue('ForgeStorageDir') } finally { $k.Dispose() } }
            } finally { $reg.Dispose() }
        }}
        if ($env:FORGE_RS_ROFO_MODEL -and $null -ne (Local-Attributes $env:FORGE_RS_ROFO_MODEL)) { throw 'Existing explicit model requires its interactive user.' }
        if ($env:MIDI_STUDIO_USER_DATA) { $profiles += [IO.Path]::Combine($env:MIDI_STUDIO_USER_DATA,'midi-studio-settings.json') }
    }
    $profiles += [IO.Path]::Combine([Environment]::GetFolderPath('ApplicationData'),$product,'midi-studio-settings.json')
    foreach ($profile in $profiles) {
        $paths = Read-StorageSettings $profile
        if ($paths) { $stores += $paths.forgeEnvDir; $models += $paths.modelsDir }
    }
    $stores += [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),$product,'forge-env')
    foreach ($dir in ($stores + $models)) { if ($dir) {
        $dir = Local-Path $dir
        foreach ($r in $old,$target) {
            if ($r -and ($dir -eq $r -or $dir.StartsWith($r + '\',[StringComparison]::OrdinalIgnoreCase))) { throw "Move Forge storage outside the old app before upgrading: $dir" }
        }
    }}
    foreach ($store in $stores) { if ($store) { $models += [IO.Path]::Combine((Local-Path $store),'models') } }
    foreach ($m in $models) { if ($m) { foreach ($sub in '','bs_rofo_sw','onnx') { foreach ($name in 'bsrofo_sw_body.onnx','BS-Rofo-SW-Fixed.ckpt') {
        if ($null -ne (Local-Attributes ([IO.Path]::Combine($m,$sub,$name)))) { throw 'Stored Medley weights require their interactive user.' }
    }}}}
}
try {
    if ($env:MS_MEDLEY_OPERATION -eq 'CheckHeadlessTarget') {
        Check-HeadlessTarget
        exit 0
    }
    # Native Program Files (the installer and PowerShell may be 32-bit). Its
    # location is owned by Windows, not the inherited ProgramW6432 env var.
    $lm = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64')
    try {
        $key = $lm.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion')
        try { $pf = $key.GetValue('ProgramFilesDir') } finally { $key.Dispose() }
    } finally { $lm.Dispose() }
    if ($pf -notmatch '^[A-Z]:\\[^\\]+$') { throw 'Cannot establish a trusted native Program Files root.' }
    if ($env:MS_MEDLEY_OPERATION -eq 'PreserveNative') {
        $helpers = [IO.Path]::GetDirectoryName($env:MS_MEDLEY_SHARED_SCRIPT)
        $manifest = Read-PinnedBytes ([IO.Path]::Combine($helpers,'forge-components.json')) $ManifestPin
        $scriptBytes = Read-PinnedBytes ([IO.Path]::Combine($helpers,'preserve-native.ps1')) $NativeScriptPin
        $shared = if ($env:MS_MEDLEY_PRODUCT -eq 'MIDI Studio') { 'MIDI Studio Shared Models' } else { 'MIDI Studio Test Shared Models' }
        $roots = @($env:MS_MEDLEY_TARGET,$env:MS_MEDLEY_TAURI,$env:MS_MEDLEY_ELECTRON,$env:MS_MEDLEY_WIX)
        & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($scriptBytes))) -InstallRoots $roots -ManifestBytes $manifest -ProtectedProgramFiles $pf -SharedFolder $shared -OtherStorageDirs @($env:MS_MEDLEY_STORAGE,$env:MS_MEDLEY_OLD_STORAGE)
        exit 0
    }
    Assert-Protected $pf $false
    if ($env:MS_MEDLEY_OPERATION -eq 'VerifyMachineUninstaller') {
        $install = [IO.Path]::GetFullPath($env:MS_MEDLEY_TAURI.Trim('"')).TrimEnd('\')
        if (!$install.StartsWith($pf + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Custom install is not in native Program Files.' }
        $dir = $pf
        foreach ($name in $install.Substring($pf.Length + 1).Split('\')) {
            $dir = [IO.Path]::Combine($dir,$name); Assert-Protected $dir $false
        }
        Assert-Protected ([IO.Path]::Combine($dir,'uninstall.exe')) $true
        exit 0
    }
    $sub = 'bs_rofo_sw'; $name = 'bsrofo_sw_body.onnx'; $src = $env:MS_MEDLEY_SHARED_INPUT
    $stageElectron = $env:MS_MEDLEY_OPERATION -eq 'StageElectron'
    if ($stageElectron -and $LegacyPin -match '^[a-f0-9]{64}$') {
        $pin = $LegacyPin; $name = 'electron-uninstaller.exe'
        $src = [IO.Path]::Combine((Local-Path $env:MS_MEDLEY_ELECTRON),'Uninstall MIDI Studio.exe')
        $sub = 'setup-' + [Guid]::NewGuid().ToString('N')
    } elseif ($env:MS_MEDLEY_OPERATION -ne 'PreserveShared') { throw 'Unknown protected operation.' }
    # An arbitrary target (including a disposable/test install) must never
    # contain the recovery cache. The parent populated these before preflight.
    $base = if ($env:MS_MEDLEY_PRODUCT -eq 'MIDI Studio') { 'MIDI Studio Shared Models' } else { 'MIDI Studio Test Shared Models' }
    $planned = [IO.Path]::Combine($pf,$base,$sub)
    foreach ($root in $env:MS_MEDLEY_TAURI,$env:MS_MEDLEY_TARGET,$env:MS_MEDLEY_ELECTRON,$env:MS_MEDLEY_WIX) {
        if (!$root) { continue }
        $r = [IO.Path]::GetFullPath($root.Trim('"')).TrimEnd('\')
        if ($planned -eq $r -or $planned.StartsWith($r+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Shared storage is inside the install tree.' }
    }
    $d = Protected-Child $pf $base
    $d = Protected-Child $d $sub
    $target = [IO.Path]::Combine($d,$name)
    if ([IO.File]::Exists($target)) {
        Assert-Protected $target $true
        $f = [IO.File]::OpenRead($target)
        try { if ((Digest $f) -ne $pin) { throw "Conflicting shared file (not overwritten): $target" } } finally { $f.Dispose() }
    } else {
        # The lower-privilege helper supplied a *path*, never code. A malicious
        # path cannot publish an arbitrary privileged file: hash the opened,
        # write/delete-locked handle before creating anything readable by others.
        if ($src -notmatch '^[A-Z]:\\' -or $src.Substring(2) -match '[:"*?<>|\x00-\x1f]|~\d|[ .](?=\\|$)' -or [IO.DriveInfo]::new($src.Substring(0,3)).DriveType -ne 'Fixed') { throw 'Invalid local source path.' }
        for ($p = $src; $p; $p = [IO.Path]::GetDirectoryName($p)) {
            if ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) { throw 'A link is not a valid shared-copy source.' }
        }
        $f = [IO.File]::OpenRead($src)
        try {
            if ((Digest $f) -ne $pin) { throw 'Shared-copy source changed before publication.' }
            $f.Position = 0
            $tmp = [IO.Path]::Combine($d,[Guid]::NewGuid().ToString('N') + '.partial')
            $stage = [IO.File]::Open($tmp,'CreateNew','ReadWrite','None')
            try {
                try {
                    $f.CopyTo($stage); $stage.Flush($true); $stage.Position = 0
                    if ((Digest $stage) -ne $pin) { throw 'Shared copy failed verification.' }
                } finally { $stage.Dispose() }
                $acl = [IO.File]::GetAccessControl($tmp)
                $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
                [IO.File]::SetAccessControl($tmp,$acl)
                Assert-Protected $tmp $true
                [IO.File]::Move($tmp,$target)
            } finally { [IO.File]::Delete($tmp) }
        } finally { $f.Dispose() }
    }
    if ($stageElectron) { [Console]::Write($sub) } else { [Console]::WriteLine("Verified shared model: $target") }
    exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 26 }
