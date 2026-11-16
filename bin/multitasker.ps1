#!/usr/bin/env pwsh
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
& (Join-Path $scriptDir '..\scripts\start-multitasker.ps1') @args
exit $LASTEXITCODE
