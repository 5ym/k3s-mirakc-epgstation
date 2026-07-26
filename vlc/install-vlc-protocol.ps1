if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$root = 'Registry::HKEY_CLASSES_ROOT\cvlc'
New-Item -Path $root -Force | Out-Null
Set-ItemProperty -Path $root -Name '(default)' -Value 'URL:VLC Protocol'
New-ItemProperty -Path $root -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

$command = "$root\shell\open\command"
New-Item -Path $command -Force | Out-Null
New-ItemProperty -Path $command -Name '(default)' `
    -Value '"%USERPROFILE%\OneDrive\Tool\vlc.bat" "%1"' `
    -PropertyType ExpandString -Force | Out-Null

Write-Host "cvlc:// protocol registered."
