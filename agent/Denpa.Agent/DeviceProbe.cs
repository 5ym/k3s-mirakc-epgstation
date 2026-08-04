using System.Runtime.InteropServices;
using System.Text;

namespace Denpa.Agent;

/// <summary>
/// 繋いであるチューナーを自分で見つける。**設定を書かなくてよくする。**
///
/// <para>
/// 本数はデバイスの数を数えれば分かるが、**種別 (地上波か衛星か) はどこにも
/// 書かれていない。** sysfs には出ておらず (実機で確認: `dev` `device` `power`
/// `subsystem` `uevent` しか無く、4本とも同じ PCI デバイスの下にぶら下がる)、
/// `recisdb` にも列挙の口が無い。ioctl で聞くしかない。
/// </para>
///
/// <para>
/// bun のままでは書けなかったところで、.NET にした利点がそのまま出ている。
/// </para>
///
/// <para>
/// 数と並びは実機 (PT3 / `earth_pt3` / Ubuntu 24.04) で測った値。
/// </para>
///
/// <code>
/// sizeof dvb_frontend_info = 168   FE_GET_INFO     = 0x80a86f3d
/// sizeof dtv_property      =  76   FE_GET_PROPERTY = 0x80106f53
/// sizeof dtv_properties    =  16   DTV_ENUM_DELSYS = 44
/// u.buffer.data @16   u.buffer.len @48
///
/// adapter0 "Toshiba TC90522 ISDB-S module" delsys=[9]
/// adapter1 "Toshiba TC90522 ISDB-T module" delsys=[8]
/// </code>
/// </summary>
public static partial class DeviceProbe
{
    // linux/dvb/frontend.h。実機で測った値をそのまま置く
    private const uint FeGetInfo = 0x80a86f3d;
    private const uint FeGetProperty = 0x80106f53;
    private const uint DtvEnumDelsys = 44;

    private const int FrontendInfoSize = 168;
    private const int PropertySize = 76;
    private const int BufferDataAt = 16;
    private const int BufferLenAt = 48;
    private const int NameLength = 128;

    private const int SysIsdbt = 8;
    private const int SysIsdbs = 9;
    private const int SysIsdbc = 10;

    private const int OReadOnly = 0;
    private const int ONonBlock = 0x800;

