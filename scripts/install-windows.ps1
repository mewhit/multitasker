[CmdletBinding()]
param(
  [switch]$NoDependencies,
  [switch]$NoBuild,
  [switch]$NoPath,
  [switch]$NoStartup,
  [switch]$NoShortcuts,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Step {
  param([string]$Message)
  Write-Host "[multitasker installer] $Message"
}

function Assert-Windows {
  if ($env:OS -ne 'Windows_NT') {
    throw 'This installer is for Windows only.'
  }
}

function Get-ProjectRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Get-NpmCommand {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
  }
  if (-not $npm) {
    throw 'npm is required. Install Node.js first, then rerun this installer.'
  }
  return $npm.Source
}

function Invoke-Npm {
  param(
    [string]$Npm,
    [string]$ProjectRoot,
    [string[]]$Arguments
  )

  Write-Step "npm $($Arguments -join ' ')"
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

function Normalize-PathEntry {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ''
  }
  try {
    return [IO.Path]::GetFullPath($Value).TrimEnd('\').ToLowerInvariant()
  } catch {
    return $Value.Trim().TrimEnd('\').ToLowerInvariant()
  }
}

function Get-PathEntries {
  param([string]$PathValue)

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return @()
  }
  return $PathValue.Split(';') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
}

function Publish-EnvironmentChange {
  try {
    if (-not ('Environment.NativeMethods' -as [type])) {
      Add-Type -Namespace Environment -Name NativeMethods -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [Environment.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0, 5000, [ref]$result) | Out-Null
  } catch {
    Write-Warning "Path was updated, but Windows was not notified: $($_.Exception.Message)"
  }
}

function Add-UserPathEntry {
  param([string]$Directory)

  $fullDirectory = [IO.Path]::GetFullPath($Directory)
  $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @(Get-PathEntries -PathValue $currentPath)
  $normalizedTarget = Normalize-PathEntry -Value $fullDirectory
  foreach ($entry in $entries) {
    if ((Normalize-PathEntry -Value $entry) -eq $normalizedTarget) {
      Write-Step "PATH already contains $fullDirectory"
      return
    }
  }

  $entries += $fullDirectory
  [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
  $env:Path = "$env:Path;$fullDirectory"
  Publish-EnvironmentChange
  Write-Step "Added $fullDirectory to the user PATH"
}

function Get-PowerShellPath {
  $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($powershell) {
    return $powershell.Source
  }
  return Join-Path $PSHOME 'powershell.exe'
}

function Get-ShortcutIcon {
  param([string]$ProjectRoot)

  $candidates = @(
    (Join-Path $ProjectRoot 'desktop\node_modules\electron\dist\electron.exe'),
    (Get-PowerShellPath)
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }
  return ''
}

function New-MultitaskerShortcut {
  param(
    [string]$ShortcutPath,
    [string]$ProjectRoot,
    [string]$StartScript,
    [string]$Description
  )

  $parent = Split-Path -Parent $ShortcutPath
  New-Item -ItemType Directory -Path $parent -Force | Out-Null

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = Get-PowerShellPath
  $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`""
  $shortcut.WorkingDirectory = $ProjectRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = $Description
  $icon = Get-ShortcutIcon -ProjectRoot $ProjectRoot
  if (-not [string]::IsNullOrWhiteSpace($icon)) {
    $shortcut.IconLocation = "$icon,0"
  }
  $shortcut.Save()
  Write-Step "Created shortcut $ShortcutPath"
}

Assert-Windows

$projectRoot = Get-ProjectRoot
$binDirectory = Join-Path $projectRoot 'bin'
$startScript = Join-Path $projectRoot 'scripts\start-multitasker.ps1'
$npm = Get-NpmCommand

New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null

if (-not $NoDependencies) {
  Invoke-Npm -Npm $npm -ProjectRoot $projectRoot -Arguments @('install')
  Invoke-Npm -Npm $npm -ProjectRoot $projectRoot -Arguments @('run', 'install:apps')
}

if (-not $NoBuild) {
  Invoke-Npm -Npm $npm -ProjectRoot $projectRoot -Arguments @('run', 'build')
}

if (-not $NoPath) {
  Add-UserPathEntry -Directory $binDirectory
}

if (-not $NoStartup) {
  $startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Multitasker.lnk'
  New-MultitaskerShortcut -ShortcutPath $startupShortcut -ProjectRoot $projectRoot -StartScript $startScript -Description 'Start Multitasker when you sign in to Windows'
}

if (-not $NoShortcuts) {
  $programsShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Multitasker\Multitasker.lnk'
  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Multitasker.lnk'
  New-MultitaskerShortcut -ShortcutPath $programsShortcut -ProjectRoot $projectRoot -StartScript $startScript -Description 'Start Multitasker'
  New-MultitaskerShortcut -ShortcutPath $desktopShortcut -ProjectRoot $projectRoot -StartScript $startScript -Description 'Start Multitasker'
}

if ($StartNow) {
  & $startScript
}

Write-Step 'Install complete. Open a new terminal to use the multitasker command.'
