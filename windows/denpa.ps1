<#
.SYNOPSIS
    denpa の「再生」ボタンから VLC (または mpv) を開けるようにする。

.DESCRIPTION
    denpa:// を Windows のプロトコルハンドラとして登録する。
    あわせて、指定した origin からは確認なしで開けるようブラウザに教える
    (「このサイトは PowerShell を開こうとしています」を毎回出さないため)。

        denpa://play/<base64url>/?title=<base64url>

    ハンドラには %1 でこのリンクがそのまま渡る。VLC も mpv も denpa:// も base64 も
    知らないので、間に一枚だけ噛ませて「復号してプレイヤーに渡す」をやる必要がある。
    その一枚はレジストリの値に直接書く。ファイルを置かないので、後から消えたり
    移動したりして壊れることがない。

    登録先は HKCU なので管理者権限は要らない。ログインユーザーにだけ効く。

.PARAMETER Player
    どのプレイヤーで開くか。vlc (既定) か mpv。

.PARAMETER PlayerPath
    実行ファイルの場所。省略すると PATH と既定の場所から探す。

.PARAMETER NoPlayerConfig
    プレイヤーの設定を触らない。既定では mpv のとき mpv.conf に
    save-position-on-quit=yes を足して、再生速度と再生位置を録画ごとに覚えさせる
    (VLC にはこれに当たる設定が無い)。

.PARAMETER Origins
    確認なしで開くことを許す denpa の origin。既定は dp.home.arpa と dp.doany.io。
    Edge と Chrome のポリシー (AutoLaunchProtocolsFromOrigins) に書く。
    HKCU なので管理者権限は要らないが、書いたあとブラウザの再起動が要る。

.PARAMETER Remove
    確認せずに登録を解除する。

.PARAMETER Test
    登録を使って実際に開いてみる。URL を渡すとそれを、省略するとサンプルを開く。

.PARAMETER Show
    登録されている中身をそのまま出す。うまくいかないときの確認用。

.EXAMPLE
    .\denpa.ps1
    .\denpa.ps1 -Player mpv
    .\denpa.ps1 -PlayerPath "C:\Program Files\VideoLAN\VLC\vlc.exe"
    .\denpa.ps1 -Test https://dp.home.arpa/api/recordings/12/file
    .\denpa.ps1 -Remove
#>

[CmdletBinding()]
param(
    [ValidateSet('vlc', 'mpv')]
    [string] $Player = 'vlc',
    [string] $PlayerPath,
    [string[]] $Origins = @('http://dp.home.arpa', 'https://dp.doany.io'),
    [switch] $NoPlayerConfig,
    [switch] $Remove,
    [switch] $Show,
    [string] $Test
)

$ErrorActionPreference = 'Stop'

$Root = 'HKCU:\Software\Classes\denpa'
$CommandKey = "$Root\shell\open\command"

<#
    ブラウザに「この origin からの denpa:// は確認なしで開いてよい」と教える。

    独自スキームを開くとき、Edge も Chrome も既定で毎回確認を出す。黙らせる方法は
    ポリシー (AutoLaunchProtocolsFromOrigins) しかない。HKCU に書けるので管理者権限は
    要らないが、反映にはブラウザの再起動が要る。
#>
$Policies = @{
    Edge   = 'HKCU:\Software\Policies\Microsoft\Edge'
    Chrome = 'HKCU:\Software\Policies\Google\Chrome'
}
$PolicyName = 'AutoLaunchProtocolsFromOrigins'

function Set-AutoLaunchPolicy([string[]] $origins) {
    # 値は JSON の配列。他のスキームの設定が入っていれば残す
    $entry = [ordered]@{ protocol = 'denpa'; allowed_origins = @($origins) }

    foreach ($browser in $Policies.GetEnumerator()) {
        $path = $browser.Value
        New-Item -Path $path -Force | Out-Null

        $existing = @()
        $current = (Get-ItemProperty -Path $path -Name $PolicyName -ErrorAction SilentlyContinue).$PolicyName
        if ($current) {
            try { $existing = @($current | ConvertFrom-Json) | Where-Object { $_.protocol -ne 'denpa' } }
            catch { $existing = @() }
        }

        # 1件だけだと ConvertTo-Json が配列にしてくれない
        $value = ConvertTo-Json -InputObject (@($existing) + $entry) -Depth 5 -Compress
        if ($value -notmatch '^\[') { $value = "[$value]" }
        Set-ItemProperty -Path $path -Name $PolicyName -Value $value
        Write-Host "$($browser.Key): $value"
    }
}

function Remove-AutoLaunchPolicy {
    foreach ($browser in $Policies.GetEnumerator()) {
        $path = $browser.Value
        $current = (Get-ItemProperty -Path $path -Name $PolicyName -ErrorAction SilentlyContinue).$PolicyName
        if (-not $current) { continue }
        $rest = @()
        try { $rest = @($current | ConvertFrom-Json) | Where-Object { $_.protocol -ne 'denpa' } } catch { }
        if ($rest.Count -eq 0) { Remove-ItemProperty -Path $path -Name $PolicyName -ErrorAction SilentlyContinue }
        else {
            $value = ConvertTo-Json -InputObject @($rest) -Depth 5 -Compress
            if ($value -notmatch '^\[') { $value = "[$value]" }
            Set-ItemProperty -Path $path -Name $PolicyName -Value $value
        }
    }
}

