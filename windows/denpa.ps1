<#
.SYNOPSIS
    denpa の「mpv で再生」ボタンから mpv を開けるようにする。

.DESCRIPTION
    denpa:// を Windows のプロトコルハンドラとして登録する。

        denpa://play/<base64url>/?title=<base64url>

    ハンドラには %1 でこのリンクがそのまま渡る。mpv は denpa:// も base64 も
    知らないので、間に一枚だけ噛ませて「復号して mpv に渡す」をやる必要がある。
    その一枚はレジストリの値に直接書く。ファイルを置かないので、後から消えたり
    移動したりして壊れることがない。

    mpv-handler のような外部の中継は使わない。mpv を起動するだけなら要らないうえ、
    別途インストールと config.toml が必要になるため。

    登録先は HKCU なので管理者権限は要らない。ログインユーザーにだけ効く。

.PARAMETER MpvPath
    mpv.exe の場所。省略すると PATH と既定の場所から探す。

.PARAMETER Remove
    確認せずに登録を解除する。

.PARAMETER Test
    登録を使って実際に開いてみる。URL を渡すとそれを、省略するとサンプルを開く。

.PARAMETER Show
    登録されている中身をそのまま出す。うまくいかないときの確認用。

.EXAMPLE
    .\denpa.ps1
    .\denpa.ps1 -MpvPath "C:\Program Files\mpv\mpv.exe"
    .\denpa.ps1 -Test https://dp.home.arpa/api/recordings/12/file
    .\denpa.ps1 -Remove
#>

[CmdletBinding()]
param(
    [string] $MpvPath,
    [switch] $Remove,
    [switch] $Show,
    [string] $Test
)

$ErrorActionPreference = 'Stop'

$Root = 'HKCU:\Software\Classes\denpa'
$CommandKey = "$Root\shell\open\command"

function Get-RegisteredCommand {
    if (-not (Test-Path $CommandKey)) { return $null }
    return (Get-ItemProperty -Path $CommandKey -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
}

function Remove-Registration {
    $removed = $false
    # 以前のやり方 (mpv-handler 経由) の登録も一緒に片付ける
    $keys = @(
        $Root,
        'HKCU:\Software\Classes\mpv-handler',
        'HKCU:\Software\Classes\mpv-handler-debug',
        'HKCU:\Software\Classes\mpv'
    )
    foreach ($key in $keys) {
        if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; $removed = $true }
    }
    # 昔の版が起動役を置いていた場所
    $old = Join-Path $env:LOCALAPPDATA 'denpa'
    if (Test-Path $old) { Remove-Item -Path $old -Recurse -Force; $removed = $true }

    if ($removed) { Write-Host '解除しました。' } else { Write-Host '登録されていません。' }
}

