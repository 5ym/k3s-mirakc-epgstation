<#
.SYNOPSIS
    denpa の「mpv で再生」ボタンから mpv を開けるようにする。

.DESCRIPTION
    denpa は Windows 向けに mpv-handler://play/<base64url>/?v_title=<base64url>
    というリンクを出す。これを開くには mpv-handler
    (https://github.com/akiirui/mpv-handler) をプロトコルハンドラとして
    登録する必要がある。

    mpv-handler 同梱の handler-install.bat と同じことをする。違いは、
    登録済みなら解除するかを聞くことと、mpv-handler.exe と config.toml を
    探して足りないものを教えること。

    登録先は HKCU なので管理者権限は要らない。ログインユーザーにだけ効く。

    scheme は mpv-handler と mpv-handler-debug の2つを登録する。
    debug のほうはコンソールを出したまま動くので、うまくいかないときに使う。
    (mpv:// は mpv-handler 0.3 までの古い名前。いまは使われていない)

.PARAMETER HandlerPath
    mpv-handler.exe の場所。省略すると PATH と既定の場所から探す。

.PARAMETER Remove
    確認せずに登録を解除する。

.PARAMETER Test
    登録を使って実際に開いてみる。URL を渡すとそれを、省略すると
    サンプルを開く。何も起きないときの切り分け用。

.EXAMPLE
    .\mpv-handler.ps1
    .\mpv-handler.ps1 -HandlerPath C:\tools\mpv-handler\mpv-handler.exe
    .\mpv-handler.ps1 -Test https://dp.home.arpa/api/recordings/12/file
    .\mpv-handler.ps1 -Remove
#>

[CmdletBinding()]
param(
    [string] $HandlerPath,
    [switch] $Remove,
    [string] $Test
)

$ErrorActionPreference = 'Stop'

# HKCU なので管理者権限は要らない。HKLM に書くと全ユーザーに効いてしまう
$Schemes = @('mpv-handler', 'mpv-handler-debug')
function Root([string] $scheme) { "HKCU:\Software\Classes\$scheme" }
function CommandKey([string] $scheme) { "$(Root $scheme)\shell\open\command" }

function Get-RegisteredCommand([string] $scheme) {
    $key = CommandKey $scheme
    if (-not (Test-Path $key)) { return $null }
    return (Get-ItemProperty -Path $key -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
}

function Remove-Registration {
    $removed = $false
    foreach ($scheme in $Schemes) {
        $key = Root $scheme
        if (Test-Path $key) {
            Remove-Item -Path $key -Recurse -Force
            $removed = $true
        }
    }
    # 0.3 までの古い名前。残っていると紛らわしいので一緒に片付ける
    if (Test-Path 'HKCU:\Software\Classes\mpv') {
        Remove-Item -Path 'HKCU:\Software\Classes\mpv' -Recurse -Force
        $removed = $true
    }
    if ($removed) { Write-Host '解除しました。' } else { Write-Host '登録されていません。' }
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

# mpv-handler は同じフォルダの config.toml を見て mpv の場所を決める。
# 無いと mpv を見つけられず、押しても一瞬で終わって何も起きない
function Test-Config([string] $handler) {
    $config = Join-Path (Split-Path $handler -Parent) 'config.toml'
    if (-not (Test-Path $config)) {
        Write-Warning "config.toml がありません: $config"
        Write-Host '  mpv の場所を書いておかないと、押しても何も起きません。例:'
        Write-Host '    mpv = "C:/Program Files/mpv/mpv.com"'
        return
    }
    $mpv = (Select-String -Path $config -Pattern '^\s*mpv\s*=' | Select-Object -First 1).Line
    if ($mpv) { Write-Host "config.toml: $($mpv.Trim())" }
    else { Write-Warning "config.toml に mpv の行がありません: $config" }
}

function ConvertTo-Base64Url([string] $text) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

# --- 解除 -----------------------------------------------------------------

if ($Remove) {
    Remove-Registration
    return
}

# --- 動作確認 -------------------------------------------------------------

if ($PSBoundParameters.ContainsKey('Test')) {
    $target = if ($Test) { $Test } else { 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4' }
    $link = "mpv-handler-debug://play/$(ConvertTo-Base64Url $target)/?v_title=$(ConvertTo-Base64Url 'denpa テスト')"
    Write-Host "開くリンク: $link"
    Write-Host '(debug 版なのでコンソールが出ます。エラーがあればそこに出ます)'
    Start-Process $link
    return
}

# --- 登録 -----------------------------------------------------------------

$existing = Get-RegisteredCommand 'mpv-handler'
if ($existing) {
    Write-Host 'mpv-handler:// は既に登録されています。'
    Write-Host "  $existing"
    Write-Host ''
    $answer = Read-Host '解除しますか? [y/N]'
    if ($answer -match '^[yY]') { Remove-Registration }
    else { Write-Host 'そのままにします。登録し直すときは一度解除してください。' }
    return
}

$handler = Find-Handler
Write-Host "mpv-handler: $handler"
Test-Config $handler

foreach ($scheme in $Schemes) {
    $root = Root $scheme
    New-Item -Path $root -Force | Out-Null
    # URL プロトコルであることの印。URL Protocol が無いと Windows は無視する
    Set-ItemProperty -Path $root -Name '(default)' -Value "URL:$scheme Protocol"
    Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''

    New-Item -Path (CommandKey $scheme) -Force | Out-Null
    # %1 にリンクがそのまま入る
    Set-ItemProperty -Path (CommandKey $scheme) -Name '(default)' -Value "`"$handler`" `"%1`""
}

# 書けたことを見てから終わる。黙って失敗すると原因が分からなくなる
foreach ($scheme in $Schemes) {
    $value = Get-RegisteredCommand $scheme
    if (-not $value) { throw "$scheme の登録に失敗しました。" }
    Write-Host "${scheme}: $value"
}

Write-Host ''
Write-Host '登録しました。確認は .\mpv-handler.ps1 -Test'
Write-Host '解除は .\mpv-handler.ps1 -Remove'
