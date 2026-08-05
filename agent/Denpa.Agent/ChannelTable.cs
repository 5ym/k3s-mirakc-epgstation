using System.Globalization;

namespace Denpa.Agent;

/// <summary>
/// 選局表。**チャンネル名を周波数に直す。**
///
/// <para>
/// いままでこれを持っていたのは <c>recisdb</c> のほうで、こちらは
/// <c>--channel T27</c> と渡すだけだった。掴んだまま選局するには自分で
/// ioctl を叩くことになるので、名前から周波数への対応もこちらに要る
/// (docs/agent.md)。
/// </para>
///
/// <para>
/// 値は <a href="https://github.com/kazuki0824/recisdb-rs">recisdb-rs</a> の
/// <c>channels.rs</c> から取った。**いま実機で選局できているものと同じ数字**に
/// することがいちばん大事で、自分で導き直す理由が無い。
/// </para>
///
/// <para>
/// 単位が2つあるのは DVB API の決まり。**地上波は Hz、衛星は kHz**で
/// <c>DTV_FREQUENCY</c> に渡す。ここを取り違えても ioctl は通り、ただ
/// 同期しないだけなので気付きにくい。
/// </para>
/// </summary>
public static class ChannelTable
{
    /// <summary>`linux/dvb/frontend.h` の <c>SYS_ISDBT</c></summary>
    public const int SysIsdbt = 8;

    /// <summary>`linux/dvb/frontend.h` の <c>SYS_ISDBS</c></summary>
    public const int SysIsdbs = 9;

    /// <summary>TS を選り分けない (<c>NO_STREAM_ID_FILTER</c>)</summary>
    public const uint NoStreamId = ~0U;

    /// <summary>
    /// 1つの物理チャンネルを掴むのに要るもの、全部。
    /// </summary>
    /// <param name="Type">denpa の種別 (GR / BS / CS)</param>
    /// <param name="Delivery">DVB の方式 (<see cref="SysIsdbt"/> / <see cref="SysIsdbs"/>)</param>
    /// <param name="Frequency">**地上波は Hz、衛星は kHz**</param>
    /// <param name="RelativeTs">衛星で同じ周波数に相乗りしている何本目か。無ければ -1</param>
    /// <param name="FreqNo">px4_drv の <c>ptx_freq.freq_no</c></param>
    /// <param name="Slot">px4_drv の <c>ptx_freq.slot</c></param>
    public sealed record Tuning(
        string Type, int Delivery, uint Frequency, int RelativeTs, int FreqNo, int Slot)
    {
        public bool Satellite => Delivery == SysIsdbs;
    }

    /// <summary>
    /// チャンネル名を読む。**読めなければ null** (総当たりのスキャンが投げてくる
    /// 名前もここを通る)。
    ///
    /// <para>
    /// <c>T13</c>–<c>T62</c> / <c>BS01_0</c>–<c>BS23_7</c> / <c>CS02</c>–<c>CS24</c>。
    /// 衛星は BS が奇数、CS が偶数で、**BS-7 と BS-17 だけは受け取らない** —
    /// あそこは 4K/8K (ISDB-S3) で、この構成のチューナーでは復調できない。
    /// </para>
    /// </summary>
    public static Tuning? Parse(string name)
    {
        if (name.StartsWith("T", StringComparison.Ordinal))
        {
            if (!Number(name[1..], out var channel) || channel is < 13 or > 62) return null;
            // UHF 13-62ch。1/7 MHz のずれは放送のとおりで、丸めない
            return new Tuning(
                "GR", SysIsdbt, (uint)(473142857 + (channel - 13) * 6000000), -1, channel + 50, 0);
        }

        if (name.StartsWith("BS", StringComparison.Ordinal))
        {
            var body = name[2..];
            var relative = -1;
            var underscore = body.IndexOf('_');
            if (underscore >= 0)
            {
                if (!Number(body[(underscore + 1)..], out relative) || relative is < 0 or > 7) return null;
                body = body[..underscore];
            }
            if (!Number(body, out var channel)) return null;
            if (channel is < 1 or > 23 || channel % 2 == 0) return null;
            if (channel is 7 or 17) return null;  // ISDB-S3 (4K/8K)。この復調では受からない

            var index = channel / 2;  // BS01 -> 0 … BS23 -> 11
            return new Tuning("BS", SysIsdbs, (uint)(1049480 + 38360 * index), relative, index, relative);
        }

        if (name.StartsWith("CS", StringComparison.Ordinal))
        {
            if (!Number(name[2..], out var channel)) return null;
            if (channel is < 2 or > 24 || channel % 2 != 0) return null;

            var index = channel / 2 + 11;  // CS02 -> 12 … CS24 -> 23
            return new Tuning("CS", SysIsdbs, (uint)(1613000 + 40000 * (index - 12)), -1, index, 0);
        }

        return null;
    }