function Find-Mpv {
    if ($MpvPath) {
        if (-not (Test-Path $MpvPath)) { throw "指定された場所に見つかりません: $MpvPath" }
        return (Resolve-Path $MpvPath).Path
    }

    # mpv.com はコンソール版。窓が出てしまうので mpv.exe を優先する
    $onPath = Get-Command 'mpv.exe' -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $candidates = @(
        "$env:USERPROFILE\scoop\apps\mpv\current\mpv.exe",
        "$env:LOCALAPPDATA\Programs\mpv\mpv.exe",
        "$env:ProgramFiles\mpv\mpv.exe",
        "${env:ProgramFiles(x86)}\mpv\mpv.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }

    throw @'
mpv.exe が見つかりません。

  https://mpv.io/installation/   (scoop install mpv でも入ります)

置いたうえで、その場所を -MpvPath で指定してください。
'@
}

function ConvertTo-Base64Url([string] $text) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

<#
    レジストリに入れる本体。

    レジストリの値は 1 行なので、ここで組み立てて ; で繋ぐ。
    値全体が二重引用符で囲まれるため、中では**単引用符しか使えない**。
    %1 は Windows がリンクに置き換える。base64url の英数字と -_ しか入らないので、
    単引用符で囲んでおけば中身で壊れることはない。
#>
function Build-Command([string] $mpv) {
    # パスに ' が入っていても壊れないよう、単引用符は倍にして埋める
    $quoted = $mpv.Replace("'", "''")

    $lines = @(
        # 失敗を黙って捨てると「押しても何も起きない」になる。必ず見えるようにする
        "function F(`$m){Add-Type -A System.Windows.Forms;[void][Windows.Forms.MessageBox]::Show(`$m,'denpa');exit 1}"
        # base64url を戻す。パディングを足さないと FromBase64String が受け付けない
        "function D(`$s){`$b=`$s.Replace('-','+').Replace('_','/');`$b=`$b.PadRight([int][math]::Ceiling(`$b.Length/4)*4,'=');[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(`$b))}"
        "`$m=[regex]::Match('%1','^denpa://play/([A-Za-z0-9_-]+)/\?title=([A-Za-z0-9_-]*)`$')"
        "if(!`$m.Success){F('リンクを読めません: %1')}"
        "`$u=D `$m.Groups[1].Value"
        # 外から渡ってくるリンクなので、file:// などをそのまま mpv に食わせない
        "if(`$u -notmatch '^https?://'){F('http(s) 以外は開きません')}"
        "if(!(Test-Path '$quoted')){F('mpv が見つかりません: $quoted')}"
        "try{Start-Process '$quoted' @('--force-media-title='+(D `$m.Groups[2].Value),'--',`$u)}catch{F(`$_.Exception.Message)}"
    )
    return $lines -join ';'
}

# --- 解除 -----------------------------------------------------------------

if ($Remove) {
    Remove-Registration
    return
}

# --- 中身を見る -----------------------------------------------------------

if ($Show) {
    $value = Get-RegisteredCommand
    if ($value) { Write-Host $value } else { Write-Host '登録されていません。' }
    return
}

# --- 動作確認 -------------------------------------------------------------

if ($PSBoundParameters.ContainsKey('Test')) {
    if (-not (Get-RegisteredCommand)) { throw '登録されていません。先に .\denpa.ps1 を実行してください。' }
    $target = if ($Test) { $Test } else { 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4' }
    $link = "denpa://play/$(ConvertTo-Base64Url $target)/?title=$(ConvertTo-Base64Url 'denpa テスト')"
    Write-Host "開くリンク: $link"
    Start-Process $link
    return
}

# --- 登録 -----------------------------------------------------------------

$existing = Get-RegisteredCommand
if ($existing) {
    Write-Host 'denpa:// は既に登録されています。'
    Write-Host "  $existing"
    Write-Host ''
    $answer = Read-Host '解除しますか? [y/N]'
    if ($answer -match '^[yY]') { Remove-Registration }
    else { Write-Host 'そのままにします。入れ直すときは一度解除してください。' }
    return
}

$mpv = Find-Mpv
Write-Host "mpv: $mpv"

New-Item -Path $Root -Force | Out-Null
# URL Protocol が無いと Windows はスキームとして扱わない
Set-ItemProperty -Path $Root -Name '(default)' -Value 'URL:denpa Protocol'
Set-ItemProperty -Path $Root -Name 'URL Protocol' -Value ''

New-Item -Path $CommandKey -Force | Out-Null
# -WindowStyle Hidden で窓を出さない。既定の実行ポリシーは Restricted なので Bypass が要る
$command = '"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "{1}"' `
    -f (Get-Command powershell.exe).Source, (Build-Command $mpv)
Set-ItemProperty -Path $CommandKey -Name '(default)' -Value $command

# 書けたことを読み返して確かめる。黙って失敗すると原因が分からなくなる
if (-not (Get-RegisteredCommand)) { throw '登録に失敗しました。' }

Write-Host '登録しました。'
Write-Host ''
Write-Host '確認は .\denpa.ps1 -Test'
Write-Host '中身は .\denpa.ps1 -Show'
Write-Host '解除は .\denpa.ps1 -Remove'
Write-Host 'mpv を入れ替えたら、一度解除してから入れ直してください。'
