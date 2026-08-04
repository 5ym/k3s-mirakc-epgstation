using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// 繋いである機材1本ぶん。
///
/// <para>
/// **選局コマンドそのものは持たない。** 画面から書き換えられるようにした以上、
/// 自由な文字列を受けると「denpa に入れた人がチューナー側で好きなコマンドを
/// 走らせられる」ことになる (しかもあちらは privileged)。持つのは
/// **デバイスと種別**だけにして、コマンドはこちらで組み立てる。
/// </para>
///
/// <para>
/// <c>Command</c> は逃げ道で、**ファイルに直に書いたときだけ**効く。画面からは
/// 触らせず、入っていれば読めるように出すだけ。**既定では誰も使わない** —
/// 選局は自分で掴んでやるようになった (Tuning.cs)。
/// </para>
/// </summary>
public sealed record TunerSpec(
    string Name,
    string[] Types,
    bool Disabled,
    string? Device = null,
    string? Lnb = null,
    string? Command = null)
{
    /// <summary>
    /// 選局を外のコマンドに任せるか。**書いてあるときだけ。**
    ///
    /// <para>
    /// 既定は自分で掴む (ioctl で選局して B25 も自分で解く。Tuning.cs)。
    /// ここに書いてあるときだけ、そのコマンドを起こして標準出力を読む。
    /// 変わった機材や、試すときの逃げ道。
    /// </para>
    /// </summary>
    public string? Resolve() => string.IsNullOrEmpty(Command) ? null : Command;

    public JsonObject ToJson()
    {
        var types = new JsonArray();
        foreach (var type in Types) types.Add((JsonNode?)JsonValue.Create(type));

        var node = new JsonObject
        {
            ["name"] = Name,
            ["types"] = types,
            ["disabled"] = Disabled,
            ["device"] = Device,
        };
        if (!string.IsNullOrEmpty(Lnb)) node["lnb"] = Lnb;
        if (!string.IsNullOrEmpty(Command)) node["command"] = Command;
        return node;
    }

    public static TunerSpec? FromJson(JsonNode? node)
    {
        if (node is not JsonObject item) return null;
        var name = item["name"]?.GetValue<string>() ?? "";
        if (name.Length == 0) return null;

        var types = new List<string>();
        if (item["types"] is JsonArray list)
        {
            foreach (var entry in list)
            {
                if (entry?.GetValue<string>() is { Length: > 0 } type) types.Add(type);
            }
        }

        return new TunerSpec(
            name,
            [.. types],
            item["disabled"]?.GetValue<bool>() ?? false,
            item["device"]?.GetValue<string>(),
            item["lnb"]?.GetValue<string>(),
            item["command"]?.GetValue<string>());
    }
}

/// <summary>
/// 設定ファイル2つ。**どちらも JSON で、どちらも denpa が書く。**
///
/// <list type="bullet">
/// <item><c>tuners.json</c> … 繋いである機材。画面から編集する</item>
/// <item><c>channels.json</c> … スキャンで分かったこと</item>
/// </list>
///
/// <para>
/// **YAML をやめた。** 人が手で書く前提だったからコメントを守る必要があり、
/// そのために既製のものを入れられない AOT では小さな読み取りを自分で持っていた。
/// 画面から書き換えるなら、書き戻せて壊れにくいほうがいい。
/// </para>
///
/// <para>
/// 中身を作るのはどちらもこちらではない。総当たりの選局こそ頼まれるが、NIT も
/// SDT も解かないので「何が居たか」は分からない。それでも控えを持つのはこちら側
/// にする — アンテナに何が映るかも、何本刺さっているかも、機材ごとの話だから。
/// </para>
/// </summary>
public sealed class Config(string tunersFile, string channelsFile)
{
    public string TunersFile { get; } = tunersFile;
    public string ChannelsFile { get; } = channelsFile;

    public static Config FromEnvironment() => new(
        Environment.GetEnvironmentVariable("TUNERS_FILE") ?? "/app-config/tuners.json",
        Environment.GetEnvironmentVariable("CHANNELS_FILE") ?? "/app-config/channels.json");

    private static JsonArray ReadArray(string path, string? key)
    {
        try
        {
            var parsed = JsonNode.Parse(File.ReadAllText(path));
            return (key is null ? parsed : parsed?[key]) as JsonArray ?? [];
        }
        catch
        {
            // まだ無い。空でよい (画面が「まだありません」と出す)
            return [];
        }
    }

