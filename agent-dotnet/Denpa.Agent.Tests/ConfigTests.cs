using System.Text.Json.Nodes;
using Denpa.Agent;
using Xunit;

namespace Denpa.Agent.Tests;

/*
 * 取り合いと HTTP の口は `agent/conformance.test.ts` が本物を起こして当てている
 * (bun 版と同じものを通す)。こちらで見るのは、そこからは届きにくいところ —
 * **設定の読み書き**と、チューナー自動検出の値の読み取り。
 */

public class TunerSpecTests
{
    private static Config Fresh()
    {
        var work = Directory.CreateTempSubdirectory();
        return new Config(
            Path.Combine(work.FullName, "tuners.json"), Path.Combine(work.FullName, "channels.json"));
    }

    [Fact]
    public void 既定では外のコマンドを起こさない()
    {
        // 選局は自分でやる (ioctl)。`recisdb` はもう要らない
        var spec = new TunerSpec("adapter0", ["GR"], false, "/dev/dvb/adapter0/frontend0");

        Assert.Null(spec.Resolve());
    }

    [Fact]
    public void 直に書いたコマンドが勝つ()
    {
        // 逃げ道。**画面からは触らせない** (ファイルに直に書いたときだけ効く)
        var spec = new TunerSpec("x", ["GR"], false, "/dev/null", null, "myTuner --ch {{channel}}");

        Assert.Equal("myTuner --ch {{channel}}", spec.Resolve());
    }

    [Fact]
    public void 書いて読み直すと同じものになる()
    {
        var config = Fresh();
        config.SaveTuners([
            new TunerSpec("adapter0", ["BS", "CS"], false, "/dev/dvb/adapter0/frontend0", "15v"),
            new TunerSpec("adapter1", ["GR"], true, "/dev/dvb/adapter1/frontend0"),
        ]);

        var read = config.LoadTuners();
        Assert.Equal(2, read.Count);
        Assert.Equal(["BS", "CS"], read[0].Types);
        Assert.Equal("15v", read[0].Lnb);
        Assert.Equal("/dev/dvb/adapter0/frontend0", read[0].Device);
        Assert.True(read[1].Disabled);
    }

    [Fact]
    public void 空を渡すと定義を消す()
    {
        // 「1本も無い」を書き込むより、**無い=自分で探す**のほうが後で困らない
        var config = Fresh();
        config.SaveTuners([new TunerSpec("a", ["GR"], false, "/dev/null")]);
        Assert.True(File.Exists(config.TunersFile));

        config.SaveTuners([]);

        Assert.False(File.Exists(config.TunersFile));
        Assert.Empty(config.LoadTuners());
    }

    [Fact]
    public void 壊れたファイルは空として扱う()
    {
        // 起動できないよりは、画面に「チューナーがありません」と出したほうがいい
        var config = Fresh();
        File.WriteAllText(config.TunersFile, "{ これは JSON ではない");

        Assert.Empty(config.LoadTuners());
    }

    [Fact]
    public void 名前の無いものは受け取らない()
    {
        Assert.Null(TunerSpec.FromJson(new JsonObject { ["types"] = new JsonArray() }));
    }
}

public class ChannelStoreTests
{
    private static Config Fresh()
    {
        var work = Directory.CreateTempSubdirectory();
        return new Config(
            Path.Combine(work.FullName, "tuners.json"), Path.Combine(work.FullName, "channels.json"));
    }

    private static JsonArray Entries(params (string Type, string Channel)[] items)
    {
        var list = new JsonArray();
        foreach (var (type, channel) in items)
        {
            list.Add((JsonNode)new JsonObject { ["type"] = type, ["channel"] = channel });
        }
        return list;
    }

    [Fact]
    public void 探した種別だけ差し替える()
    {
        // 地上波だけ探したときに全部を置き換えると BS と CS が設定から消える
        // (実際に消して、BS の予約が録れなくなった)
        var config = Fresh();
        config.SaveChannels(Entries(("GR", "T16"), ("BS", "BS11_0")), ["GR", "BS"]);

        var merged = config.SaveChannels(Entries(("GR", "T21")), ["GR"]);

        Assert.Equal(["T21", "BS11_0"], merged.Select(entry => entry!["channel"]!.GetValue<string>()));
    }

    [Fact]
    public void 種別ごとにまとめて並べる()
    {
        var config = Fresh();
        var merged = config.SaveChannels(
            Entries(("CS", "CS02"), ("BS", "BS11_0"), ("GR", "T21"), ("GR", "T16"), ("BS", "BS03_0")),
            ["GR", "BS", "CS"]);

        Assert.Equal(
            ["T16", "T21", "BS03_0", "BS11_0", "CS02"],
            merged.Select(entry => entry!["channel"]!.GetValue<string>()));
    }

