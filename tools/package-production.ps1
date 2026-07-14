[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$PublicApiUrl,

  [string]$BackendPath = (Split-Path -Parent $PSScriptRoot),

  [string]$FrontendPath = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'bayat-parrot'),

  [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-NpmBuild {
  param([Parameter(Mandatory = $true)][string]$Path)

  Push-Location -LiteralPath $Path
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "Build failed in $Path"
    }
  }
  finally {
    Pop-Location
  }
}

function Copy-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Required directory does not exist: $Source"
  }

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
}

function Assert-ProtectedArtifact {
  param([Parameter(Mandatory = $true)][string]$Root)

  $allItems = @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  $forbidden = @($allItems | Where-Object {
      $_.Name -eq '.git' -or
      $_.Name -eq '.env' -or
      $_.Name -like '.env.*' -or
      ($_.PSIsContainer -and $_.Name -in @('src', 'test', 'tests', 'docs')) -or
      (-not $_.PSIsContainer -and (
          $_.Name -like '*.map' -or
          $_.Name -like '*.d.ts' -or
          $_.Name -like '*.tsbuildinfo'
        ))
    })

  if ($forbidden.Count -gt 0) {
    $paths = $forbidden | ForEach-Object { $_.FullName.Substring($Root.Length).TrimStart('\\', '/') }
    throw "Forbidden artifact content detected:`n$($paths -join "`n")"
  }
}

function Assert-BackendArtifactLayout {
  param([Parameter(Mandatory = $true)][string]$Root)

  $allowedEntries = @('dist', 'package.json', 'package-lock.json', 'runtime-metadata.json')
  $unexpectedEntries = @(Get-ChildItem -LiteralPath $Root -Force | Where-Object {
      $_.Name -notin $allowedEntries
    })

  if ($unexpectedEntries.Count -gt 0) {
    throw "Unexpected backend artifact content detected: $($unexpectedEntries.Name -join ', ')"
  }

  if (Get-ChildItem -LiteralPath $Root -Recurse -Force -Directory | Where-Object { $_.Name -eq 'node_modules' }) {
    throw 'Backend artifact must not contain node_modules.'
  }
}

function New-TarGzArchive {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$ArchivePath
  )

  if (Test-Path -LiteralPath $ArchivePath) {
    Remove-Item -LiteralPath $ArchivePath -Force
  }

  & tar -czf $ArchivePath -C $SourceDirectory .
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create archive: $ArchivePath"
  }
}

function Write-Sha256File {
  param([Parameter(Mandatory = $true)][string]$ArchivePath)

  $checksum = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumPath = "$ArchivePath.sha256"
  Set-Content -LiteralPath $checksumPath -Value "$checksum  $([System.IO.Path]::GetFileName($ArchivePath))" -Encoding ascii
}

function Assert-Sha256File {
  param([Parameter(Mandatory = $true)][string]$ArchivePath)

  $checksumPath = "$ArchivePath.sha256"
  $expected = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0]
  $actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    throw "SHA-256 verification failed for $ArchivePath"
  }
}

$backendPathResolved = (Resolve-Path -LiteralPath $BackendPath).Path
$frontendPathResolved = (Resolve-Path -LiteralPath $FrontendPath).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bayat-parrot-package-" + [guid]::NewGuid().ToString('N'))
$backendStage = Join-Path $stagingRoot 'backend'
$frontendStage = Join-Path $stagingRoot 'frontend'

$apiUri = $null
if (-not [System.Uri]::TryCreate($PublicApiUrl, [System.UriKind]::Absolute, [ref]$apiUri) -or
    $apiUri.Scheme -notin @('http', 'https') -or
    -not [string]::IsNullOrEmpty($apiUri.UserInfo)) {
  throw 'PublicApiUrl must be an absolute HTTP(S) URL without embedded credentials.'
}

$backendPackage = Get-Content -LiteralPath (Join-Path $backendPathResolved 'package.json') -Raw | ConvertFrom-Json
$frontendPackage = Get-Content -LiteralPath (Join-Path $frontendPathResolved 'package.json') -Raw | ConvertFrom-Json
$backendArchive = Join-Path $outputPath "bayat-api-$($backendPackage.version).tar.gz"
$frontendArchive = Join-Path $outputPath "bayat-web-$($frontendPackage.version).tar.gz"
$previousPublicApiUrl = $env:NEXT_PUBLIC_API_URL

try {
  New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
  New-Item -ItemType Directory -Path $backendStage, $frontendStage -Force | Out-Null

  Invoke-NpmBuild -Path $backendPathResolved

  $env:NEXT_PUBLIC_API_URL = $PublicApiUrl
  Invoke-NpmBuild -Path $frontendPathResolved

  if (-not (Test-Path -LiteralPath (Join-Path $backendPathResolved 'dist/main.js') -PathType Leaf)) {
    throw 'Backend build did not produce dist/main.js.'
  }

  if (-not (Test-Path -LiteralPath (Join-Path $frontendPathResolved '.next/standalone/server.js') -PathType Leaf)) {
    throw 'Frontend build did not produce .next/standalone/server.js.'
  }

  Copy-DirectoryContents -Source (Join-Path $backendPathResolved 'dist') -Destination (Join-Path $backendStage 'dist')
  Copy-Item -LiteralPath (Join-Path $backendPathResolved 'package.json') -Destination $backendStage
  Copy-Item -LiteralPath (Join-Path $backendPathResolved 'package-lock.json') -Destination $backendStage
  $runtimeMetadata = [ordered]@{
    targetOs = 'linux'
    targetArch = 'x64'
    nodeMajor = 22
    installCommand = 'npm ci --omit=dev --no-audit --no-fund'
  }
  $runtimeMetadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backendStage 'runtime-metadata.json') -Encoding utf8

  $standaloneTarget = Join-Path $frontendStage '.next/standalone'
  $staticTarget = Join-Path $frontendStage '.next/static'
  Copy-DirectoryContents -Source (Join-Path $frontendPathResolved '.next/standalone') -Destination $standaloneTarget
  Copy-DirectoryContents -Source (Join-Path $frontendPathResolved '.next/static') -Destination $staticTarget
  Copy-DirectoryContents -Source (Join-Path $frontendPathResolved 'public') -Destination (Join-Path $frontendStage 'public')

  Assert-ProtectedArtifact -Root $backendStage
  Assert-BackendArtifactLayout -Root $backendStage
  Assert-ProtectedArtifact -Root $frontendStage

  New-TarGzArchive -SourceDirectory $backendStage -ArchivePath $backendArchive
  New-TarGzArchive -SourceDirectory $frontendStage -ArchivePath $frontendArchive
  Write-Sha256File -ArchivePath $backendArchive
  Write-Sha256File -ArchivePath $frontendArchive
  Assert-Sha256File -ArchivePath $backendArchive
  Assert-Sha256File -ArchivePath $frontendArchive

  Write-Output "Created $backendArchive"
  Write-Output "Created ${backendArchive}.sha256"
  Write-Output "Created $frontendArchive"
  Write-Output "Created ${frontendArchive}.sha256"
}
finally {
  if ($null -eq $previousPublicApiUrl) {
    Remove-Item Env:NEXT_PUBLIC_API_URL -ErrorAction SilentlyContinue
  }
  else {
    $env:NEXT_PUBLIC_API_URL = $previousPublicApiUrl
  }

  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedStaging = [System.IO.Path]::GetFullPath($stagingRoot)
  if ($resolvedStaging.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedStaging)) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
  }
}
