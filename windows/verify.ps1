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
foreach ($name in @('Build-Command', 'ConvertTo-Base64Url')) {
    $found = $ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
    if (-not $found) { throw "$name が見つかりません" }
    Invoke-Expression $found[0].Extent.Text
}

$mpv = 'C:\Program Files\mpv\mpv.exe'
$inner = Build-Command $mpv

# 起動はさせず、mpv に渡る引数だけ見る
function Start-Process { param($p, $ArgumentList) $global:got = @{ path = $p; args = $ArgumentList } }
function Test-Path { param($p) $true }

# --- まともなリンク -------------------------------------------------------

$url = 'http://denpa:p%40ss@dp.home.arpa/api/recordings/12/file'
$title = 'アニメ 青のオーケストラ シーズン2(20)「超える」'
$link = "denpa://play/$(ConvertTo-Base64Url $url)/?title=$(ConvertTo-Base64Url $title)"

$global:got = $null
# Windows が %1 を差し替えるのと同じことをする
Invoke-Expression $inner.Replace('%1', $link)

if (-not $global:got) { throw 'mpv が呼ばれませんでした' }
$joined = $global:got.args -join ' '
Write-Host "mpv:  $($global:got.path)"
Write-Host "引数: $joined"
if ($global:got.path -ne $mpv) { throw 'mpv のパスが違う' }
if ($joined -notlike "*--force-media-title=$title*") { throw 'タイトルを復元できていない' }
if ($joined -notlike "*$url*") { throw 'URLを復元できていない' }
Write-Host '=> 復号して mpv に渡せている'

# --- 通してはいけないリンク -----------------------------------------------

# 失敗すると F がメッセージボックスを出そうとする。Windows 以外では
# そこで落ちるので、mpv まで届かなかったことだけを見る
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
