<#
.SYNOPSIS
    denpa の「mpv で再生」ボタンから mpv を開けるようにする。

.DESCRIPTION
    denpa は Windows 向けに mpv://play/<base64url>/ というリンクを出す。
    これを開くには mpv-handler (https://github.com/akiirui/mpv-handler) を
    mpv:// プロトコルのハンドラとして登録する必要がある。

    登録先は HKCU なので管理者権限は要らない。ログインユーザーにだけ効く。

    既に登録されているときは、解除するかどうかを聞く。
    -Remove を付ければ聞かずに解除する。

.PARAMETER HandlerPath
    mpv-handler.exe の場所。省略すると PATH と既定の場所から探す。

.PARAMETER Remove
    確認せずに登録を解除する。

.EXAMPLE
    .\mpv-handler.ps1
    .\mpv-handler.ps1 -HandlerPath C:\tools\mpv-handler\mpv-handler.exe
    .\mpv-handler.ps1 -Remove
#>

[CmdletBinding()]
param(
    [string] $HandlerPath,
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'

# HKCU なので管理者権限は要らない。HKLM に書くと全ユーザーに効いてしまう
$Root = 'HKCU:\Software\Classes\mpv'
$Command = "$Root\shell\open\command"

function Get-RegisteredCommand {
    if (-not (Test-Path $Command)) { return $null }
    return (Get-ItemProperty -Path $Command -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
}

function Remove-Registration {
    if (-not (Test-Path $Root)) {
        Write-Host 'mpv:// は登録されていません。'
        return
    }
    Remove-Item -Path $Root -Recurse -Force
    Write-Host '解除しました。'
}

function Find-Handler {
    if ($HandlerPath) {
        if (-not (Test-Path $HandlerPath)) { throw "指定された場所に見つかりません: $HandlerPath" }
        return (Resolve-Path $HandlerPath).Path
    }

    $onPath = Get-Command 'mpv-handler.exe' -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    # scoop / winget / 手で置いた場合によくある場所
    $candidates = @(
        "$env:USERPROFILE\scoop\apps\mpv-handler\current\mpv-handler.exe",
        "$env:LOCALAPPDATA\mpv-handler\mpv-handler.exe",
        "$env:LOCALAPPDATA\Programs\mpv-handler\mpv-handler.exe",
        "$env:ProgramFiles\mpv-handler\mpv-handler.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }

    throw @'
mpv-handler.exe が見つかりません。

  https://github.com/akiirui/mpv-handler/releases

から取ってきて置いたうえで、その場所を -HandlerPath で指定してください。
mpv 本体も別に要ります (mpv-handler は mpv を呼び出すだけ)。
'@
}

# --- 解除 -----------------------------------------------------------------

if ($Remove) {
    Remove-Registration
    return
}

$existing = Get-RegisteredCommand
if ($existing) {
    Write-Host 'mpv:// は既に登録されています。'
    Write-Host "  $existing"
    Write-Host ''
    $answer = Read-Host '解除しますか? [y/N]'
    if ($answer -match '^[yY]') {
        Remove-Registration
    }
    else {
        Write-Host 'そのままにします。登録し直したいときは一度解除してから実行してください。'
    }
    return
}

# --- 登録 -----------------------------------------------------------------

$handler = Find-Handler
Write-Host "mpv-handler: $handler"

New-Item -Path $Root -Force | Out-Null
# URL プロトコルであることの印。値の中身は見られないが、名前が無いと効かない
New-ItemProperty -Path $Root -Name '(default)' -Value 'URL:mpv Protocol' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $Root -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

New-Item -Path $Command -Force | Out-Null
# %1 に mpv://play/<base64url>/ がそのまま入る
New-ItemProperty -Path $Command -Name '(default)' -Value "`"$handler`" `"%1`"" -PropertyType String -Force | Out-Null

Write-Host '登録しました。'
Write-Host ''
Write-Host '確認のしかた: denpa の録画一覧で「mpv で再生」を押す。'
Write-Host 'ブラウザが「このサイトが mpv を開こうとしています」と聞いてくるので許可する。'
Write-Host ''
Write-Host '解除: .\mpv-handler.ps1 -Remove'
