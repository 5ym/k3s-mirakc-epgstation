if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Remove-Item -Path 'Registry::HKEY_CLASSES_ROOT\cvlc' -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "cvlc:// protocol removed."
