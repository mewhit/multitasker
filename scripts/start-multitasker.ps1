[CmdletBinding()]
param(
  [switch]$Attach,
  [switch]$Rebuild,
  [switch]$NoHealthProbe
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Get-ProjectRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Get-NpmCommand {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
  }
  if (-not $npm) {
    throw 'npm is required to start Multitasker. Install Node.js and rerun the installer.'
  }
  return $npm.Source
}

function Get-BackendPort {
  $value = [Environment]::GetEnvironmentVariable('MULTITASKER_BACKEND_PORT')
  $port = 0
  if ([int]::TryParse($value, [ref]$port) -and $port -gt 0 -and $port -le 65535) {
    return $port
  }
  return 39017
}

function Test-BackendHealth {
  param([int]$Port)

  if ($NoHealthProbe) {
    return $false
  }

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Wait-BackendHealth {
  param(
    [int]$Port,
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-BackendHealth -Port $Port) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-MissingBuildArtifacts {
  param([string]$ProjectRoot)

  $required = @(
    'dist\desktop\src\main.js',
    'dist\renderer\index.html',
    'dist\http-server\server.js',
    'dist\shell\supervisor\index.js',
    'dist\ws-server\server.js'
  )

  $missing = @()
  foreach ($relativePath in $required) {
    $fullPath = Join-Path $ProjectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath)) {
      $missing += $relativePath
    }
  }
  return $missing
}

function Invoke-Npm {
  param(
    [string]$Npm,
    [string]$ProjectRoot,
    [string[]]$Arguments
  )

  Push-Location $ProjectRoot
  try {
    & $Npm @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

function Start-NpmDetached {
  param(
    [string]$Npm,
    [string]$ProjectRoot,
    [string[]]$Arguments
  )

  $logDirectory = Join-Path $ProjectRoot '.tmp\launcher'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutLog = Join-Path $logDirectory "multitasker-$timestamp.out.log"
  $stderrLog = Join-Path $logDirectory "multitasker-$timestamp.err.log"

  return Start-Process `
    -FilePath $Npm `
    -ArgumentList $Arguments `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
}

$projectRoot = Get-ProjectRoot
$npm = Get-NpmCommand

if ($Rebuild) {
  Invoke-Npm -Npm $npm -ProjectRoot $projectRoot -Arguments @('run', 'build')
}

$missingArtifacts = @(Get-MissingBuildArtifacts -ProjectRoot $projectRoot)
if ($missingArtifacts.Count -gt 0) {
  throw "Build artifacts are missing: $($missingArtifacts -join ', '). Run `npm run install:windows` or `npm run build` first."
}

$backendPort = Get-BackendPort
$hasBackend = Test-BackendHealth -Port $backendPort
$npmArguments = @('start')
if ($hasBackend) {
  $npmArguments = @('run', 'start:electron')
}

if ($Attach) {
  Invoke-Npm -Npm $npm -ProjectRoot $projectRoot -Arguments $npmArguments
  exit $LASTEXITCODE
}

$process = Start-NpmDetached -Npm $npm -ProjectRoot $projectRoot -Arguments $npmArguments
if (-not $hasBackend) {
  [void](Wait-BackendHealth -Port $backendPort -TimeoutSeconds 15)
}
Write-Host "Multitasker started (PID $($process.Id))."
