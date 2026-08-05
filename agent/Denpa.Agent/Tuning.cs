using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Denpa.Agent;

/// <summary>
/// デバイスを**掴んだまま**選局する。
///
/// <para>
/// これまでは選局のたびに <c>recisdb</c> を起こしていた。1回1チャンネルの
/// 使い捨てで、チャンネルを変えるにはプロセスごと立て直すしかない。その間
/// デバイスが宙に浮き、掴み直す隙間ができる (docs/agent.md)。
/// </para>
///
/// <para>
/// 口は2つある。どちらも「開く → 選局 → 流し始める → 読む → 選局し直す」で、
/// 違うのはそれをどの ioctl で言うかだけ。
/// </para>
///
/// <list type="bullet">
/// <item><see cref="DvbTuner"/> … 標準の Linux DVB v5。PT2/PT3、PX-S1UD、PX-BCUD</item>
/// <item><see cref="Px4Tuner"/> … <c>px4_drv</c> の chardev。PX4/PX5/PX-MLT 系</item>
/// </list>
/// </summary>
public interface ITuneDevice : IDisposable
{
    /// <summary>
    /// 選局する。**開いたまま何度でも呼べる。**
    /// 同期しなければ例外 (電波が来ていない、その周波数に放送が無い)。
    /// </summary>
    void Tune(ChannelTable.Tuning tuning, uint streamId);

    /// <summary>TS の読み口。選局し直しても同じものが続く</summary>
    Stream Output { get; }
}

/// <summary>libc の口。ioctl を直に叩くところだけ</summary>
internal static unsafe partial class Sys
{
    public const int NonBlocking = 0x800;
    public const int ReadOnly = 0;
    public const int ReadWrite = 2;

