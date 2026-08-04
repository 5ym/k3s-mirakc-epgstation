namespace Denpa.Agent;

/// <summary>
/// 実機で選局を確かめる小道具。**サーバを立てずに1本だけ試す。**
///
/// <para>
/// 掴んだままの選局は、値が1つ違っても「ioctl は通るが同期しない」という
/// 出方をする。単体テストでは踏めないので、実機で当てるための口を用意した
/// (チューナー自動検出のときと同じやり方)。
/// </para>
///
/// <code>
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27
/// denpa-agent --tune /dev/dvb/adapter0/frontend0 BS15_0 --lnb 15v
/// denpa-agent --tune /dev/dvb/adapter1/frontend0 T27,T21   # 掴んだまま切り替える
/// </code>
///
/// <para>
/// 見るのは3つ。**同期したか・TS の形をしているか・切り替えに何秒かかるか。**
/// 最後のが roadmap で「要実測」と書いたところで、掴み直すのと比べて
/// どれだけ短いかはここでしか分からない。
/// </para>
/// </summary>
public static class Probe
{
    /// <summary>1チャンネルあたり読む時間</summary>
    private static readonly TimeSpan Read = TimeSpan.FromSeconds(3);

    /// <summary>
    /// ファイルを1つ解く。**チューナーを使わずに B25 だけ確かめる。**
    ///
    /// <para>
    /// 掛かったまま録れてしまったものを救うのにも使える (いまは
    /// <c>/denpa/decode</c> が <c>recisdb</c> を起こしてやっている)。
    /// </para>
    /// </summary>
    public static int Decode(string[] args)
    {
        var source = args.ElementAtOrDefault(1);
        var destination = args.ElementAtOrDefault(2);
        if (source is null || destination is null)
        {
            Console.Error.WriteLine("usage: denpa-agent --decode-file <in.ts> <out.ts>");
            return 2;
        }

        using var b25 = AribB25.Open();
        Console.WriteLine($"カード {string.Join(" / ", b25.Ids())}");

        using var input = File.OpenRead(source);
        using var output = File.Create(destination);
        var buffer = new byte[188 * 1024];
        long read;
        long written = 0;
        long scrambled = 0;
        long packets = 0;

        while ((read = input.Read(buffer)) > 0)
        {
            for (var at = 0; at + 188 <= read; at += 188)
            {
                packets++;
                if (Scrambled(buffer.AsSpan(at))) scrambled++;
            }
            var decoded = b25.Decode(buffer.AsSpan(0, (int)read));
            output.Write(decoded);
            written += decoded.Length;
        }

        var rest = b25.Flush();
        output.Write(rest);
        written += rest.Length;

        var before = packets == 0 ? 0 : 100.0 * scrambled / packets;
        Console.WriteLine($"{input.Length} -> {written} バイト  元は {before:F1}% が掛かっていました");
        return 0;
    }

    public static int Run(string[] args)
    {
        var device = args.ElementAtOrDefault(1);
        var channels = args.ElementAtOrDefault(2)?.Split(',') ?? [];
        if (device is null || channels.Length == 0)
        {
            Console.Error.WriteLine("usage: denpa-agent --tune <device> <channel[,channel...]> [--lnb 15v]");
            return 2;
        }

        var lnbAt = Array.IndexOf(args, "--lnb");
        var lnb = lnbAt >= 0 ? args.ElementAtOrDefault(lnbAt + 1) : null;
        var decode = args.Contains("--decode");

        var known = Config.FromEnvironment().StreamIds();

        using var b25 = decode ? AribB25.Open() : null;
        if (b25 is not null)
        {
            var ids = b25.Ids();
            Console.WriteLine($"カード {(ids.Length == 0 ? "(番号を読めません)" : string.Join(" / ", ids))}");
        }

        using ITuneDevice tuner = device.Contains("/dvb/", StringComparison.Ordinal)
            ? new DvbTuner(device, lnb)
            : new Px4Tuner(device, lnb);

        Console.WriteLine($"{device} を開きました{(lnb is null ? "" : $" (LNB {lnb})")}");

        foreach (var name in channels)
        {
            var tuning = ChannelTable.Parse(name);
            if (tuning is null)
            {
                Console.Error.WriteLine($"{name}: 選局表にありません");
                return 1;
            }

            var streamId = ChannelTable.StreamId(name, tuning, known);
            var unit = tuning.Satellite ? "kHz" : "Hz";
            var filter = streamId == ChannelTable.NoStreamId ? "" : $" TSID={streamId}";
            Console.WriteLine($"--- {name}  {tuning.Frequency} {unit}{filter}");

            var started = DateTime.UtcNow;
            try
            {
                tuner.Tune(tuning, streamId);
            }
            catch (IOException error)
            {
                Console.Error.WriteLine($"{name}: {error.Message}");
                continue;
            }
            Console.WriteLine($"    同期 {(DateTime.UtcNow - started).TotalMilliseconds:F0} ms");

            Measure(tuner.Output, name, b25);
        }

        return 0;
    }

    /// <summary>読めたバイト数と、それが TS の形をしているか。解かせたなら解けたか</summary>
    private static void Measure(Stream stream, string name, AribB25? b25)
    {
        var buffer = new byte[188 * 1024];
        var started = DateTime.UtcNow;
        var deadline = started + Read;
        var first = TimeSpan.Zero;
        long total = 0;
        long sync = 0;
        long packets = 0;
        long scrambledIn = 0;
        long outPackets = 0;
        long scrambledOut = 0;

        while (DateTime.UtcNow < deadline)
        {
            var read = stream.Read(buffer);
            if (read <= 0) break;
            if (total == 0) first = DateTime.UtcNow - started;
            total += read;
            // 188バイトごとに 0x47 が来ているか。来ていなければ TS ではない
            for (var at = 0; at + 188 <= read; at += 188)
            {
                packets++;
                if (buffer[at] == 0x47) sync++;
                if (Scrambled(buffer.AsSpan(at))) scrambledIn++;
            }

            if (b25 is null) continue;

            var decoded = b25.Decode(buffer.AsSpan(0, read));
            for (var at = 0; at + 188 <= decoded.Length; at += 188)
            {
                outPackets++;
                if (Scrambled(decoded[at..])) scrambledOut++;
            }
        }

        var mbps = total * 8.0 / Read.TotalSeconds / 1_000_000;
        var ratio = packets == 0 ? 0 : 100.0 * sync / packets;
        Console.WriteLine(
            $"    最初の1バイト {first.TotalMilliseconds:F0} ms  "
            + $"{total / 1024} KiB  {mbps:F2} Mbps  同期バイト {ratio:F1}%");

        var before = packets == 0 ? 0 : 100.0 * scrambledIn / packets;
        if (b25 is null)
        {
            Console.WriteLine($"    掛かっているパケット {before:F1}%");
            return;
        }

        var after = outPackets == 0 ? 0 : 100.0 * scrambledOut / outPackets;
        Console.WriteLine($"    掛かっているパケット {before:F1}% -> 解いたあと {after:F1}% ({outPackets} 個)");
        if (total == 0) Console.Error.WriteLine($"    {name}: 1バイトも来ていません");
    }

    /// <summary>
    /// スクランブルが掛かっているか。**4バイト目の上2ビット** (transport_scrambling_control)。
    /// 解けていれば 0 になる
    /// </summary>
    private static bool Scrambled(ReadOnlySpan<byte> packet) => (packet[3] & 0xC0) != 0;
}