    [LibraryImport("libc", EntryPoint = "open", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    private static partial int Open(string path, int flags);

    [LibraryImport("libc", EntryPoint = "close")]
    private static partial int Close(int fd);

    [LibraryImport("libc", EntryPoint = "ioctl", SetLastError = true)]
    private static partial int Ioctl(int fd, nuint request, nint argument);

    /// <summary>
    /// 受けられる方式から denpa の種別に直す。
    ///
    /// <para>
    /// ISDB-S は BS と CS の両方に使う (どちらも同じ復調)。ISDB-C はケーブルで、
    /// この構成では出てこないが、来たら CS として扱う。
    /// </para>
    /// </summary>
    public static string[] TypesFor(IEnumerable<int> delivery)
    {
        var types = new List<string>();
        foreach (var system in delivery)
        {
            if (system == SysIsdbt && !types.Contains("GR")) types.Add("GR");
            if (system == SysIsdbs)
            {
                if (!types.Contains("BS")) types.Add("BS");
                if (!types.Contains("CS")) types.Add("CS");
            }
            if (system == SysIsdbc && !types.Contains("CS")) types.Add("CS");
        }
        return [.. types];
    }

    /// <summary>
    /// 名前からの当てずっぽう。**ioctl が答えなかったときだけ。**
    ///
    /// <para>
    /// 実機の名前は "Toshiba TC90522 ISDB-S module"。方式が名前に入っている
    /// ドライバは多いが、入っていないものもあるので当てにはしない。
    /// </para>
    /// </summary>
    public static string[] TypesFromName(string name)
    {
        var upper = name.ToUpperInvariant();
        if (upper.Contains("ISDB-T") || upper.Contains("ISDBT")) return ["GR"];
        if (upper.Contains("ISDB-S") || upper.Contains("ISDBS")) return ["BS", "CS"];
        return [];
    }

    /// <summary>`dvb_frontend_info.name` は先頭 128 バイト、NUL で終わる</summary>
    public static string ParseName(ReadOnlySpan<byte> info)
    {
        var end = info[..NameLength].IndexOf((byte)0);
        return Encoding.UTF8.GetString(info[..(end < 0 ? NameLength : end)]);
    }

    /// <summary>`dtv_property.u.buffer` から方式の並びを取り出す</summary>
    public static int[] ParseDelivery(ReadOnlySpan<byte> property)
    {
        var length = (int)BitConverter.ToUInt32(property[BufferLenAt..]);
        if (length is <= 0 or > 32) return [];
        return [.. property.Slice(BufferDataAt, length).ToArray().Select(value => (int)value)];
    }

    /// <summary>
    /// chardev のデバイス名から種別を当てる (`px4_drv`)。
    ///
    /// <para>
    /// **こちらは ioctl で聞けない。** DVB と違って方式を答える口が無く、
    /// 名前と番号の決まりがそのまま種別になっている。合わなければ
    /// 画面から書いて上書きしてもらう。
    /// </para>
    /// </summary>
    public static string[] TypesForChardev(string name)
    {
        // PX-W3U4 / W3PE4 など: 0,1 が衛星で 2,3 が地上波
        if (name.StartsWith("px4video", StringComparison.Ordinal))
        {
            return name[^1] is '0' or '1' ? ["BS", "CS"] : ["GR"];
        }
        // PX-MLT5PE / ISDB2056 など: 1本でどちらも受けられる
        if (name.StartsWith("pxmlt", StringComparison.Ordinal)
            || name.StartsWith("isdb2056video", StringComparison.Ordinal)
            || name.StartsWith("isdb6014video", StringComparison.Ordinal))
        {
            return ["GR", "BS", "CS"];
        }
        return [];
    }

    private static string[] Ask(string device)
    {
        var fd = Open(device, OReadOnly | ONonBlock);
        if (fd < 0) return [];
        try
        {
            var property = new byte[PropertySize];
            BitConverter.TryWriteBytes(property, DtvEnumDelsys);

            var handle = GCHandle.Alloc(property, GCHandleType.Pinned);
            var header = new byte[16];
            try
            {
                BitConverter.TryWriteBytes(header.AsSpan(0), 1u);
                BitConverter.TryWriteBytes(header.AsSpan(8), handle.AddrOfPinnedObject().ToInt64());
                var headerHandle = GCHandle.Alloc(header, GCHandleType.Pinned);
                try
                {
                    if (Ioctl(fd, FeGetProperty, headerHandle.AddrOfPinnedObject()) >= 0)
                    {
                        var types = TypesFor(ParseDelivery(property));
                        if (types.Length > 0) return types;
                    }
                }
                finally
                {
                    headerHandle.Free();
                }
            }
            finally
            {
                handle.Free();
            }

            // 方式を答えないドライバもある。名前で当てにいく
            var info = new byte[FrontendInfoSize];
            var infoHandle = GCHandle.Alloc(info, GCHandleType.Pinned);
            try
            {
                if (Ioctl(fd, FeGetInfo, infoHandle.AddrOfPinnedObject()) < 0) return [];
                return TypesFromName(ParseName(info));
            }
            finally
            {
                infoHandle.Free();
            }
        }
        finally
        {
            Close(fd);
        }
    }

    /// <summary>
    /// 見つかった機材を、設定に書いたのと同じ形にして返す。
    ///
    /// <para>
    /// 分かるのは**デバイスと受けられる方式**だけ。LNB を足したい・1本だけ
    /// 止めたい、は人にしか決められないので、そこは画面から書いてもらう
    /// (書いてあればそちらが勝つ)。
    /// </para>
    /// </summary>
    public static List<TunerSpec> Detect()
    {
        var found = new List<TunerSpec>();

        foreach (var adapter in Directories("/dev/dvb", "adapter*"))
        {
            foreach (var frontend in Files(adapter, "frontend*"))
            {
                var types = Ask(frontend);
                if (types.Length == 0) continue;
                found.Add(new TunerSpec(Path.GetFileName(adapter), types, false, frontend));
            }
        }

        foreach (var device in Files("/dev", "px4video*").Concat(Files("/dev", "pxmlt*"))
            .Concat(Files("/dev", "isdb*video*")).Order(StringComparer.Ordinal))
        {
            var name = Path.GetFileName(device);
            var types = TypesForChardev(name);
            if (types.Length == 0) continue;
            found.Add(new TunerSpec(name, types, false, device));
        }

        return found;
    }

    private static IEnumerable<string> Directories(string root, string pattern)
    {
        if (!Directory.Exists(root)) return [];
        return Directory.EnumerateDirectories(root, pattern).Order(StringComparer.Ordinal);
    }

    private static IEnumerable<string> Files(string root, string pattern)
    {
        if (!Directory.Exists(root)) return [];
        return Directory.EnumerateFiles(root, pattern).Order(StringComparer.Ordinal);
    }
}
