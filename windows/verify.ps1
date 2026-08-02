<#
    denpa.ps1 がレジストリに書く一行を、実際に走らせて確かめる。

    あの一行はレジストリの値なので、壊れていても Windows は黙って何もしない。
    「押しても何も起きない」が一番わかりにくい壊れ方なので、ここで先に見ておく。

    Windows でなくても走る (レジストリには触らない)。

        docker run --rm -v "$PWD:/w:ro" mcr.microsoft.com/powershell:latest \
            pwsh -NoProfile -File /w/verify.ps1
#>

$ErrorActionPreference = 'Stop'

$target = Join-Path $PSScriptRoot 'denpa.ps1'

# 構文が通ること。ここで落ちるなら BOM か改行を疑う (.gitattributes 参照)
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$null, [ref]$errors)
if ($errors) {
    $errors | ForEach-Object { Write-Host "行 $($_.Extent.StartLineNumber): $($_.Message)" }
    throw '構文エラー'
}
Write-Host '構文エラーなし'

# 中の関数だけ取り出して使う。denpa.ps1 をそのまま実行するとレジストリを触るため
$ast = [System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$null, [ref]$null)
foreach ($name in @('Build-Command', 'Build-RegistryCommand', 'ConvertTo-Base64Url')) {
    $found = $ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
    if (-not $found) { throw "$name が見つかりません" }
    # 同じ名前が2つあると、PowerShell は後の定義を使う。ここで先頭だけ見ていると
    # 「検証は通るのに実際には古い定義が動く」という一番わかりにくい壊れ方をする
    if ($found.Count -ne 1) { throw "$name が $($found.Count) 個あります" }
    Invoke-Expression $found[0].Extent.Text
}

$exe = 'C:\Program Files\VideoLAN\VLC\vlc.exe'
$inner = Build-Command $exe

<#
    レジストリの1行が Windows にどう分解されるか。

    値は `"powershell.exe" ... -Command "<script>"` という**1本のコマンドライン**で、
    Windows は CommandLineToArgvW の規則で引数に割る。script の中に二重引用符が
    1つでもあると、そこで -Command の値が打ち切られて script が複数の引数に割れ、
    " も消える。**PowerShell は残りを空白で繋いで実行してしまう**ので、
    構文エラーにもならずに「番組名がくくられていない」状態だけが残る。

    実際にこれで VLC が開けなくなっていたのに、ここが script を直接
    Invoke-Expression するだけだったので素通ししていた。分解まで真似て確かめる。
#>
function Split-CommandLine([string] $line) {
    $args_ = New-Object System.Collections.Generic.List[string]
    $current = New-Object System.Text.StringBuilder
    $inQuotes = $false
    $started = $false
    $i = 0
    while ($i -lt $line.Length) {
        $c = $line[$i]
        if ($c -eq '\') {
            $slashes = 0
            while ($i -lt $line.Length -and $line[$i] -eq '\') { $slashes++; $i++ }
            if ($i -lt $line.Length -and $line[$i] -eq '"') {
                [void]$current.Append('\' * [int]($slashes / 2))
                if ($slashes % 2 -eq 1) { [void]$current.Append('"'); $i++ }
                else { $inQuotes = -not $inQuotes; $started = $true; $i++ }
            }
            else { [void]$current.Append('\' * $slashes) }
            continue
        }
        if ($c -eq '"') { $inQuotes = -not $inQuotes; $started = $true; $i++; continue }
        if (($c -eq ' ' -or $c -eq "`t") -and -not $inQuotes) {
            if ($current.Length -gt 0 -or $started) { $args_.Add($current.ToString()); [void]$current.Clear(); $started = $false }
            $i++
            continue
        }
        [void]$current.Append($c); $i++
    }
    if ($current.Length -gt 0 -or $started) { $args_.Add($current.ToString()) }
    return $args_
}

$conhost = 'C:\Windows\System32\conhost.exe'
$powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$registry = Build-RegistryCommand $exe $powershell $conhost
$parts = Split-CommandLine $registry

# 頭は conhost。Windows Terminal を経由させないためにここに居る (立ち上がりが遅く、
# -WindowStyle Hidden も無視されるため)。順番が入れ替わると素通しで遅いままになる
if ($parts[0] -ne $conhost) { throw "先頭が conhost ではない: $($parts[0])" }
if ($parts[1] -ne $powershell) { throw "conhost の次が powershell ではない: $($parts[1])" }

$commandAt = $parts.IndexOf('-Command')
if ($commandAt -lt 0) { throw '-Command が渡っていない' }
if ($parts.Count - $commandAt - 1 -ne 1) {
    throw "-Command の値が $($parts.Count - $commandAt - 1) 個に割れている (中の二重引用符を疑う)"
}
if ($parts[$commandAt + 1] -ne $inner) { throw '-Command の値が欠けている' }
Write-Host '=> レジストリの1行が Windows の引数分解を通っても欠けない'

# 起動はさせず、VLC に渡る引数だけ見る
function Start-Process { param($p, $ArgumentList) $global:got = @{ path = $p; args = $ArgumentList } }
function Test-Path { param($p) $true }

# --- まともなリンク -------------------------------------------------------

$url = 'https://denpa:p%40ss@dp.l.doany.io/api/recordings/12/file'
$title = 'アニメ 青のオーケストラ シーズン2(20)「超える」'
$link = "denpa://play/$(ConvertTo-Base64Url $url)/?title=$(ConvertTo-Base64Url $title)"

$global:got = $null
# Windows が %1 を差し替えるのと同じことをする
Invoke-Expression $inner.Replace('%1', $link)

if (-not $global:got) { throw 'VLC が呼ばれませんでした' }
$joined = $global:got.args -join ' '
Write-Host "VLC:  $($global:got.path)"
Write-Host "引数: $joined"
if ($global:got.path -ne $exe) { throw 'プレイヤーのパスが違う' }
# 番組名は空白を含む。1つの引数として渡らないと、後ろがもう1つの入力になって
# プレイヤーが「開けません」と言う
$titleArg = @($global:got.args | Where-Object { $_ -like '*meta-title*' })
if ($titleArg.Count -ne 1) { throw 'タイトルが1つの引数になっていない' }
if ($titleArg[0] -ne "--meta-title=`"$title`"") { throw "タイトルがくくられていない: $($titleArg[0])" }
if ($joined -notlike "*$url*") { throw 'URLを復元できていない' }
Write-Host '=> 復号して VLC に渡せている'

# --- 通してはいけないリンク -----------------------------------------------

# 失敗すると F がメッセージボックスを出そうとする。Windows 以外では
# そこで落ちるので、VLC まで届かなかったことだけを見る
$bad = @{
    'base64 が壊れている'    = 'denpa://play/!!!!/?title='
    'http(s) ではない'       = "denpa://play/$(ConvertTo-Base64Url 'file:///etc/passwd')/?title="
    '形が違う'               = 'denpa://open/aaaa/'
}
foreach ($case in $bad.GetEnumerator()) {
    $global:got = $null
    try { Invoke-Expression $inner.Replace('%1', $case.Value) } catch { }
    if ($global:got) { throw "通してはいけないものが通った: $($case.Key)" }
    Write-Host "弾いた: $($case.Key)"
}

Write-Host ''
Write-Host 'すべて通りました。'