<#
    再生速度と再生位置を録画ごとに覚えさせる。

    mpv は終了時の状態を watch-later として URL ごとに残せる。速度は
    watch-later-options の既定に入っているので、この1行だけで足りる。
    denpa が渡す URL は録画ごとに変わらないので、続きから同じ速度で開き直せる。
#>
function Add-MpvConfig {
    $dir = Join-Path $env:APPDATA 'mpv'
    $file = Join-Path $dir 'mpv.conf'
    $line = 'save-position-on-quit=yes'

    if (Test-Path $file) {
        # 既に書いてあれば触らない。コメントアウトされている行は数えない
        $found = Select-String -Path $file -Pattern '^\s*save-position-on-quit' -Quiet
        if ($found) { Write-Host "mpv.conf: 設定済み ($file)"; return }
        Add-Content -Path $file -Value $line -Encoding UTF8
    }
    else {
        New-Item -Path $dir -ItemType Directory -Force | Out-Null
        Set-Content -Path $file -Value $line -Encoding UTF8
    }
    Write-Host "mpv.conf: $line を足しました ($file)"
}

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

    Remove-AutoLaunchPolicy

    if ($removed) { Write-Host '解除しました。' } else { Write-Host '登録されていません。' }
}

$PlayerFiles = @{ vlc = 'vlc.exe'; mpv = 'mpv.exe' }

function Find-Player {
    $exe = $PlayerFiles[$Player]

    if ($PlayerPath) {
        if (-not (Test-Path $PlayerPath)) { throw "指定された場所に見つかりません: $PlayerPath" }
        return (Resolve-Path $PlayerPath).Path
    }

    $onPath = Get-Command $exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    # 配布元によって置き場所も名前も揺れる。よくあるところを順に見る。
    # mpv.com はコンソール版で窓が出るので、探すのは mpv.exe だけ
    $candidates = if ($Player -eq 'vlc') {
        @(
            "$env:ProgramFiles\VideoLAN\VLC\vlc.exe",
            "${env:ProgramFiles(x86)}\VideoLAN\VLC\vlc.exe",
            "$env:USERPROFILE\scoop\apps\vlc\current\vlc.exe"
        )
    }
    else {
        @(
            "$env:ProgramFiles\MPV Player\mpv.exe",
            "$env:LOCALAPPDATA\Microsoft\WinGet\Links\mpv.exe",
            "$env:USERPROFILE\scoop\apps\mpv\current\mpv.exe",
            "$env:LOCALAPPDATA\Programs\mpv\mpv.exe",
            "$env:ProgramFiles\mpv\mpv.exe",
            "${env:ProgramFiles(x86)}\mpv\mpv.exe"
        )
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }

    # それでも見つからなければ、よく置く場所を少しだけ掘る
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs")) {
        if (-not $base -or -not (Test-Path $base)) { continue }
        $hit = Get-ChildItem -Path $base -Filter $exe -Recurse -Depth 2 -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }

    throw @"
$exe が見つかりません。

  VLC: https://www.videolan.org/vlc/
  mpv: https://mpv.io/installation/

入れたうえで、その場所を -PlayerPath で指定してください。
"@
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
function Build-Command([string] $exe) {
    # パスに ' が入っていても壊れないよう、単引用符は倍にして埋める
    $quoted = $exe.Replace("'", "''")

    # 番組名の渡し方はプレイヤーで違う。
    # 連結は必ず括弧でくくる。@('a','b'+$t) は「配列に $t を足す」と解釈され、
    # 'b'+$t の連結にならない (, は + より結合が弱い)
    $playerArgs = if ($Player -eq 'vlc') {
        "@('--no-video-title-show',('--meta-title='+`$t),`$u)"
    }
    else {
        "@(('--force-media-title='+`$t),'--',`$u)"
    }

    $lines = @(
        # 失敗を黙って捨てると「押しても何も起きない」になる。必ず見えるようにする
        "function F(`$m){Add-Type -A System.Windows.Forms;[void][Windows.Forms.MessageBox]::Show(`$m,'denpa');exit 1}"
        # base64url を戻す。パディングを足さないと FromBase64String が受け付けない
        "function D(`$s){`$b=`$s.Replace('-','+').Replace('_','/');`$b=`$b.PadRight([int][math]::Ceiling(`$b.Length/4)*4,'=');[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(`$b))}"
        "`$m=[regex]::Match('%1','^denpa://play/([A-Za-z0-9_-]+)/\?title=([A-Za-z0-9_-]*)`$')"
        "if(!`$m.Success){F('リンクを読めません: %1')}"
        "`$u=D `$m.Groups[1].Value"
        # 外から渡ってくるリンクなので、file:// などをそのまま食わせない
        "if(`$u -notmatch '^https?://'){F('http(s) 以外は開きません')}"
        "`$t=D `$m.Groups[2].Value"
        "if(!(Test-Path '$quoted')){F('プレイヤーが見つかりません: $quoted')}"
        "try{Start-Process '$quoted' $playerArgs}catch{F(`$_.Exception.Message)}"
    )
    return $lines -join ';'
}

