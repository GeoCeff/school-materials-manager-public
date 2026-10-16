$ErrorActionPreference = 'Stop'
$verify = Join-Path $PSScriptRoot 'verify-portable.ps1'
$sign = Join-Path $PSScriptRoot 'sign-portable.ps1'
foreach ($script in @($verify, $sign)) {
  $parseErrors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
$work = Join-Path (Split-Path -Parent $PSScriptRoot) ('out\release-tools-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
function Expect-Failure([scriptblock]$Action, [string]$Message) {
  try { & $Action | Out-Null } catch {
    if ($_.Exception.Message -notmatch $Message) { throw }
    return
  }
  throw "Expected failure: $Message"
}
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$archive = Join-Path $work 'unsafe.zip'
$zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
try { [void]$zip.CreateEntry('../escape.txt') } finally { $zip.Dispose() }
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
$output = Join-Path $work 'candidate'
Expect-Failure { & $verify -ArchiveZip $archive -ExpectedSha256 ('0' * 64) -OutputDirectory $output } 'checksum mismatch'
Expect-Failure { & $verify -ArchiveZip $archive -ExpectedSha256 $hash -OutputDirectory $output } 'Unsafe or duplicate ZIP entry'
if ((Test-Path -LiteralPath $output) -or (Test-Path -LiteralPath (Join-Path $work 'escape.txt'))) { throw 'Rejected input wrote extracted files.' }
Expect-Failure { & $verify -ArchiveZip $archive -ExpectedSha256 $hash -OutputDirectory $work } 'must be new'
if (@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up').Count) {
  Expect-Failure { & $verify -ArchiveZip $archive -ExpectedSha256 $hash -OutputDirectory $output -RequireOffline } 'Disconnect physical network'
}
if (Get-Command node.exe -ErrorAction SilentlyContinue) {
  Expect-Failure { & $verify -ArchiveZip $archive -ExpectedSha256 $hash -OutputDirectory $output -RequireCleanMachine } 'Clean-machine prerequisites failed'
}
$package = Join-Path $work 'package'
New-Item -ItemType Directory -Path $package | Out-Null
[IO.File]::WriteAllBytes((Join-Path $package 'school-materials-manager.exe'), [byte[]]@(0))
Expect-Failure { & $sign -PackageDirectory $package -CertificateThumbprint ('0' * 40) -OutputDirectory $output -TimestampServer 'http://timestamp.digicert.com' } 'certificate with a private key is not installed'
if (Test-Path -LiteralPath $output) { throw 'Failed certificate lookup created output.' }
Write-Output 'PASS: syntax, checksum, ZIP traversal, immutable output, offline/clean-host preconditions and missing-certificate guards.'
