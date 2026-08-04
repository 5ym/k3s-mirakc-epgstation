using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>子プロセスを最後まで回して、出力をまとめて受け取る</summary>
public static class Shell
{
    public static async Task<(int Code, string Output)> Run(
        string file, IEnumerable<string> args, TimeSpan? timeout = null)
    {
        try
        {
            var start = new ProcessStartInfo(file)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var arg in args) start.ArgumentList.Add(arg);

            using var child = Process.Start(start)!;
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            using var limit = new CancellationTokenSource(timeout ?? TimeSpan.FromMinutes(30));
            try
            {
                await child.WaitForExitAsync(limit.Token);
            }
            catch (OperationCanceledException)
            {
                child.Kill(entireProcessTree: true);
            }
            return (child.ExitCode, $"{await stdout}{await stderr}".Trim());
        }
        catch (Exception error)
        {
            return (-1, error.Message);
        }
    }
}

/// <summary>
/// カードリーダーが見えているか。
///
/// <para>
/// pcscd が動いていてもリーダーを掴めていないことがある (USBが黙る)。そうなると
/// recisdb は黙って復号せずに素通しし、録画は成功したように見えて中身が全部
/// スクランブルされたまま、という分かりにくい壊れ方をする。
/// </para>
/// </summary>
public static class Card
{
    /// <summary>
    /// pcscd が居なければ起こす。**起こせなくても止まらない。**
    ///
    /// <para>
    /// カードが読めなくても番組表もロゴも集まるし、掛かったままでも録っておく
    /// ほうが録らないよりまし。ここで落ちると「カードリーダーが無いから1本も
    /// 録れない」になる。
    /// </para>
    /// </summary>
    public static async Task EnsurePcscd()
    {
        if ((await Shell.Run("pgrep", ["-x", "pcscd"], TimeSpan.FromSeconds(10))).Code == 0) return;
        try
        {
            Process.Start(new ProcessStartInfo("pcscd", "--foreground --disable-polkit")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            Log.Write("pcscd を起動しました");
        }
        catch (Exception error)
        {
            Log.Write($"pcscd を起こせません (カードが要る録画は解除に失敗します): {error.Message}");
        }
    }

    public static async Task<JsonObject> Status()
    {
        var pcscd = (await Shell.Run("pgrep", ["-x", "pcscd"], TimeSpan.FromSeconds(10))).Code == 0;
        var scan = await Shell.Run("pcsc_scan", ["-r"], TimeSpan.FromSeconds(15));

        // 「0: Reader name」の形で並ぶ
        var readers = new JsonArray();
        foreach (var line in scan.Output.Split('\n'))
        {
            var trimmed = line.Trim();
            var colon = trimmed.IndexOf(':');
            if (colon <= 0 || !trimmed[..colon].All(char.IsDigit)) continue;
            readers.Add((JsonNode?)JsonValue.Create(trimmed[(colon + 1)..].Trim()));
        }

        var message = !pcscd
            ? "pcscd が動いていません"
            : readers.Count > 0
                ? $"カードリーダーが見えています ({readers.Count} 台)"
                : "pcscd は動いていますが、カードリーダーが見つかりません";

        return new JsonObject
        {
            ["ok"] = pcscd && readers.Count > 0,
            ["pcscd"] = pcscd,
            ["readers"] = readers,
            ["message"] = message,
        };
    }
}

/// <summary>
/// 掛かったまま録れたTSを解く。
///
/// <para>
/// recisdb はカードが読めないとき「黙って素通しする」ので、終了コードだけでは
/// 成否が分からない。出来上がったものを見て判断するのは呼び出し側 (denpa)。
/// </para>
/// </summary>
public static class Scramble
{
    /// <summary>置き場の中に収まるパスだけ受け付ける。外を読み書きさせない</summary>
    private static string? Inside(string root, string? name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        var full = Path.GetFullPath(Path.Combine(root, name));
        return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) ? full : null;
    }

    public static async Task<JsonObject> Decode(string recisdb, string recorded, string? input, string? output)
    {
        var source = Inside(recorded, input);
        var target = Inside(recorded, output);
        if (source is null || target is null)
        {
            return new JsonObject { ["ok"] = false, ["error"] = "生TSの置き場の外は解除に回せません" };
        }
        if (!File.Exists(source))
        {
            return new JsonObject
            {
                ["ok"] = false,
                ["error"] = $"{source} が見えません。denpa と同じ置き場をこのコンテナにも見せてください",
            };
        }

        var (code, log) = await Shell.Run(recisdb, ["decode", "-i", source, target]);
        if (code != 0)
        {
            return new JsonObject { ["ok"] = false, ["error"] = $"recisdb が {code} で終了しました\n{log}" };
        }
        return new JsonObject { ["ok"] = true, ["error"] = "" };
    }
}