    [LibraryImport("libc", EntryPoint = "open", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    public static partial int Open(string path, int flags);

    [LibraryImport("libc", EntryPoint = "ioctl", SetLastError = true)]
    public static partial int Ioctl(int fd, nuint request, nint argument);

    [LibraryImport("libc", EntryPoint = "ioctl", SetLastError = true)]
    public static partial int IoctlValue(int fd, nuint request, nint value);

    [LibraryImport("libc", EntryPoint = "read", SetLastError = true)]
    public static partial nint ReadFd(int fd, byte* buffer, nuint count);

    [LibraryImport("libc", EntryPoint = "poll", SetLastError = true)]
    public static partial int Poll(byte* fds, nuint count, int timeout);

    /// <summary>開けなければ errno を添えて投げる。デバイスが無い・使用中の区別が要る</summary>
    public static SafeFileHandle Must(string path, int flags)
    {
        var fd = Open(path, flags);
        if (fd < 0) throw new IOException($"{path} を開けません ({Marshal.GetLastPInvokeErrorMessage()})");
        return new SafeFileHandle(fd, ownsHandle: true);
    }

    public static void Call(SafeFileHandle handle, nuint request, nint argument, string what)
    {
        if (Ioctl((int)handle.DangerousGetHandle(), request, argument) < 0)
        {
            throw new IOException($"{what} に失敗しました ({Marshal.GetLastPInvokeErrorMessage()})");
        }
    }
}

/// <summary>
/// デバイスからの読み口。**待っている最中でも畳める。**
///
/// <para>
/// 素直に開いて読むと、<c>read</c> で待っている間は誰にも止められない。
/// TS が来なくなったチューナーを掴んだまま、畳もうとしても畳めない、という
/// 止まり方をする。<c>poll</c> で待って**時々起きる**ようにしてある。
/// </para>
/// </summary>
internal sealed unsafe class DeviceStream(SafeFileHandle handle) : Stream
{
    /// <summary>この間隔で起きて、畳めと言われていないか見る</summary>
    private const int WakeMs = 200;

    private const short PollIn = 1;

    private volatile bool _closed;

    public void Stop() => _closed = true;

    public override int Read(byte[] buffer, int offset, int count)
    {
        var fd = (int)handle.DangerousGetHandle();
        // struct pollfd { int fd; short events; short revents; }
        var descriptor = stackalloc byte[8];
        while (!_closed)
        {
            *(int*)descriptor = fd;
            *(short*)(descriptor + 4) = PollIn;
            *(short*)(descriptor + 6) = 0;

            var ready = Sys.Poll(descriptor, 1, WakeMs);
            if (ready < 0) return 0;
            if (ready == 0) continue;

            fixed (byte* target = &buffer[offset])
            {
                var read = Sys.ReadFd(fd, target, (nuint)count);
                if (read > 0) return (int)read;
                // EAGAIN。まだ来ていないだけなので待ち直す
                if (read < 0 && Marshal.GetLastPInvokeError() == 11) continue;
                return 0;
            }
        }
        return 0;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        _closed = true;
        handle.Dispose();
        base.Dispose(disposing);
    }
}

/// <summary>
/// 標準の Linux DVB (v5) で掴む。**実機の PT3 はこちら** (<c>earth_pt3</c>)。
///
/// <para>
/// 開くものが3つある。<c>frontend</c> が選局、<c>demux</c> が「何を流すか」、
/// <c>dvr</c> が読み口。選局し直すのに閉じる必要があるのは1つも無い。
/// </para>
///
/// <para>
/// 手順は <c>recisdb</c> の DVB 側 (<c>dvbv5.rs</c>) と同じ並びにしてある。
/// あちらが libdvbv5 越しにやっていることを、ここでは ioctl で直に言うだけ。
/// </para>
/// </summary>
public sealed class DvbTuner : ITuneDevice
{
    // linux/dvb/frontend.h
    private const uint FeSetProperty = 0x40106f52;   // _IOW('o', 82, struct dtv_properties)
    private const uint FeReadStatus = 0x80046f45;    // _IOR('o', 69, fe_status_t)
    private const uint FeHasLock = 0x10;

    private const uint DtvTune = 1;
    private const uint DtvFrequency = 3;
    private const uint DtvBandwidthHz = 5;
    private const uint DtvVoltage = 10;
    private const uint DtvDeliverySystem = 17;
    private const uint DtvIsdbtPartialReception = 18;
    private const uint DtvIsdbtSoundBroadcasting = 19;
    private const uint DtvIsdbtLayerEnabled = 41;
    private const uint DtvStreamId = 42;

    private const int PropertySize = 76;             // packed。DeviceProbe の頭のコメントに実測値
    private const int PropertyDataAt = 16;

    // linux/dvb/dmx.h
    private const uint DmxStart = 0x6f29;            // _IO('o', 41)
    private const uint DmxStop = 0x6f2a;             // _IO('o', 42)
    private const uint DmxSetPesFilter = 0x40146f2c; // _IOW('o', 44, struct dmx_pes_filter_params)
    private const uint DmxSetBufferSize = 0x6f2d;    // _IO('o', 45)

    private const int DmxInFrontend = 0;
    private const int DmxOutTsTap = 2;
    private const int DmxPesOther = 20;
    private const int DmxImmediateStart = 4;
    private const ushort AllPids = 0x2000;

    /// <summary>読み口の溜め。詰まると取りこぼす (demux は待ってくれない)</summary>
    private const int DemuxBuffer = 8 * 1024 * 1024;

    /// <summary>同期を待つ上限。過ぎたら「電波が来ていない」</summary>
    private static readonly TimeSpan LockTimeout = TimeSpan.FromSeconds(5);

    private readonly SafeFileHandle _frontend;
    private readonly SafeFileHandle _demux;
    private readonly DeviceStream _dvr;
    private readonly int? _voltage;
    private bool _streaming;

    /// <param name="frontend">`/dev/dvb/adapter0/frontend0`。demux と dvr は同じ番号から組み立てる</param>
    /// <param name="lnb">衛星の給電 (`15v` / `11v`)。要らない構成では null</param>
    public DvbTuner(string frontend, string? lnb)
    {
        var (adapter, number) = Split(frontend);
        _frontend = Sys.Must(frontend, Sys.ReadWrite);
        try
        {
            _demux = Sys.Must($"{adapter}/demux{number}", Sys.ReadWrite);
            _dvr = new DeviceStream(Sys.Must($"{adapter}/dvr{number}", Sys.ReadOnly | Sys.NonBlocking));
        }
        catch
        {
            _frontend.Dispose();
            _demux?.Dispose();
            throw;
        }

        // recisdb と同じ対応。11v→13V / 15v→18V (SEC_VOLTAGE_13 = 0, SEC_VOLTAGE_18 = 1)
        _voltage = lnb switch { "15v" => 1, "11v" => 0, _ => null };
    }

    public Stream Output => _dvr;

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        // 選局し直す間は止める。前のチャンネルの残りが混ざったまま流れると、
        // 読む側 (denpa) には途中で中身が変わったようにしか見えない
        if (_streaming) Sys.Call(_demux, DmxStop, 0, "demux の停止");

        var properties = new List<(uint Command, uint Value)>
        {
            (DtvDeliverySystem, (uint)tuning.Delivery),
            (DtvFrequency, tuning.Frequency),
        };

        if (tuning.Satellite)
        {
            properties.Add((DtvStreamId, streamId));
            if (_voltage is not null) properties.Add((DtvVoltage, (uint)_voltage.Value));
        }
        else
        {
            properties.Add((DtvBandwidthHz, 6_000_000));
            // 地上波は階層が3つある。全部受ける (部分受信=ワンセグだけ、ではない)
            properties.Add((DtvIsdbtPartialReception, 0));
            properties.Add((DtvIsdbtSoundBroadcasting, 0));
            properties.Add((DtvIsdbtLayerEnabled, 0x07));
        }

        // これを最後に置いて初めて選局が始まる
        properties.Add((DtvTune, 0));

        SetProperties(properties);
        WaitForLock();

        // 全PID (0x2000) をそのまま dvr へ。選り分けるのは denpa の仕事
        StartFilter();
        _streaming = true;
    }

    private void SetProperties(List<(uint Command, uint Value)> properties)
    {
        var payload = new byte[PropertySize * properties.Count];
        for (var index = 0; index < properties.Count; index++)
        {
            var at = index * PropertySize;
            BitConverter.TryWriteBytes(payload.AsSpan(at), properties[index].Command);
            BitConverter.TryWriteBytes(payload.AsSpan(at + PropertyDataAt), properties[index].Value);
        }

        var payloadHandle = GCHandle.Alloc(payload, GCHandleType.Pinned);
        try
        {
            var header = new byte[16];
            BitConverter.TryWriteBytes(header.AsSpan(0), (uint)properties.Count);
            BitConverter.TryWriteBytes(header.AsSpan(8), payloadHandle.AddrOfPinnedObject().ToInt64());

            var headerHandle = GCHandle.Alloc(header, GCHandleType.Pinned);
            try
            {
                Sys.Call(_frontend, FeSetProperty, headerHandle.AddrOfPinnedObject(), "選局");
            }
            finally
            {
                headerHandle.Free();
            }
        }
        finally
        {
            payloadHandle.Free();
        }
    }

    /// <summary>
    /// 同期するまで待つ。
    ///
    /// <para>
    /// **待たずに読み始めてはいけない。** 同期前の dvr からは何も出ないか、
    /// 崩れたものが出る。総当たりのスキャンはここで諦める時間がそのまま
    /// 一周の長さになるので、短めにしてある。
    /// </para>
    /// </summary>
    private void WaitForLock()
    {
        var status = new byte[4];
        var handle = GCHandle.Alloc(status, GCHandleType.Pinned);
        try
        {
            var deadline = DateTime.UtcNow + LockTimeout;
            while (DateTime.UtcNow < deadline)
            {
                // 細かく見る。同期は 200ms ほどで来るので、100ms 刻みだと
                // その半分が待つだけの時間になる (カーネルは選局のたびに
                // status を 0 に戻すので、前のチャンネルの同期を拾うことはない)
                Thread.Sleep(10);
                if (Sys.Ioctl((int)_frontend.DangerousGetHandle(), FeReadStatus, handle.AddrOfPinnedObject()) < 0)
                {
                    continue;
                }
                if ((BitConverter.ToUInt32(status) & FeHasLock) != 0) return;
            }
        }
        finally
        {
            handle.Free();
        }

        throw new IOException("同期しませんでした (電波が来ていないか、その周波数に放送がありません)");
    }

    private void StartFilter()
    {
        Sys.Call(_demux, DmxSetBufferSize, DemuxBuffer, "demux の溜めの指定");

        // struct dmx_pes_filter_params { __u16 pid; enum input; enum output; enum pes_type; __u32 flags; }
        var filter = new byte[20];
        BitConverter.TryWriteBytes(filter.AsSpan(0), AllPids);
        BitConverter.TryWriteBytes(filter.AsSpan(4), DmxInFrontend);
        BitConverter.TryWriteBytes(filter.AsSpan(8), DmxOutTsTap);
        BitConverter.TryWriteBytes(filter.AsSpan(12), DmxPesOther);
        BitConverter.TryWriteBytes(filter.AsSpan(16), DmxImmediateStart);

        var handle = GCHandle.Alloc(filter, GCHandleType.Pinned);
        try
        {
            Sys.Call(_demux, DmxSetPesFilter, handle.AddrOfPinnedObject(), "demux の指定");
        }
        finally
        {
            handle.Free();
        }

        Sys.Call(_demux, DmxStart, 0, "demux の開始");
    }

    /// <summary>`/dev/dvb/adapter0/frontend0` を「どの adapter の何番目か」に割る</summary>
    internal static (string Adapter, string Number) Split(string frontend)
    {
        var name = Path.GetFileName(frontend);
        if (!name.StartsWith("frontend", StringComparison.Ordinal))
        {
            throw new ArgumentException($"DVB のデバイスではありません: {frontend}");
        }
        return (Path.GetDirectoryName(frontend) ?? "/dev/dvb/adapter0", name["frontend".Length..]);
    }

    public void Dispose()
    {
        // 先に読み口を閉じる。demux を止めてから閉じると、dvr で待っている
        // 読み手が誰にも起こされないまま残る
        _dvr.Dispose();
        _demux.Dispose();
        _frontend.Dispose();
    }
}

/// <summary>
/// <c>px4_drv</c> の chardev で掴む。PX4/PX5/PX-MLT 系。
///
/// <para>
/// DVB より単純で、**fd が1つ**。frontend も demux も dvr も分かれていない。
/// 衛星のスロット (<c>BS01_0</c> と <c>BS01_1</c> の違い) も選局と同時に渡せる。
/// </para>
///
/// <para>
/// **実機で試せていない。** ここにある機材は PT3 (DVB) だけで、chardev の
/// デバイスは1つも無い。値は <c>px4_drv</c> と <c>recisdb</c> の
/// <c>character_device.rs</c> から取ってある
/// </para>
/// </summary>
public sealed class Px4Tuner : ITuneDevice
{
    private const uint PtxSetChannel = 0x40088d01;   // _IOW(0x8d, 0x01, struct ptx_freq)
    private const uint PtxStartStreaming = 0x8d02;   // _IO(0x8d, 0x02)
    private const uint PtxStopStreaming = 0x8d03;    // _IO(0x8d, 0x03)
    private const uint PtxEnableLnb = 0x40048d05;    // _IOW(0x8d, 0x05, int)
    private const uint PtxDisableLnb = 0x8d06;       // _IO(0x8d, 0x06)