    /// <summary>
    /// DVB に渡す <c>DTV_STREAM_ID</c>。
    ///
    /// <para>
    /// 衛星は1つの周波数に何本もの TS が相乗りしていて、復調器は
    /// **TSID を書いて選り分ける** (相対番号では選べない)。ところが denpa が
    /// 呼んでくるのは <c>BS15_0</c> のような**相対番号**なので、ここで TSID に直す。
    /// </para>
    ///
    /// <para>
    /// <paramref name="known"/> には**自分の <c>channels.json</c>** を渡す。
    /// スキャン結果には TSID が入っていて、そちらのほうが必ず新しい —
    /// BS は再編があるので、焼き込んだ表は古くなる。下の表は
    /// **まだ1度もスキャンしていないとき**だけのもの。
    /// </para>
    /// </summary>
    public static uint StreamId(string name, Tuning tuning, Func<string, int?>? known = null)
    {
        // CS は1つの中継に1本しか乗っていない。選り分ける必要が無い
        if (!tuning.Satellite || tuning.RelativeTs < 0) return NoStreamId;

        var scanned = known?.Invoke(name);
        if (scanned is > 0) return (uint)scanned.Value;

        return Fallback.TryGetValue(name, out var id) ? id : NoStreamId;
    }

    /// <summary>
    /// スキャン前に使う BS の TSID。
    ///
    /// <para>
    /// recisdb が持っている表 (<c>dvbv5_channels_isdbs.conf</c>) と同じもの。
    /// **1度スキャンすれば <c>channels.json</c> のほうが勝つ**ので、ここが
    /// 古くなっても引きずらない。
    /// </para>
    /// </summary>
    private static readonly Dictionary<string, uint> Fallback = new(StringComparer.Ordinal)
    {
        ["BS01_0"] = 16400, ["BS01_1"] = 16401, ["BS01_2"] = 16402,
        ["BS03_0"] = 16432, ["BS03_1"] = 17969, ["BS03_2"] = 17970,
        ["BS05_0"] = 17488, ["BS05_1"] = 17489,
        ["BS09_0"] = 16528, ["BS09_1"] = 16530,
        ["BS13_0"] = 16592, ["BS13_1"] = 16593, ["BS13_2"] = 18130,
        ["BS15_0"] = 16625, ["BS15_1"] = 16626, ["BS15_2"] = 18675,
        ["BS19_0"] = 18224, ["BS19_1"] = 18225, ["BS19_2"] = 18226, ["BS19_3"] = 18227,
        ["BS21_0"] = 18256, ["BS21_1"] = 18257, ["BS21_2"] = 18258,
        ["BS23_0"] = 18288, ["BS23_1"] = 18801, ["BS23_2"] = 18803,
    };

    private static bool Number(string text, out int value)
    {
        // 0詰めは許す (`BS01_0` と `BS1_0` は同じもの)。それ以外は受け取らない
        value = 0;
        return text.Length is > 0 and <= 3
            && text.All(char.IsAsciiDigit)
            && int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }
}
