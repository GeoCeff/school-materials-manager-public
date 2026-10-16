param(
  [Parameter(Mandatory)][string]$ArchiveZip,
  [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [switch]$RequireOffline,
  [switch]$RequireCleanMachine
)
$ErrorActionPreference = 'Stop'
$archive = (Resolve-Path -LiteralPath $ArchiveZip).Path
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory must be new; prior evidence is never overwritten.' }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'ZIP checksum mismatch.' }
function Test-ConnectedNetwork {
  return (@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up').Count -gt 0 -or @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $_.GetIPProperties().GatewayAddresses.Count -gt 0 }).Count -gt 0)
}
$nodeInstalled = [bool](Get-Command node.exe -ErrorAction SilentlyContinue)
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if ($base -and (Test-Path -LiteralPath (Join-Path $base 'nodejs\node.exe'))) { $nodeInstalled = $true }
}
$officeInstalled = [bool](@('HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\POWERPNT.EXE', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\POWERPNT.EXE') | Where-Object { Test-Path -LiteralPath $_ })
if ($RequireOffline -and (Test-ConnectedNetwork)) { throw 'Disconnect physical network adapters and active gateway connections before running the offline check.' }
if ($RequireCleanMachine -and ($nodeInstalled -or $officeInstalled)) { throw 'Clean-machine prerequisites failed: Node.js or Microsoft Office was detected.' }

Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $destinations = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $zip.Entries) {
    $destination = [IO.Path]::GetFullPath((Join-Path $output $entry.FullName))
    if ([IO.Path]::IsPathRooted($entry.FullName) -or $entry.FullName.Contains(':') -or !$destination.StartsWith($output + '\', [StringComparison]::OrdinalIgnoreCase) -or !$destinations.Add($destination)) { throw 'Unsafe or duplicate ZIP entry.' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $output)
$exe = Join-Path $output 'school-materials-manager-win32-x64\school-materials-manager.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Expected portable executable is missing.' }
$environment = [ordered]@{
  windows = (Get-CimInstance Win32_OperatingSystem).Caption
  version = (Get-CimInstance Win32_OperatingSystem).Version
  nodeDetected = $nodeInstalled
  officeDetected = $officeInstalled
  requireOffline = [bool]$RequireOffline
  requireCleanMachine = [bool]$RequireCleanMachine
  cleanMachinePrerequisitesPassed = !$nodeInstalled -and !$officeInstalled
  signature = (Get-AuthenticodeSignature -LiteralPath $exe).Status.ToString()
}
$runs = @()
$oldPath = $env:Path
$oldNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
  # ponytail: test with Windows tools only; a fresh Windows VM is still required to establish a clean machine.
  $env:Path = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  foreach ($attempt in 1..2) {
    $reportPath = Join-Path $output "smoke-$attempt.json"
    $process = Start-Process -FilePath $exe -ArgumentList '--smoke','--report',('"' + $reportPath + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output "smoke-$attempt.stdout.log") -RedirectStandardError (Join-Path $output "smoke-$attempt.stderr.log")
    $null = $process.Handle
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
      do {
        if ($RequireOffline -and (Test-ConnectedNetwork)) { throw 'A network adapter or gateway reconnected during the check.' }
        if ($timer.Elapsed.TotalSeconds -gt 150) { throw 'Packaged smoke exceeded 150 seconds.' }
      } while (!$process.WaitForExit(500))
      $process.WaitForExit()
      $process.Refresh()
      if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $reportPath)) { throw "Packaged smoke $attempt failed; inspect the logs." }
      $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
      if (!$report.passed -or $report.queriesPassed -ne 18 -or !$report.sourceHashesUnchanged -or !$report.releaseFeatures.offlineOcr -or !$report.releaseFeatures.pdfPageRendering -or !$report.releaseFeatures.savedItemsRestart) { throw 'Packaged smoke did not satisfy the release assertions.' }
      $runs += $report
    } finally {
      if (!$process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
      $process.Dispose()
    }
  }
  [ordered]@{
    passed = $true
    archiveSha256 = $ExpectedSha256.ToUpperInvariant()
    environment = $environment
    coldProcessStarts = 2
    runs = $runs
    remainingHandsOn = @('Audible screen reader', 'Native window/display behavior on fresh Windows', 'Saved-item UI across a full process restart')
  } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $output 'validation.json') -Encoding UTF8
  Write-Output "PASS: two cold process starts, 18 queries each. Evidence: $output\validation.json"
} finally {
  $env:Path = $oldPath
  $env:ELECTRON_RUN_AS_NODE = $oldNodeMode
}
