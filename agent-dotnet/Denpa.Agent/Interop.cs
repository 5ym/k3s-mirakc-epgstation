using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// 選局コマンドを**プロセスグループごと**終わらせる。
///
/// <para>
/// プロセスを1つ殺すだけでは足りない。`sh -c` に渡すのがパイプラインだと、
/// sh を殺しても recisdb は生き残ってチューナーを掴んだままになり、次の
/// チャンネルが「デバイスが使用中」で失敗し続ける。
/// </para>
///
/// <para>
/// <c>setsid</c> で起こしてあるので、子のPIDがそのままグループIDになっている。
/// 負のPIDで送ると、そのグループ全体に届く。
/// </para>
/// </summary>
public static partial class Interop
{
    private const int Sigterm = 15;
    private const int Sigkill = 9;

    /// <summary>止めるときの猶予。過ぎたら SIGKILL</summary>
    private static readonly TimeSpan KillGrace = TimeSpan.FromSeconds(3);

    [LibraryImport("libc", SetLastError = true)]
    private static partial int kill(int pid, int sig);

    public static void KillGroup(int pid)
    {
        kill(-pid, Sigterm);
        _ = Task.Delay(KillGrace).ContinueWith(_ => kill(-pid, Sigkill), TaskScheduler.Default);
    }
}
