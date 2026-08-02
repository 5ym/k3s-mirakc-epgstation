<#
.SYNOPSIS
    denpa の「再生」ボタンから VLC を開けるようにする。

.DESCRIPTION
    denpa:// を Windows のプロトコルハンドラとして登録する。

    初めて再生ボタンを押すとブラウザが確認を出すので、そこで
    **「常に許可」にチェックを入れて**開く。以後は出ない。
    ブラウザが覚えるので、こちらから何かを書く必要はない。

        denpa://play/<base64url>/?title=<base64url>

    ハンドラには %1 でこのリンクがそのまま渡る。VLC は denpa:// も base64 も
    知らないので、間に一枚だけ噛ませて「復号して VLC に渡す」をやる必要がある。
    その一枚はレジストリの値に直接書く。ファイルを置かないので、後から消えたり
    移動したりして壊れることがない。

    登録先は HKCU なので管理者権限は要らない。ログインユーザーにだけ効く。

    **ブラウザのポリシーは書かない。** 以前は確認そのものを出さないよう
    AutoLaunchProtocolsFromOrigins を書く -Policy を持っていたが、denpa は
    https で開くようになったので、確認に「常に許可」のチェックが必ず出る
    (このチェックは https のページからしか出ない)。1回入れれば以後は出ないので、
    管理者権限とブラウザの再起動を要求してまで書く理由が無くなった。

.PARAMETER PlayerPath
    vlc.exe の場所。省略すると PATH と既定の場所から探す。

.PARAMETER NoPause
    終わったあとに Enter を待たない。自動実行やパイプから使うとき用。

.PARAMETER Remove
    確認せずに登録を解除する。

.PARAMETER Test
    登録を使って実際に開いてみる。URL を渡すとそれを、省略するとサンプルを開く。

.PARAMETER Show
    登録されている中身をそのまま出す。うまくいかないときの確認用。

.EXAMPLE
    .\denpa.ps1
    .\denpa.ps1 -PlayerPath "C:\Program Files\VideoLAN\VLC\vlc.exe"
    .\denpa.ps1 -Test https://dp.l.doany.io/api/recordings/12/file
    .\denpa.ps1 -Remove

.EXAMPLE
    # 落としてそのまま実行する (README のワンライナー)
    $s="$env:TEMP\denpa.ps1"; irm https://raw.githubusercontent.com/DAnything/denpa/main/windows/denpa.ps1 -OutFile $s; & $s
#>

[CmdletBinding()]
param(
    [string] $PlayerPath,
    [switch] $NoPause,
    [switch] $Remove,
    [switch] $Show,
    [string] $Test
)

$ErrorActionPreference = 'Stop'

<#
    終わったあとに Enter を待つ。

    右クリックの「PowerShell で実行」やショートカットから起動すると、
    終わった瞬間に窓が閉じて何が出ていたのか読めない。読ませてから閉じる。
    パイプや自動実行では止まると帰ってこないので、対話できるときだけ待つ。
#>
function Wait-Enter {
    if ($NoPause) { return }
    if (-not [Environment]::UserInteractive) { return }
    if ($Host.Name -ne 'ConsoleHost') { return }
    Write-Host ''
    $null = Read-Host 'Enter で閉じます'
}

# 失敗しても同じこと。エラーだけ出して窓が消えるのが一番困る
trap {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    Wait-Enter
    exit 1
}

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

$PlayerFile = 'vlc.exe'

