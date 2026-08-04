using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>繋いである機材1本ぶん。<c>tuners.yml</c> にそのまま対応する</summary>
public sealed record TunerSpec(string Name, string[] Types, string Command, bool Disabled);

/// <summary>
/// 設定ファイル2つ。
///
/// <list type="bullet">
/// <item><c>tuners.yml</c> … 繋いである機材。**人が書き、こちらは読むだけ**</item>
/// <item><c>channels.json</c> … スキャンで分かったこと。**denpa が預けてくる**</item>
/// </list>
///
/// <para>
/// 中身を作るのはこちらではない。総当たりの選局こそ頼まれるが、NIT も SDT も
/// 解かないので「何が居たか」は分からない。読むのは denpa。それでも控えを
/// 持つのはこちら側にする — アンテナに何が映るかは機材ごとの話だから。
/// </para>
/// </summary>
public sealed class Config(string tunersFile, string channelsFile)
{
    public string TunersFile { get; } = tunersFile;
    public string ChannelsFile { get; } = channelsFile;

    public static Config FromEnvironment() => new(
        Environment.GetEnvironmentVariable("TUNERS_FILE") ?? "/app-config/tuners.yml",
        Environment.GetEnvironmentVariable("CHANNELS_FILE") ?? "/app-config/channels.json");

    /// <summary>
    /// 初回だけ雛形を置く。
    ///
    /// <para>
    /// 設定は PVC に置いてあるので、像を入れ替えても手で書いたものは残る。
    /// 像側のものを直に読ませると、**編集できない設定**になってしまう。
    /// </para>
    /// </summary>
    public void InstallTemplate(string template)
    {
        if (File.Exists(TunersFile) || !File.Exists(template)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(TunersFile)!);
        File.Copy(template, TunersFile);
        Log.Write($"チューナーの雛形を置きました: {TunersFile}");
    }

    /// <summary>
    /// 繋いである機材。**ここは読むだけ。**
    ///
    /// <para>
    /// ファイルが無ければ空を返す — チューナーが1本も無いことは異常だが、
    /// 起動できないよりは画面に「チューナーがありません」と出したほうがいい。
    /// </para>
    /// </summary>
    public List<TunerSpec> LoadTuners()
    {
        if (!File.Exists(TunersFile)) return [];
        try
        {
            return [.. Yaml.ReadSequence(File.ReadAllText(TunersFile), "tuners").Select(item =>
            {
                var name = item.Scalars.GetValueOrDefault("name") ?? "";
                var command = item.Scalars.GetValueOrDefault("command") ?? "";
                var types = item.Lists.GetValueOrDefault("types") ?? [];
                var disabled = item.Scalars.GetValueOrDefault("disabled") is "true" or "yes";
                return new TunerSpec(name, [.. types], command, disabled);
            })];
        }
        catch (Exception error)
        {
            Log.Write($"{TunersFile} を読めません: {error.Message}");
            return [];
        }
    }

    /// <summary>
    /// 機材を決める。**書いてあればそれ、無ければ自分で見つける。**
    ///
    /// <para>
    /// 自動で分かるのは「刺さっているデバイスと、それが受けられる方式」だけ。
    /// 選局コマンドを変えたい・LNB を足したい・1本だけ止めたい・別PCのぶんを
    /// 混ぜたい、はどれも人にしか決められないので、そのときは書いてもらう。
    /// </para>
    /// </summary>
    public List<TunerSpec> ResolveTuners()
    {
        var written = LoadTuners();
        if (written.Count > 0) return written;

        var found = DeviceProbe.Detect();
        if (found.Count == 0)
        {
            Log.Write($"チューナーが見つかりません ({TunersFile} に書けば、そちらを使います)");
            return found;
        }
        Log.Write($"{TunersFile} に定義が無いので、刺さっている機材を使います:");
        foreach (var tuner in found) Log.Write($"  {tuner.Name} [{string.Join(", ", tuner.Types)}]");
        return found;
    }

    /// <summary>並べ替えの順。知らない種別は後ろに送る</summary>
    private static int TypeOrder(JsonNode entry) => entry["type"]?.GetValue<string>() switch
    {
        "GR" => 0,
        "BS" => 1,
        "CS" => 2,
        _ => 9,
    };

    public JsonArray LoadChannels()
    {
        try
        {
            return JsonNode.Parse(File.ReadAllText(ChannelsFile)) as JsonArray ?? [];
        }
        catch
        {
            // まだ1度もスキャンしていない。空でよい (画面が「まだありません」と出す)
            return [];
        }
    }

    /// <summary>
    /// 預かった顔ぶれで差し替える。
    ///
    /// <para>
    /// **探した種別だけ**を入れ替え、他はそのまま残す。地上波だけスキャンした
    /// ときに全部を置き換えると、BS と CS が設定から消える (実際に消して、
    /// BS の予約が録れなくなった)。
    /// </para>
    /// </summary>
    public JsonArray SaveChannels(JsonArray found, HashSet<string> scanned)
    {
        var entries = new List<JsonNode>();
        foreach (var kept in LoadChannels())
        {
            if (kept is null) continue;
            var type = kept["type"]?.GetValue<string>() ?? "";
            if (!scanned.Contains(type)) entries.Add(kept.DeepClone());
        }
        foreach (var entry in found)
        {
            if (entry is not null) entries.Add(entry.DeepClone());
        }

        // 種別ごとにまとまっているほうが読みやすい (画面もこの順で出る)
        entries.Sort((a, b) =>
        {
            var order = TypeOrder(a) - TypeOrder(b);
            if (order != 0) return order;
            return string.CompareOrdinal(
                a["channel"]?.GetValue<string>() ?? "", b["channel"]?.GetValue<string>() ?? "");
        });

        var merged = new JsonArray();
        foreach (var entry in entries) merged.Add(entry);

        Directory.CreateDirectory(Path.GetDirectoryName(ChannelsFile)!);
        // 書きかけを読ませない。読む側 (denpa) は起動中にも取りに来る
        var working = $"{ChannelsFile}.writing";
        File.WriteAllText(working, merged.ToJsonString(Json.Pretty));
        File.Move(working, ChannelsFile, overwrite: true);
        return merged;
    }
}
