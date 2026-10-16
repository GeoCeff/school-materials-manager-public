param(
  [Parameter(Mandatory)][string]$PackageDirectory,
  [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$CertificateThumbprint,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][ValidatePattern('^http://')][string]$TimestampServer
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PackageDirectory).Path.TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if (!(Test-Path -LiteralPath (Join-Path $source 'school-materials-manager.exe') -PathType Leaf)) { throw 'PackageDirectory must contain the portable executable.' }
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory must be new; existing artifacts are never signed in place.' }
if ($output.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputDirectory must be outside PackageDirectory.' }
$certificates = @(Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert | Where-Object Thumbprint -eq $CertificateThumbprint)
if (!$certificates.Count) { throw 'The requested code-signing certificate with a private key is not installed.' }
$certificate = $certificates[0]
if (!$certificate.HasPrivateKey) { throw 'The selected publisher certificate has no available private key.' }
if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -lt (Get-Date)) { throw 'The signing certificate is not currently valid.' }
$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
try {
  if (!$chain.Build($certificate)) { throw 'The signing certificate does not have a valid trusted chain.' }
} finally { $chain.Dispose() }
$metadata = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json') -Raw | ConvertFrom-Json
if ((Get-Item -LiteralPath (Join-Path $source 'school-materials-manager.exe')).VersionInfo.ProductVersion -ne $metadata.version) { throw 'Package version must match package.json.' }
$package = Join-Path $output 'school-materials-manager-win32-x64'
New-Item -ItemType Directory -Path $output | Out-Null
Copy-Item -LiteralPath $source -Destination $package -Recurse
$signed = @()
$lineage = @()
foreach ($file in Get-ChildItem -LiteralPath $package -Recurse -File | Where-Object Extension -in '.exe','.dll','.node') {
  $originalHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  # Its digest is sealed in ASAR and checked before launch; changing it after sealing would break parsing.
  if ($file.FullName -eq (Join-Path $package 'resources\app.asar.unpacked\dist\assets\parser-host.exe')) {
    $expectedHost = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\assets\parser-host.sha256') -Raw | ConvertFrom-Json
    if ($originalHash -ne $expectedHost.sha256) { throw 'Parser supervisor differs from its sealed digest; rebuild and reverify the package.' }
    $lineage += [ordered]@{ path=$file.FullName.Substring($package.Length + 1); sha256=$originalHash; unchanged=$true; trust='SHA-256 sealed in ASAR; authenticated by the signed main executable' }
    continue
  }
  $before = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($before.Status -eq 'Valid' -and $file.FullName -ne (Join-Path $package 'school-materials-manager.exe')) { continue }
  if ($before.Status -notin 'NotSigned','Valid') { throw "Invalid existing signature on $($file.Name); distribution stopped." }
  Set-AuthenticodeSignature -LiteralPath $file.FullName -Certificate $certificate -HashAlgorithm SHA256 -IncludeChain NotRoot -TimestampServer $TimestampServer | Out-Null
  $after = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($after.Status -ne 'Valid' -or !$after.TimeStamperCertificate -or $after.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw "Signature or timestamp verification failed for $($file.Name)." }
  $signed += $file.FullName.Substring($package.Length + 1)
  $lineage += [ordered]@{ path=$file.FullName.Substring($package.Length + 1); unsignedSha256=$originalHash; signedSha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
}
$zipPath = Join-Path $output "school-materials-manager-$($metadata.version)-win32-x64-signed.zip"
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
# Include the top-level application folder while keeping the original unsigned package intact.
[IO.Compression.ZipFile]::CreateFromDirectory($package, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $true)
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
"$hash  $([IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath ($zipPath + '.sha256') -Encoding ASCII
[ordered]@{ version=$metadata.version; certificateThumbprint=$certificate.Thumbprint; publisher=$certificate.Subject; signedFiles=$signed; binaryLineage=$lineage; archiveSha256=$hash } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output 'signing.json') -Encoding UTF8
Write-Output "Signed and timestamped candidate: $zipPath. Revalidate this new ZIP before distribution."