    [Fact]
    public void 局名は逃がさずそのまま書く()
    {
        /*
         * `channels.json` は人が開いて確かめるもの。既定の符号化器は非ASCIIを
         * 全部逃がすので、局名が1つも読めなくなる。
         *
         * **全角空白 (U+3000) だけは逃げたままになる。** .NET のどの符号化器も
         * ASCII でない空白は必ず逃がす作りで、`JSON.stringify` と揃わない。
         * JSON としては同じものなので、ここは合わせにいかない
         */
        var config = Fresh();
        var entry = new JsonObject { ["type"] = "GR", ["channel"] = "T16", ["name"] = "ＴＯＫＹＯ　ＭＸ" };
        config.SaveChannels([entry], ["GR"]);

        var written = File.ReadAllText(config.ChannelsFile);
        Assert.Contains("ＴＯＫＹＯ", written);
        Assert.Contains("ＭＸ", written);
    }

    [Fact]
    public void まだ1度も預かっていなければ空()
    {
        Assert.Empty(Fresh().LoadChannels());
    }
}

public class RenderTests
{
    [Fact]
    public void mirakcのテンプレートを埋める()
    {
        Assert.Equal(
            "recisdb tune --device /dev/dvb/adapter0/frontend0 -c T27 -",
            TunerPool.Render("recisdb tune --device /dev/dvb/adapter0/frontend0 -c {{{channel}}} -", "T27", "GR"));
    }

    [Fact]
    public void 種別と長さも埋める()
    {
        Assert.Equal("x GR -", TunerPool.Render("x {{channel_type}} {{{duration}}}", "T27", "GR"));
    }

    [Fact]
    public void 知らない差し込みは空にする()
    {
        Assert.Equal("a  b", TunerPool.Render("a {{{extra_args}}} b", "T27", "GR"));
    }
}

/*
 * チューナーの自動検出。
 *
 * ioctl そのものは実機でしか試せないので、ここで見るのは**返ってきた値の
 * 読み取り**。数と並びは実機の PT3 で測ってあり (DeviceProbe の頭のコメント)、
 * ここに置いてあるのはそのとき出た値そのもの。
 */
public class DeviceProbeTests
{
    [Fact]
    public void 地上波と衛星を方式から分ける()
    {
        // 実機の PT3。adapter0/2 が ISDB-S(9)、adapter1/3 が ISDB-T(8)
        Assert.Equal(["GR"], DeviceProbe.TypesFor([8]));
        Assert.Equal(["BS", "CS"], DeviceProbe.TypesFor([9]));
        // 1本でどちらも受けられるものもある
        Assert.Equal(["GR", "BS", "CS"], DeviceProbe.TypesFor([8, 9]));
    }

    [Fact]
    public void 知らない方式は種別にしない()
    {
        // DVB-T や ATSC が出てきても、日本の放送には使わない
        Assert.Empty(DeviceProbe.TypesFor([3, 11]));
    }

    [Fact]
    public void frontend_info_から名前を読む()
    {
        var info = new byte[168];
        System.Text.Encoding.UTF8.GetBytes("Toshiba TC90522 ISDB-S module").CopyTo(info, 0);

        Assert.Equal("Toshiba TC90522 ISDB-S module", DeviceProbe.ParseName(info));
    }

    [Fact]
    public void 方式を答えないドライバは名前で当てる()
    {
        Assert.Equal(["BS", "CS"], DeviceProbe.TypesFromName("Toshiba TC90522 ISDB-S module"));
        Assert.Equal(["GR"], DeviceProbe.TypesFromName("Toshiba TC90522 ISDB-T module"));
        // 名前に方式が入っていないものは当てにいかない (黙って間違えるより出さない)
        Assert.Empty(DeviceProbe.TypesFromName("Some Generic Frontend"));
    }

    [Fact]
    public void dtv_property_から方式の並びを取り出す()
    {
        var property = new byte[76];
        BitConverter.TryWriteBytes(property.AsSpan(48), 2u);  // u.buffer.len
        property[16] = 8;                                     // u.buffer.data[0] = ISDB-T
        property[17] = 9;                                     // u.buffer.data[1] = ISDB-S

        Assert.Equal([8, 9], DeviceProbe.ParseDelivery(property));
    }

    [Fact]
    public void 何も入っていなければ空()
    {
        Assert.Empty(DeviceProbe.ParseDelivery(new byte[76]));
    }

    [Fact]
    public void chardev_は名前の決まりで分ける()
    {
        // px4_drv は方式を聞ける口を持たない。番号の決まりがそのまま種別
        Assert.Equal(["BS", "CS"], DeviceProbe.TypesForChardev("px4video0"));
        Assert.Equal(["GR"], DeviceProbe.TypesForChardev("px4video2"));
        Assert.Equal(["GR", "BS", "CS"], DeviceProbe.TypesForChardev("pxmlt5video0"));
        Assert.Empty(DeviceProbe.TypesForChardev("sda"));
    }
}