function Find-Player {
    if ($PlayerPath) {
        if (-not (Test-Path $PlayerPath)) { throw "指定された場所に見つかりません: $PlayerPath" }
        return (Resolve-Path $PlayerPath).Path
    }

    $onPath = Get-Command $PlayerFile -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    # 配布元によって置き場所が揺れる。よくあるところを順に見る
    $candidates = @(
        "$env:ProgramFiles\VideoLAN\VLC\vlc.exe",
        "${env:ProgramFiles(x86)}\VideoLAN\VLC\vlc.exe",
        "$env:USERPROFILE\scoop\apps\vlc\current\vlc.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }

    # それでも見つからなければ、よく置く場所を少しだけ掘る
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs")) {
        if (-not $base -or -not (Test-Path $base)) { continue }
        $hit = Get-ChildItem -Path $base -Filter $PlayerFile -Recurse -Depth 2 -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }

    throw @"
$PlayerFile が見つかりません。

  VLC: https://www.videolan.org/vlc/

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
    %1 は Windows がリンクに置き換える。base64url の英数字と -_ しか入らないので、
    単引用符で囲んでおけば中身で壊れることはない。

    **この中に二重引用符を1つも書かないこと。** 出来上がりは

        "powershell.exe" ... -Command "<ここで組み立てたもの>"

    という1本のコマンドラインになる。中に " があると、Windows の引数分解
    (CommandLineToArgvW) がそこで -Command の値を打ち切ってしまい、script が
    3つの引数に割れて " も消える。VLC に渡す番組名がくくられなくなり、
    空白で分かれて「開けません」になる。二重引用符が要るところは $q ([char]34)
    を連結して作る。windows/verify.ps1 がこの分解まで含めて確かめている。
#>
function Build-Command([string] $exe) {
    # パスに ' が入っていても壊れないよう、単引用符は倍にして埋める
    $quoted = $exe.Replace("'", "''")

    # 連結は必ず括弧でくくる。@('a','b'+$t) は「配列に $t を足す」と解釈され、
    # 'b'+$t の連結にならない (, は + より結合が弱い)。
    #
    # 値は $q でくくる。Start-Process は引数を空白で繋いだ1本のコマンドラインとして
    # 渡すので、くくらないと**番組名の空白で分かれ**、後ろがもう1つの入力として
    # VLC に渡って「開けません」になる
    $playerArgs = "@('--no-video-title-show',('--meta-title='+`$q+`$t+`$q),(`$q+`$u+`$q))"

    $lines = @(
        # 二重引用符はここから作る (上の注意書き参照)。
        # [char] のままだと .Replace($q,'') が Replace(char,char) に解決されて
        # 空文字を char に変換できずに落ちるので、文字列にしておく
        "`$q=[string][char]34"
        # 失敗を黙って捨てると「押しても何も起きない」になる。必ず見えるようにする
        "function F(`$m){Add-Type -A System.Windows.Forms;[void][Windows.Forms.MessageBox]::Show(`$m,'denpa');exit 1}"
        # base64url を戻す。パディングを足さないと FromBase64String が受け付けない
        "function D(`$s){`$b=`$s.Replace('-','+').Replace('_','/');`$b=`$b.PadRight([int][math]::Ceiling(`$b.Length/4)*4,'=');[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(`$b))}"
        "`$m=[regex]::Match('%1','^denpa://play/([A-Za-z0-9_-]+)/\?title=([A-Za-z0-9_-]*)`$')"
        "if(!`$m.Success){F('リンクを読めません: %1')}"
        "`$u=D `$m.Groups[1].Value"
        # 外から渡ってくるリンクなので、file:// などをそのまま食わせない
        "if(`$u -notmatch '^https?://'){F('http(s) 以外は開きません')}"
        # 番組名の " は引用をこわすので落とす。EPG の記号は当てにできない
        "`$t=(D `$m.Groups[2].Value).Replace(`$q,'')"
        "if(!(Test-Path '$quoted')){F('プレイヤーが見つかりません: $quoted')}"
        "try{Start-Process '$quoted' $playerArgs}catch{F(`$_.Exception.Message)}"
    )
    return $lines -join ';'
}

<#
    レジストリに実際に書く1行。組み立てを1か所にまとめて、verify.ps1 からも
    同じものを確かめられるようにしてある。
#>
function Build-RegistryCommand([string] $exe, [string] $powershell, [string] $conhost) {
    <#
        conhost.exe を頭に噛ませる。

        Windows 11 の既定の端末は Windows Terminal で、コンソールを持つプログラムを
        起動すると**まず Terminal が立ち上がってから**中身が動く。この立ち上がりが
        再生ボタンを押してから VLC が出るまでの間になる (EPGStation の頃は素の cmd
        だったので速かった、というのはこの差)。しかも Terminal は
        -WindowStyle Hidden を無視するので、一瞬窓も出る。

        conhost.exe を明示すると昔のコンソールホストで動くので、Terminal の
        立ち上がりが丸ごと無くなり、Hidden も効く。
        残るのは PowerShell 自身の起動 (0.3 秒ほど) だけ。

        既定の実行ポリシーは Restricted なので Bypass が要る。
    #>
    return '"{0}" "{1}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "{2}"' `
        -f $conhost, $powershell, (Build-Command $exe)
}


# --- 解除 -----------------------------------------------------------------

if ($Remove) {
    Remove-Registration
    Wait-Enter
    return
}

# --- 中身を見る -----------------------------------------------------------

if ($Show) {
    $value = Get-RegisteredCommand
    if ($value) { Write-Host $value } else { Write-Host '登録されていません。' }
    Wait-Enter
    return
}

# --- 動作確認 -------------------------------------------------------------

if ($PSBoundParameters.ContainsKey('Test')) {
    if (-not (Get-RegisteredCommand)) { throw '登録されていません。先に .\denpa.ps1 を実行してください。' }
    $target = if ($Test) { $Test } else { 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4' }
    $link = "denpa://play/$(ConvertTo-Base64Url $target)/?title=$(ConvertTo-Base64Url 'denpa テスト')"
    Write-Host "開くリンク: $link"
    Start-Process $link
    Wait-Enter
    return
}

# --- 登録 -----------------------------------------------------------------

<#
    入っていたら黙って入れ直す。

    以前はここで「登録し直しますか?」と聞いて、はいと答えると解除して**終わって**
    いた。入れ直したつもりが外れているうえ、消しているだけなのに
    「確認を出さずに開くには…」という案内まで出ていた。
    もう一度実行するのは新しくするためなので、そのまま最後まで通す。
#>
$existing = Get-RegisteredCommand
if ($existing) {
    Write-Host '既に登録されているので、入れ直します。'
    Write-Host "  $existing"
    Remove-Registration
}

$exe = Find-Player
Write-Host "VLC: $exe"

New-Item -Path $Root -Force | Out-Null
# URL Protocol が無いと Windows はスキームとして扱わない
Set-ItemProperty -Path $Root -Name '(default)' -Value 'URL:denpa Protocol'
Set-ItemProperty -Path $Root -Name 'URL Protocol' -Value ''

New-Item -Path $CommandKey -Force | Out-Null
$conhost = (Get-Command conhost.exe -ErrorAction SilentlyContinue).Source
if (-not $conhost) { $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe' }
$command = Build-RegistryCommand $exe (Get-Command powershell.exe).Source $conhost
Set-ItemProperty -Path $CommandKey -Name '(default)' -Value $command

# 書けたことを読み返して確かめる。黙って失敗すると原因が分からなくなる
if (-not (Get-RegisteredCommand)) { throw '登録に失敗しました。' }

Write-Host ''
Write-Host '登録しました。'
Write-Host ''
Write-Host '初めて再生を押すと、ブラウザが「開きますか?」と聞いてきます。'
Write-Host '  そこで「常に許可」にチェックを入れて開いてください。以後は聞かれません。'
Write-Host ''
Write-Host '確認は .\denpa.ps1 -Test'
Write-Host '中身は .\denpa.ps1 -Show'
Write-Host '解除は .\denpa.ps1 -Remove'
Wait-Enter
