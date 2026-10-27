[CmdletBinding()]
param(
  [switch]$KeepPath,
  [switch]$KeepStartup,
  [switch]$KeepShortcuts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Step {
  param([string]$Message)
  Write-Host "[multitasker uninstall] $Message"
}

function Get-ProjectRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
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

function Remove-UserPathEntry {
  param([string]$Directory)

  $fullDirectory = [IO.Path]::GetFullPath($Directory)
  $target = Normalize-PathEntry -Value $fullDirectory
  $entries = @(Get-PathEntries -PathValue ([Environment]::GetEnvironmentVariable('Path', 'User')))
  $remaining = @()
  $removed = $false
  foreach ($entry in $entries) {
    if ((Normalize-PathEntry -Value $entry) -eq $target) {
      $removed = $true
      continue
    }
    $remaining += $entry
  }

  if (-not $removed) {
    Write-Step "PATH did not contain $fullDirectory"
    return
  }

  [Environment]::SetEnvironmentVariable('Path', ($remaining -join ';'), 'User')
  Publish-EnvironmentChange
  Write-Step "Removed $fullDirectory from the user PATH"
}

function Remove-Shortcut {
  param([string]$ShortcutPath)

  if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
    Write-Step "Removed shortcut $ShortcutPath"
  }
}

$projectRoot = Get-ProjectRoot
$binDirectory = Join-Path $projectRoot 'bin'

if (-not $KeepPath) {
  Remove-UserPathEntry -Directory $binDirectory
}

if (-not $KeepStartup) {
  Remove-Shortcut -ShortcutPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'Multitasker.lnk')
}

if (-not $KeepShortcuts) {
  Remove-Shortcut -ShortcutPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Multitasker\Multitasker.lnk')
  Remove-Shortcut -ShortcutPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Multitasker.lnk')
}

Write-Step 'Uninstall complete.'