$PlayerFiles = @{ vlc = 'vlc.exe'; mpv = 'mpv.exe' }

function Find-Player {
    $exe = $PlayerFiles[$Player]

    if ($PlayerPath) {
        if (-not (Test-Path $PlayerPath)) { throw "指定された場所に見つかりません: $PlayerPath" }
        return (Resolve-Path $PlayerPath).Path
    }

    $onPath = Get-Command $exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    # 配布元によって置き場所も名前も揺れる。よくあるところを順に見る。
    # mpv.com はコンソール版で窓が出るので、探すのは mpv.exe だけ
    $candidates = if ($Player -eq 'vlc') {
        @(
            "$env:ProgramFiles\VideoLAN\VLC\vlc.exe",
            "${env:ProgramFiles(x86)}\VideoLAN\VLC\vlc.exe",
            "$env:USERPROFILE\scoop\apps\vlc\current\vlc.exe"
        )
    }
    else {
        @(
            "$env:ProgramFiles\MPV Player\mpv.exe",
            "$env:LOCALAPPDATA\Microsoft\WinGet\Links\mpv.exe",
            "$env:USERPROFILE\scoop\apps\mpv\current\mpv.exe",
            "$env:LOCALAPPDATA\Programs\mpv\mpv.exe",
            "$env:ProgramFiles\mpv\mpv.exe",
            "${env:ProgramFiles(x86)}\mpv\mpv.exe"
        )
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }

    # それでも見つからなければ、よく置く場所を少しだけ掘る
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs")) {
        if (-not $base -or -not (Test-Path $base)) { continue }
        $hit = Get-ChildItem -Path $base -Filter $exe -Recurse -Depth 2 -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }

    throw @"
$exe が見つかりません。

  VLC: https://www.videolan.org/vlc/
  mpv: https://mpv.io/installation/

入れたうえで、その場所を -PlayerPath で指定してください。
"@
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
    foreach ($browser in $Policies.GetEnumerator()) {
        $policy = (Get-ItemProperty -Path $browser.Value -Name $PolicyName -ErrorAction SilentlyContinue).$PolicyName
        Write-Host "$($browser.Key): $(if ($policy) { $policy } else { '(ポリシー未設定)' })"
    }
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

# ブラウザのポリシーと mpv.conf は何度書いても同じなので、
# スキームが登録済みでも必ず通す。ここを飛ばすと、入れ直すまで確認が出続ける
Set-AutoLaunchPolicy $Origins
if (-not $NoPlayerConfig -and $Player -eq 'mpv') { Add-MpvConfig }

$existing = Get-RegisteredCommand
if ($existing) {
    Write-Host ''
    Write-Host 'denpa:// は既に登録されています。'
    Write-Host "  $existing"
    Write-Host ''
    Write-Host '確認を出さずに開くには、ブラウザを一度終了してから開き直してください。'
    Write-Host ''
    $answer = Read-Host '登録し直しますか? (解除します) [y/N]'
    if ($answer -match '^[yY]') { Remove-Registration }
    else { Write-Host 'そのままにします。' }
    return
}

$exe = Find-Player
Write-Host "$($Player): $exe"

New-Item -Path $Root -Force | Out-Null
# URL Protocol が無いと Windows はスキームとして扱わない
Set-ItemProperty -Path $Root -Name '(default)' -Value 'URL:denpa Protocol'
Set-ItemProperty -Path $Root -Name 'URL Protocol' -Value ''

New-Item -Path $CommandKey -Force | Out-Null
# -WindowStyle Hidden で窓を出さない。既定の実行ポリシーは Restricted なので Bypass が要る
$command = '"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "{1}"' `
    -f (Get-Command powershell.exe).Source, (Build-Command $exe)
Set-ItemProperty -Path $CommandKey -Name '(default)' -Value $command

# 書けたことを読み返して確かめる。黙って失敗すると原因が分からなくなる
if (-not (Get-RegisteredCommand)) { throw '登録に失敗しました。' }

Write-Host ''
Write-Host '登録しました。'
Write-Host '確認を出さずに開くには、ブラウザを一度終了してから開き直してください。'
Write-Host "許可した origin: $($Origins -join ', ')"
Write-Host '(違う場所から開くなら -Origins で渡してください)'
if ($Player -eq 'mpv') {
    Write-Host '再生速度と再生位置は録画ごとに覚えます (触らせないなら -NoPlayerConfig)'
}
Write-Host ''
Write-Host '確認は .\denpa.ps1 -Test'
Write-Host '中身は .\denpa.ps1 -Show'
Write-Host '解除は .\denpa.ps1 -Remove'
Write-Host 'プレイヤーを変えるときは、一度解除してから入れ直してください。'
