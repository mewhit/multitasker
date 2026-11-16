[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:installProcess = $null
$script:logPaths = @()
$script:page = 'welcome'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Multitasker Setup'
$form.ClientSize = New-Object System.Drawing.Size(680, 510)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$heading = New-Object System.Windows.Forms.Label
$heading.SetBounds(24, 22, 630, 36)
$heading.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($heading)

$description = New-Object System.Windows.Forms.Label
$description.SetBounds(24, 68, 630, 100)
$form.Controls.Add($description)

$options = New-Object System.Windows.Forms.Panel
$options.SetBounds(24, 174, 630, 206)
$form.Controls.Add($options)

function New-Option {
  param([string]$Text, [int]$Top)
  $box = New-Object System.Windows.Forms.CheckBox
  $box.Text = $Text
  $box.Checked = $true
  $box.SetBounds(0, $Top, 620, 30)
  $options.Controls.Add($box)
  return $box
}

$startup = New-Option 'Start Multitasker automatically when I sign in to Windows' 0
$shortcuts = New-Option 'Create Desktop and Start Menu shortcuts' 38
$pathOption = New-Option 'Add the multitasker command to my PATH' 76
$startNow = New-Option 'Launch Multitasker when setup finishes' 114

$log = New-Object System.Windows.Forms.TextBox
$log.SetBounds(24, 174, 630, 252)
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Both'
$log.WordWrap = $false
$log.Font = New-Object System.Drawing.Font('Consolas', 9)
$log.Visible = $false
$form.Controls.Add($log)

$back = New-Object System.Windows.Forms.Button
$back.Text = 'Back'
$back.SetBounds(340, 454, 96, 32)
$form.Controls.Add($back)
$next = New-Object System.Windows.Forms.Button
$next.SetBounds(446, 454, 100, 32)
$form.Controls.Add($next)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.SetBounds(556, 454, 100, 32)
$form.Controls.Add($cancel)
$form.AcceptButton = $next
$form.CancelButton = $cancel

function Show-Page {
  param([string]$Page)
  $script:page = $Page
  $description.Height = if ($Page -eq 'welcome') { 300 } else { 100 }
  $options.Visible = $Page -eq 'options'
  $log.Visible = $Page -in @('installing', 'failed', 'complete')
  $back.Enabled = $Page -eq 'options'
  $next.Enabled = $Page -ne 'installing'
  $cancel.Enabled = $Page -ne 'installing'
  switch ($Page) {
    'welcome' {
      $heading.Text = 'Welcome to Multitasker Setup'
      $description.Text = "This wizard installs dependencies and builds Multitasker for your Windows account.`r`n`r`nNode.js with npm and an internet connection are required. The app runs from this folder; keep it here after setup:`r`n$projectRoot"
      $next.Text = 'Next'
    }
    'options' {
      $heading.Text = 'Choose your setup options'
      $description.Text = 'Automatic startup opens the app after you sign in following a boot or restart. Setup does not require administrator access.'
      $next.Text = 'Install'
    }
    'installing' {
      $heading.Text = 'Installing Multitasker'
      $description.Text = 'Installing dependencies and building the app. This may take several minutes. You can follow progress below.'
      $next.Text = 'Install'
    }
    'complete' {
      $heading.Text = 'Multitasker is ready'
      $description.Text = "Setup completed. Open a new terminal to use the multitasker command if you enabled PATH integration.`r`n`r`nInstallation logs: $script:logDirectory"
      $next.Text = 'Finish'
      $cancel.Enabled = $false
    }
    'failed' {
      $heading.Text = 'Setup could not finish'
      $description.Text = "Review the error below, fix the problem, then retry. Completed steps may already have created shortcuts or updated PATH.`r`n`r`nInstallation logs: $script:logDirectory"
      $next.Text = 'Retry'
      $back.Enabled = $true
    }
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
function Update-Log {
  $parts = foreach ($file in $script:logPaths) {
    if (Test-Path -LiteralPath $file) {
      Get-Content -LiteralPath $file -Tail 150 -ErrorAction SilentlyContinue
    }
  }
  $log.Text = $parts -join [Environment]::NewLine
  $log.SelectionStart = $log.TextLength
  $log.ScrollToCaret()
}

$timer.Add_Tick({
  Update-Log
  if ($script:installProcess -and $script:installProcess.HasExited) {
    $timer.Stop()
    # WaitForExit ensures the process exit code is available before disposing it.
    $script:installProcess.WaitForExit()
    $exitCode = $script:installProcess.ExitCode
    $script:installProcess.Dispose()
    $script:installProcess = $null
    Update-Log
    if ($exitCode -eq 0) { Show-Page 'complete' } else { Show-Page 'failed' }
  }
})

function Start-Installation {
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    [void][System.Windows.Forms.MessageBox]::Show($form, 'Install Node.js with npm, then close and reopen setup.', 'Node.js is required', 'OK', 'Warning')
    return
  }
  $script:logDirectory = Join-Path $env:LOCALAPPDATA ('Multitasker\SetupLogs\' + [Guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Path $script:logDirectory -Force | Out-Null
    $script:logPaths = @((Join-Path $script:logDirectory 'install.log'), (Join-Path $script:logDirectory 'error.log'))
    $installer = Join-Path $PSScriptRoot 'install-windows.ps1'
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $installer))
    if (-not $startup.Checked) { $arguments += '-NoStartup' }
    if (-not $shortcuts.Checked) { $arguments += '-NoShortcuts' }
    if (-not $pathOption.Checked) { $arguments += '-NoPath' }
    if ($startNow.Checked) { $arguments += '-StartNow' }
    $script:installProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $script:logPaths[0] -RedirectStandardError $script:logPaths[1] -PassThru
    Show-Page 'installing'
    $timer.Start()
  } catch {
    Show-Page 'failed'
    $log.Text = $_.Exception.Message
  }
}

$next.Add_Click({
  switch ($script:page) {
    'welcome' { Show-Page 'options' }
    'options' { Start-Installation }
    'failed' { Start-Installation }
    'complete' { $form.Close() }
  }
})
$back.Add_Click({
  if ($script:page -eq 'failed') { Show-Page 'options' } else { Show-Page 'welcome' }
})
$cancel.Add_Click({ $form.Close() })
$form.Add_FormClosing({
  param($sender, $eventArgs)
  if ($script:page -eq 'installing') {
    $eventArgs.Cancel = $true
    [void][System.Windows.Forms.MessageBox]::Show($form, 'Please wait for installation to finish before closing setup.', 'Installation in progress')
  }
})

Show-Page 'welcome'
try {
  [void]$form.ShowDialog()
} finally {
  $timer.Dispose()
  $form.Dispose()
}
