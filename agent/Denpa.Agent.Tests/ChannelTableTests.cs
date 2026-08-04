using Denpa.Agent;
using Xunit;

namespace Denpa.Agent.Tests;

/*
 * 選局表。
 *
 * ここは**数字が1つ違っても ioctl は通り、ただ同期しないだけ**という出方を
 * するので、値そのものを押さえておく。当てているのは recisdb が持っている表と
 * 同じ数字で、いま実機で選局できているものと揃っているかどうかがすべて
 * (実際に掴めるかは `--tune` で実機に当てる。Probe.cs)。
 */

public class ChannelTableTests
{
    [Fact]
    public void 地上波は_Hz_で数える()
    {
        // UHF 13ch = 473.142857 MHz。1/7 MHz のずれは放送のとおりで、丸めない
        Assert.Equal(473_142_857u, ChannelTable.Parse("T13")!.Frequency);
        Assert.Equal(557_142_857u, ChannelTable.Parse("T27")!.Frequency);
        Assert.Equal(767_142_857u, ChannelTable.Parse("T62")!.Frequency);
    }

    [Fact]
    public void 衛星は_kHz_で数える()
    {
        /*
         * DVB API の決まりで、**地上波は Hz、衛星は kHz**。取り違えても
         * ioctl は通るので、ここを間違えると「同期しない」としか見えない
         */
        var bs = ChannelTable.Parse("BS01_0")!;
        Assert.Equal(ChannelTable.SysIsdbs, bs.Delivery);
        Assert.Equal(1_049_480u, bs.Frequency);

        // 中継は 38.36 MHz 刻み。BS03 は BS01 の1つ隣
        Assert.Equal(1_087_840u, ChannelTable.Parse("BS03_0")!.Frequency);
        Assert.Equal(1_471_440u, ChannelTable.Parse("BS23_0")!.Frequency);

        // CS は 40 MHz 刻みで、BS とは別の並び
        Assert.Equal(1_613_000u, ChannelTable.Parse("CS02")!.Frequency);
        Assert.Equal(2_053_000u, ChannelTable.Parse("CS24")!.Frequency);
    }

    [Fact]
    public void 同じ周波数に相乗りしている本数を覚えておく()
    {
        // BS01_0 と BS01_1 は**同じ周波数**。開いたままなら選局し直さずに済む
        Assert.Equal(ChannelTable.Parse("BS01_0")!.Frequency, ChannelTable.Parse("BS01_3")!.Frequency);
        Assert.Equal(0, ChannelTable.Parse("BS01_0")!.RelativeTs);
        Assert.Equal(3, ChannelTable.Parse("BS01_3")!.RelativeTs);
    }

    [Fact]
    public void px4_の番号は別の数え方()
    {
        // chardev は周波数ではなく表の番号で言う。地上波は物理チャンネル+50
        Assert.Equal(68, ChannelTable.Parse("T18")!.FreqNo);
        // 衛星はスロットが相対TS番号そのもの
        Assert.Equal((0, 2), (ChannelTable.Parse("BS01_2")!.FreqNo, ChannelTable.Parse("BS01_2")!.Slot));
        Assert.Equal(11, ChannelTable.Parse("BS23_0")!.FreqNo);
        Assert.Equal(12, ChannelTable.Parse("CS02")!.FreqNo);
        Assert.Equal(23, ChannelTable.Parse("CS24")!.FreqNo);
    }

    [Fact]
    public void ゼロ詰めは同じものとして読む()
    {
        Assert.Equal(ChannelTable.Parse("BS1_0")!.Frequency, ChannelTable.Parse("BS01_0")!.Frequency);
    }

    [Theory]
    [InlineData("T12")]      // UHF は 13 から
    [InlineData("T63")]      // 62 まで
    [InlineData("BS02_0")]   // BS は奇数だけ
    [InlineData("BS25_0")]
    [InlineData("BS19_8")]   // 相乗りは 8 本まで
    [InlineData("CS01")]     // CS は偶数だけ
    [InlineData("CS26")]
    [InlineData("")]
    [InlineData("T")]
    [InlineData("SKY1")]
    public void 受け取らない名前(string name)
    {
        Assert.Null(ChannelTable.Parse(name));
    }

    [Theory]
    [InlineData("BS07_0")]
    [InlineData("BS17_0")]
    public void ISDB_S3_の中継は受け取らない(string name)
    {
        // BS-7 と BS-17 は 4K/8K。この復調器では受からないので、総当たりの
        // スキャンでも試させない (実機に投げれば「同期しない」で5秒溶ける)
        Assert.Null(ChannelTable.Parse(name));
    }
}

public class StreamIdTests
{
    [Fact]
    public void 地上波は選り分けない()
    {
        var gr = ChannelTable.Parse("T27")!;
        Assert.Equal(ChannelTable.NoStreamId, ChannelTable.StreamId("T27", gr, _ => 1234));
    }

    [Fact]
    public void CS_も選り分けない()
    {
        // 1つの中継に1本しか乗っていない
        var cs = ChannelTable.Parse("CS02")!;
        Assert.Equal(ChannelTable.NoStreamId, ChannelTable.StreamId("CS02", cs, null));
    }

    [Fact]
    public void スキャン結果が焼き込んだ表に勝つ()
    {
        // BS は再編がある。1度でもスキャンしていれば、そちらが必ず新しい
        var bs = ChannelTable.Parse("BS15_0")!;
        Assert.Equal(16625u, ChannelTable.StreamId("BS15_0", bs, null));
        Assert.Equal(9999u, ChannelTable.StreamId("BS15_0", bs, _ => 9999));
    }

    [Fact]
    public void 表にも無ければ選り分けない()
    {
        // 焼き込んだ表に無い相乗り。TSID を指定せずに掴んで、あとは復調器任せ
        var bs = ChannelTable.Parse("BS15_7")!;
        Assert.Equal(ChannelTable.NoStreamId, ChannelTable.StreamId("BS15_7", bs, _ => null));
    }
}

public class DvbDeviceTests
{
    [Fact]
    public void frontend_から_demux_と_dvr_を組み立てる()
    {
        var (adapter, number) = DvbTuner.Split("/dev/dvb/adapter1/frontend0");

        Assert.Equal("/dev/dvb/adapter1", adapter);
        Assert.Equal("0", number);
    }

    [Fact]
    public void DVB_でないデバイスは受け取らない()
    {
        Assert.Throws<ArgumentException>(() => DvbTuner.Split("/dev/px4video0"));
    }
}