    private static void WriteAtomic(string path, JsonNode body)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        // 書きかけを読ませない。読む側 (denpa) は起動中にも取りに来る
        var working = $"{path}.writing";
        File.WriteAllText(working, body.ToJsonString(Json.Pretty));
        File.Move(working, path, overwrite: true);
    }

    public List<TunerSpec> LoadTuners()
    {
        if (!File.Exists(TunersFile)) return [];
        var found = new List<TunerSpec>();
        foreach (var node in ReadArray(TunersFile, "tuners"))
        {
            if (TunerSpec.FromJson(node) is { } spec) found.Add(spec);
        }
        return found;
    }

    /// <summary>
    /// 画面から預かった機材で置き換える。
    ///
    /// <para>
    /// **空を渡すと設定そのものを消す。** そのまま「自動検出に戻す」になる。
    /// 1本も無い状態を書き込めるようにしておくより、無い状態=自分で探す、の
    /// ほうが後で困らない。
    /// </para>
    /// </summary>
    public void SaveTuners(List<TunerSpec> tuners)
    {
        if (tuners.Count == 0)
        {
            if (File.Exists(TunersFile)) File.Delete(TunersFile);
            Log.Write("チューナーの定義を消しました (次からは自動検出)");
            return;
        }

        var list = new JsonArray();
        foreach (var tuner in tuners) list.Add((JsonNode)tuner.ToJson());
        WriteAtomic(TunersFile, new JsonObject { ["tuners"] = list });
        Log.Write($"チューナーの定義を保存しました: {tuners.Count} 本");
    }

    /// <summary>
    /// 機材を決める。**書いてあればそれ、無ければ自分で見つける。**
    ///
    /// <para>
    /// 自動で分かるのは「刺さっているデバイスと、それが受けられる方式」だけ。
    /// LNB を足したい・1本だけ止めたい・別PCのぶんを混ぜたい、は人にしか
    /// 決められないので、そのときは画面から書く。
    /// </para>
    /// </summary>
    public (List<TunerSpec> Tuners, bool Detected) ResolveTuners()
    {
        var written = LoadTuners();
        if (written.Count > 0) return (written, false);

        var found = DeviceProbe.Detect();
        if (found.Count == 0)
        {
            Log.Write($"チューナーが見つかりません ({TunersFile} に書けば、そちらを使います)");
            return (found, true);
        }
        Log.Write($"{TunersFile} に定義が無いので、刺さっている機材を使います:");
        foreach (var tuner in found) Log.Write($"  {tuner.Name} [{string.Join(", ", tuner.Types)}] {tuner.Device}");
        return (found, true);
    }

    /// <summary>並べ替えの順。知らない種別は後ろに送る</summary>
    private static int TypeOrder(JsonNode entry) => entry["type"]?.GetValue<string>() switch
    {
        "GR" => 0,
        "BS" => 1,
        "CS" => 2,
        _ => 9,
    };

    public JsonArray LoadChannels() => ReadArray(ChannelsFile, null);

    /// <summary>
    /// チャンネル名から TSID を引く。**衛星の選局に要る。**
    ///
    /// <para>
    /// 衛星は1つの周波数に何本もの TS が相乗りしていて、復調器は TSID を
    /// 書いて選り分ける。denpa が言ってくるのは <c>BS15_0</c> のような相対番号
    /// なので、ここで直す (<see cref="ChannelTable.StreamId"/>)。
    /// </para>
    ///
    /// <para>
    /// **スキャン結果がいちばん新しい。** BS は再編があるので、焼き込んだ表は
    /// いつか古くなる。1度でもスキャンしていればこちらが勝つ。
    /// </para>
    /// </summary>
    public Func<string, int?> StreamIds()
    {
        var table = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var entry in LoadChannels())
        {
            var channel = entry?["channel"]?.GetValue<string>();
            var id = entry?["transportStreamId"]?.GetValue<int>();
            if (channel is not null && id is > 0) table[channel] = id.Value;
        }
        return name => table.TryGetValue(name, out var id) ? id : null;
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
        WriteAtomic(ChannelsFile, merged);
        return merged;
    }
}
