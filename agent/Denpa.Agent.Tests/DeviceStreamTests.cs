using System.Diagnostics;
using System.Runtime.InteropServices;
using Denpa.Agent;
using Microsoft.Win32.SafeHandles;
using Xunit;

namespace Denpa.Agent.Tests;

/*
 * デバイスの読み口。
 *
 * ここは**電波が来ていないときの振る舞い**が問題になる。デバイスは選局を
 * 跨いで開いたままなので、読み手のほうから降りられないと、蹴られた読み手が
 * 居座ったまま次の選局が始まる。実機では、そのせいで**同じ復号器を2本の
 * 流れから叩き**、プロセスごと落ちた (`double free or corruption`)。
 *
 * 本物のチューナーは要らない。何も来ないパイプで「来ないときにどうするか」は
 * そのまま試せる。
 */
public partial class DeviceStreamTests
{
    [LibraryImport("libc", EntryPoint = "pipe", SetLastError = true)]
    private static partial int Pipe(Span<int> fds);

    /// <summary>何も書き込まれないパイプ。**永久に来ない読み口**の代わり</summary>
    private static (DeviceStream Stream, SafeFileHandle Write) Silent()
    {
        Span<int> fds = stackalloc int[2];
        Assert.Equal(0, Pipe(fds));
        return (new DeviceStream(new SafeFileHandle(fds[0], ownsHandle: true)),
            new SafeFileHandle(fds[1], ownsHandle: true));
    }

    [Fact]
    public void 降りると言えば_何も来なくても戻る()
    {
        var (stream, write) = Silent();
        using (stream)
        using (write)
        {
            var buffer = new byte[188];
            var clock = Stopwatch.StartNew();
            // 0.2秒ごとに起きて印を見る。1周ぶんで戻れば十分
            var read = stream.Read(buffer, 0, buffer.Length, () => true);
            clock.Stop();

            Assert.Equal(0, read);
            Assert.True(clock.ElapsedMilliseconds < 1000, $"{clock.ElapsedMilliseconds}ms 掛かった");
        }
    }

    /*
     * **降りると言うまでは戻らない。**
     *
     * 何も来ないからといって勝手に終わると、電波が一瞬途切れただけで録画が
     * 落ちることになる。実際に来ていないだけなら待ち続けるのが正しい
     */
    [Fact]
    public async Task 降りると言わなければ_来るまで待つ()
    {
        var (stream, write) = Silent();
        using (stream)
        using (write)
        {
            var buffer = new byte[188];
            var reading = Task.Run(() => stream.Read(buffer, 0, buffer.Length, () => false));

            var waited = await Task.WhenAny(reading, Task.Delay(TimeSpan.FromMilliseconds(600), TestContext.Current.CancellationToken));
            Assert.NotSame(reading, waited);

            // 書けば返ってくる
            var payload = new byte[] { 0x47, 0x01, 0x02 };
            Assert.Equal(payload.Length, Write(write, payload));
            Assert.Equal(payload.Length, await reading.WaitAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken));
        }
    }

    private static unsafe int Write(SafeFileHandle handle, byte[] data)
    {
        fixed (byte* source = data)
        {
            return (int)WriteFd((int)handle.DangerousGetHandle(), source, (nuint)data.Length);
        }
    }

    [LibraryImport("libc", EntryPoint = "write", SetLastError = true)]
    private static unsafe partial nint WriteFd(int fd, byte* buffer, nuint count);
}
