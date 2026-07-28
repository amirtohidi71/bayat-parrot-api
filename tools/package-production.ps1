[CmdletBinding(DefaultParameterSetName = 'Full')]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
  [string]$ReleaseId,

  [Parameter(Mandatory = $true, ParameterSetName = 'Full')]
  [ValidateNotNullOrEmpty()]
  [string]$PublicApiUrl,

  [string]$BackendPath = (Split-Path -Parent $PSScriptRoot),

  [Parameter(ParameterSetName = 'Full')]
  [string]$FrontendPath = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'bayat-parrot'),

  [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts'),

  [Parameter(Mandatory = $true, ParameterSetName = 'BackendOnly')]
  [switch]$BackendOnly
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

function Get-CleanRepositoryCommit {
  param([Parameter(Mandatory = $true)][string]$Path)

  $insideWorkTreeOutput = @(& git -C $Path rev-parse --is-inside-work-tree)
  if ($LASTEXITCODE -ne 0 -or $insideWorkTreeOutput.Count -ne 1 -or
      $insideWorkTreeOutput[0].Trim() -ne 'true') {
    throw "Path is not a Git working tree: $Path"
  }

  $status = @(& git -C $Path status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect Git working tree: $Path"
  }
  if ($status.Count -gt 0) {
    throw "Git working tree must be clean before packaging: $Path"
  }

  $commitOutput = @(& git -C $Path rev-parse --short=12 HEAD)
  if ($LASTEXITCODE -ne 0 -or $commitOutput.Count -ne 1) {
    throw "Failed to resolve a valid commit hash: $Path"
  }
  $commit = $commitOutput[0].Trim()
  if ($commit -notmatch '^[0-9a-fA-F]{7,64}$') {
    throw "Failed to resolve a valid commit hash: $Path"
  }

  return $commit.ToLowerInvariant()
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
  $forbiddenDirectories = @(
    '.git', '.github', '.ssh', 'src', 'test', 'tests', '__tests__', 'coverage',
    'docs', 'progress'
  )
  $developmentDirectories = @('tools', 'scripts')
  $forbiddenFiles = @(
    '.git', '.gitignore', '.gitattributes', '.gitmodules', '.npmrc', '.yarnrc',
    'id_rsa', 'id_ed25519', 'credentials.json'
  )
  $forbidden = @($allItems | Where-Object {
      $insideNodeModules = $_.FullName -match '[\\/]node_modules[\\/]'
      ($_.PSIsContainer -and ($_.Name -in $forbiddenDirectories -or
          ($_.Name -in $developmentDirectories -and -not $insideNodeModules))) -or
      (-not $_.PSIsContainer -and ($_.Name -in $forbiddenFiles -or
          $_.Name -eq '.env' -or
          $_.Name -like '.env.*' -or
          $_.Name -like '*.env' -or
          $_.Name -like '.yarnrc*' -or
          $_.Name -like '*.ts' -or
          $_.Name -like '*.tsx' -or
          $_.Name -like '*.jsx' -or
          $_.Name -like '*.spec.*' -or
          $_.Name -like '*.test.*' -or
          $_.Name -like '*.map' -or
          $_.Name -like '*.tsbuildinfo' -or
          $_.Name -like '*.pem' -or
          $_.Name -like '*.key' -or
          $_.Name -like '*.pfx' -or
          $_.Name -like '*.p12' -or
          $_.Name -like 'service-account*.json'))
    })

  if ($forbidden.Count -gt 0) {
    $paths = $forbidden | ForEach-Object { $_.FullName.Substring($Root.Length).TrimStart('\\', '/') }
    throw "Forbidden artifact content detected:`n$($paths -join "`n")"
  }
}

function Test-ArtifactFileIsText {
  param([Parameter(Mandatory = $true)][string]$Path)

  $sampleSize = 4096
  $sample = New-Object byte[] $sampleSize
  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  try {
    $bytesRead = $stream.Read($sample, 0, $sample.Length)
  }
  finally {
    $stream.Dispose()
  }

  if ($bytesRead -eq 0) {
    return $true
  }

  $controlBytes = 0
  for ($index = 0; $index -lt $bytesRead; $index++) {
    $value = $sample[$index]
    if ($value -eq 0) {
      return $false
    }
    if ($value -lt 32 -and $value -notin @(9, 10, 12, 13)) {
      $controlBytes++
    }
  }

  return ($controlBytes / $bytesRead) -le 0.01
}

function Find-ArtifactTextMatch {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object[]]$Patterns
  )

  $chunkSize = 4096
  $maxPatternLength = ($Patterns | ForEach-Object { $_.Value.Length } | Measure-Object -Maximum).Maximum
  $overlapLength = [Math]::Max(0, $maxPatternLength - 1)
  $buffer = New-Object char[] $chunkSize
  $overlap = ''
  $reader = New-Object System.IO.StreamReader(
    $Path,
    [System.Text.Encoding]::UTF8,
    $true,
    $chunkSize
  )
  try {
    while (($charactersRead = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $chunk = New-Object System.String($buffer, 0, $charactersRead)
      $searchText = $overlap + $chunk
      foreach ($pattern in $Patterns) {
        if ($searchText.IndexOf($pattern.Value, [System.StringComparison]::Ordinal) -ge 0) {
          return [pscustomobject]@{ Kind = $pattern.Kind; Name = $pattern.Name }
        }
      }

      if ($overlapLength -eq 0) {
        $overlap = ''
      }
      elseif ($searchText.Length -le $overlapLength) {
        $overlap = $searchText
      }
      else {
        $overlap = $searchText.Substring($searchText.Length - $overlapLength)
      }
    }
  }
  finally {
    $reader.Dispose()
  }

  return $null
}

function Assert-NoArtifactSecrets {
  param([Parameter(Mandatory = $true)][string]$Root)

  $minimumSecretLength = 8
  $commonSecretValues = @(
    'password', 'changeme', 'change-me', 'secret', 'admin', 'default',
    '12345678', 'qwerty'
  )
  $privateKeyMarkers = @(
    'BEGIN PRIVATE KEY',
    'BEGIN RSA PRIVATE KEY',
    'BEGIN OPENSSH PRIVATE KEY',
    'BEGIN EC PRIVATE KEY'
  )
  $sensitiveNames = @(
    'JWT_SECRET', 'DB_PASSWORD', 'IPPANEL_API_KEY', 'GOD_ADMIN_PASSWORD',
    'ADMIN_PASSWORD', 'GITHUB_TOKEN', 'GH_TOKEN'
  )
  $patterns = @($privateKeyMarkers | ForEach-Object {
      [pscustomobject]@{ Kind = 'Marker'; Name = $_; Value = $_ }
    })
  $processEnvironment = [System.Environment]::GetEnvironmentVariables(
    [System.EnvironmentVariableTarget]::Process
  )
  foreach ($entry in $processEnvironment.GetEnumerator()) {
    $name = [string]$entry.Key
    $value = [string]$entry.Value
    if (($name -in $sensitiveNames -or $name -like 'ADMIN_PASSWORD_*') -and
        -not [string]::IsNullOrEmpty($value)) {
      if ([string]::IsNullOrWhiteSpace($value) -or $value.Length -lt $minimumSecretLength -or
          $value -in $commonSecretValues) {
        throw "Sensitive environment variable '$name' is too short or too common for safe artifact scanning."
      }
      $patterns += [pscustomobject]@{ Kind = 'Environment'; Name = $name; Value = $value }
    }
  }

  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File)
  foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($Root.Length).TrimStart('\', '/')
    try {
      $isText = Test-ArtifactFileIsText -Path $file.FullName
    }
    catch {
      throw "Failed to inspect artifact file: $relativePath"
    }
    if (-not $isText) {
      continue
    }

    try {
      $match = Find-ArtifactTextMatch -Path $file.FullName -Patterns $patterns
    }
    catch {
      throw "Failed to inspect artifact file: $relativePath"
    }
    if ($null -ne $match) {
      if ($match.Kind -eq 'Marker') {
        throw "Private-key marker '$($match.Name)' detected in artifact file: $relativePath"
      }
      throw "Secret value for environment variable '$($match.Name)' detected in artifact file: $relativePath"
    }
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

function Assert-FrontendArtifactLayout {
  param([Parameter(Mandatory = $true)][string]$Root)

  $standaloneRoot = Join-Path $Root '.next/standalone'
  if (-not (Test-Path -LiteralPath (Join-Path $standaloneRoot 'server.js') -PathType Leaf)) {
    throw 'Frontend artifact does not contain .next/standalone/server.js.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $standaloneRoot 'public') -PathType Container)) {
    throw 'Frontend artifact does not contain .next/standalone/public.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $standaloneRoot '.next/static') -PathType Container)) {
    throw 'Frontend artifact does not contain .next/standalone/.next/static.'
  }

  $unexpectedEntries = @(Get-ChildItem -LiteralPath $Root -Force | Where-Object {
      $_.Name -ne '.next'
    })
  if ($unexpectedEntries.Count -gt 0) {
    throw "Unexpected frontend artifact content detected: $($unexpectedEntries.Name -join ', ')"
  }

  if (Test-Path -LiteralPath (Join-Path $Root 'public')) {
    throw 'Frontend public directory must be inside .next/standalone.'
  }
  if (Test-Path -LiteralPath (Join-Path $Root '.next/static')) {
    throw 'Frontend static directory must be inside .next/standalone/.next.'
  }
}

function New-TarGzArchive {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$ArchivePath
  )

  if (Test-Path -LiteralPath $ArchivePath) {
    throw "Artifact output already exists: $ArchivePath"
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

function Move-NewFile {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Temporary artifact output does not exist: $Source"
  }
  if (Test-Path -LiteralPath $Destination) {
    throw "Artifact output already exists: $Destination"
  }

  [System.IO.File]::Move($Source, $Destination)
}

function Remove-OwnedDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$ExpectedName
  )

  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedParent = [System.IO.Path]::GetFullPath($Parent)
  $parentPrefix = $resolvedParent.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $resolvedPath) -ne $ExpectedName) {
    throw "Refusing to clean an unsafe packaging directory: $resolvedPath"
  }

  if (Test-Path -LiteralPath $resolvedPath -PathType Container) {
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
  }
}

$backendPathResolved = (Resolve-Path -LiteralPath $BackendPath).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$runId = [guid]::NewGuid().ToString('N')
$stagingName = "bayat-parrot-package-$runId"
$publishName = ".bayat-parrot-package-$ReleaseId-$runId"
$stagingRoot = Join-Path $tempRoot $stagingName
$publishRoot = Join-Path $outputPath $publishName
$lockPath = Join-Path $tempRoot "bayat-parrot-package-$ReleaseId.lock"
$backendStage = Join-Path $stagingRoot 'backend'
$lockStream = $null
$lockAcquired = $false
$publishedOutputs = @()
$previousPublicApiUrl = $null

if (-not $BackendOnly) {
  $frontendPathResolved = (Resolve-Path -LiteralPath $FrontendPath).Path
  $frontendStage = Join-Path $stagingRoot 'frontend'
  $previousPublicApiUrl = $env:NEXT_PUBLIC_API_URL

  $apiUri = $null
  if (-not [System.Uri]::TryCreate($PublicApiUrl, [System.UriKind]::Absolute, [ref]$apiUri) -or
      $apiUri.Scheme -notin @('http', 'https') -or
      -not [string]::IsNullOrEmpty($apiUri.UserInfo)) {
    throw 'PublicApiUrl must be an absolute HTTP(S) URL without embedded credentials.'
  }
}

try {
  try {
    $lockStream = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    $lockAcquired = $true
  }
  catch [System.IO.IOException] {
    if (Test-Path -LiteralPath $lockPath) {
      throw "Packaging lock already exists for release '$ReleaseId': $lockPath. Verify that no packaging process is active before removing it; do not delete the lock blindly."
    }
    throw
  }

  $backendCommit = Get-CleanRepositoryCommit -Path $backendPathResolved
  $backendArchive = Join-Path $outputPath "backend-$ReleaseId-$backendCommit.tar.gz"
  $artifactOutputs = @(
    $backendArchive,
    "$backendArchive.sha256"
  )
  if (-not $BackendOnly) {
    $frontendCommit = Get-CleanRepositoryCommit -Path $frontendPathResolved
    $frontendArchive = Join-Path $outputPath "frontend-$ReleaseId-$frontendCommit.tar.gz"
    $artifactOutputs += $frontendArchive, "$frontendArchive.sha256"
  }
  foreach ($artifactOutput in $artifactOutputs) {
    if (Test-Path -LiteralPath $artifactOutput) {
      throw "Artifact output already exists: $artifactOutput"
    }
  }

  New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
  New-Item -ItemType Directory -Path $backendStage -Force | Out-Null
  if (-not $BackendOnly) {
    New-Item -ItemType Directory -Path $frontendStage -Force | Out-Null
  }

  Invoke-NpmBuild -Path $backendPathResolved

  if (-not $BackendOnly) {
    $env:NEXT_PUBLIC_API_URL = $PublicApiUrl
    Invoke-NpmBuild -Path $frontendPathResolved
  }

  if ((Get-CleanRepositoryCommit -Path $backendPathResolved) -ne $backendCommit) {
    throw 'Repository commit changed during packaging.'
  }
  if (-not $BackendOnly) {
    if ((Get-CleanRepositoryCommit -Path $frontendPathResolved) -ne $frontendCommit) {
      throw 'Repository commit changed during packaging.'
    }
  }

  if (-not (Test-Path -LiteralPath (Join-Path $backendPathResolved 'dist/main.js') -PathType Leaf)) {
    throw 'Backend build did not produce dist/main.js.'
  }

  if (-not $BackendOnly) {
    if (-not (Test-Path -LiteralPath (Join-Path $frontendPathResolved '.next/standalone/server.js') -PathType Leaf)) {
      throw 'Frontend build did not produce .next/standalone/server.js.'
    }
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

  if (-not $BackendOnly) {
    $standaloneTarget = Join-Path $frontendStage '.next/standalone'
    Copy-DirectoryContents -Source (Join-Path $frontendPathResolved '.next/standalone') -Destination $standaloneTarget
    Copy-DirectoryContents -Source (Join-Path $frontendPathResolved '.next/static') -Destination (Join-Path $standaloneTarget '.next/static')
    Copy-DirectoryContents -Source (Join-Path $frontendPathResolved 'public') -Destination (Join-Path $standaloneTarget 'public')
  }

  Assert-ProtectedArtifact -Root $backendStage
  Assert-NoArtifactSecrets -Root $backendStage
  Assert-BackendArtifactLayout -Root $backendStage
  if (-not $BackendOnly) {
    Assert-ProtectedArtifact -Root $frontendStage
    Assert-NoArtifactSecrets -Root $frontendStage
    Assert-FrontendArtifactLayout -Root $frontendStage
  }

  New-Item -ItemType Directory -Path $publishRoot | Out-Null
  $backendTemporaryArchive = Join-Path $publishRoot ([System.IO.Path]::GetFileName($backendArchive))

  New-TarGzArchive -SourceDirectory $backendStage -ArchivePath $backendTemporaryArchive
  if (-not $BackendOnly) {
    $frontendTemporaryArchive = Join-Path $publishRoot ([System.IO.Path]::GetFileName($frontendArchive))
    New-TarGzArchive -SourceDirectory $frontendStage -ArchivePath $frontendTemporaryArchive
  }
  Write-Sha256File -ArchivePath $backendTemporaryArchive
  if (-not $BackendOnly) {
    Write-Sha256File -ArchivePath $frontendTemporaryArchive
  }
  Assert-Sha256File -ArchivePath $backendTemporaryArchive
  if (-not $BackendOnly) {
    Assert-Sha256File -ArchivePath $frontendTemporaryArchive
  }

  Move-NewFile -Source "$backendTemporaryArchive.sha256" -Destination "$backendArchive.sha256"
  $publishedOutputs += "$backendArchive.sha256"
  Move-NewFile -Source $backendTemporaryArchive -Destination $backendArchive
  $publishedOutputs += $backendArchive

  if (-not $BackendOnly) {
    Move-NewFile -Source "$frontendTemporaryArchive.sha256" -Destination "$frontendArchive.sha256"
    $publishedOutputs += "$frontendArchive.sha256"
    Move-NewFile -Source $frontendTemporaryArchive -Destination $frontendArchive
    $publishedOutputs += $frontendArchive
  }

  Write-Output "Created $backendArchive"
  Write-Output "Created ${backendArchive}.sha256"
  if (-not $BackendOnly) {
    Write-Output "Created $frontendArchive"
    Write-Output "Created ${frontendArchive}.sha256"
  }
}
catch {
  foreach ($publishedOutput in $publishedOutputs) {
    if (Test-Path -LiteralPath $publishedOutput -PathType Leaf) {
      Remove-Item -LiteralPath $publishedOutput -Force
    }
  }
  throw
}
finally {
  try {
    if (-not $BackendOnly) {
      if ($null -eq $previousPublicApiUrl) {
        Remove-Item Env:NEXT_PUBLIC_API_URL -ErrorAction SilentlyContinue
      }
      else {
        $env:NEXT_PUBLIC_API_URL = $previousPublicApiUrl
      }
    }
  }
  finally {
    try {
      Remove-OwnedDirectory -Path $stagingRoot -Parent $tempRoot -ExpectedName $stagingName
    }
    finally {
      try {
        Remove-OwnedDirectory -Path $publishRoot -Parent $outputPath -ExpectedName $publishName
      }
      finally {
        try {
          if ($null -ne $lockStream) {
            $lockStream.Dispose()
          }
        }
        finally {
          if ($lockAcquired -and (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
            Remove-Item -LiteralPath $lockPath -Force
          }
        }
      }
    }
  }
}