    private readonly SafeFileHandle _device;
    private readonly DeviceStream _stream;
    private readonly int? _voltage;
    private bool _streaming;

    public Px4Tuner(string device, string? lnb)
    {
        _device = Sys.Must(device, Sys.ReadOnly);
        _stream = new DeviceStream(Sys.Must(device, Sys.ReadOnly | Sys.NonBlocking));
        // 1 = 11V, 2 = 15V (DVB の SEC_VOLTAGE とは別の数え方)
        _voltage = lnb switch { "15v" => 2, "11v" => 1, _ => null };
    }

    public Stream Output => _stream;

    public void Tune(ChannelTable.Tuning tuning, uint streamId)
    {
        if (_streaming) Sys.Call(_device, PtxStopStreaming, 0, "受信の停止");

        // struct ptx_freq { int freq_no; int slot; }
        var frequency = new byte[8];
        BitConverter.TryWriteBytes(frequency.AsSpan(0), tuning.FreqNo);
        BitConverter.TryWriteBytes(frequency.AsSpan(4), tuning.Slot);

        var handle = GCHandle.Alloc(frequency, GCHandleType.Pinned);
        try
        {
            Sys.Call(_device, PtxSetChannel, handle.AddrOfPinnedObject(), "選局");
        }
        finally
        {
            handle.Free();
        }

        if (tuning.Satellite && _voltage is not null)
        {
            Sys.Call(_device, PtxEnableLnb, _voltage.Value, "LNB への給電");
        }

        Sys.Call(_device, PtxStartStreaming, 0, "受信の開始");
        _streaming = true;
    }

    public void Dispose()
    {
        if (_voltage is not null) Sys.Ioctl((int)_device.DangerousGetHandle(), PtxDisableLnb, 0);
        _stream.Dispose();
        _device.Dispose();
    }
}
