using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// ARIB STD-B25 を自分で解く。**<c>recisdb</c> を起こさずに済ませるための最後の一片。**
///
/// <para>
/// 借りるのは <a href="https://github.com/tsukumijima/libaribb25">libaribb25</a>。
/// **いま実機で解けているものそのもの**で、<c>recisdb</c> も
/// recisdb-rs → <c>b25-sys</c> → libaribb25 と積んでいる。差し替えても
/// 復号の挙動が変わらないのが何よりの利点 (docs/agent.md)。
/// </para>
///
/// <para>
/// 呼び方は関数ポインタの表。<c>create_arib_std_b25()</c> が返す構造体の
/// 中身がそのまま関数ポインタで、C# からは <c>delegate* unmanaged</c> で
/// 直に呼べる。<c>Marshal.GetDelegateForFunctionPointer</c> は使わない
/// (遅いうえ AOT で気を遣う)。
/// </para>
///
/// <para>
/// **カードは差し替えられる。** libaribb25 の口 (<c>B_CAS_CARD</c>) も
/// 関数ポインタの表なので、<c>proc_ecm</c> だけ別のところへ投げる実装を
/// 後から挿せる。1枚のカードを別のマシンのチューナーからも使いたい、という
/// ときはここに入る (docs/agent.md)。
/// </para>
/// </summary>
public sealed unsafe partial class AribB25 : IDisposable
{
    /// <summary>MULTI2 のラウンド数。放送は 4。<c>recisdb</c> の既定と同じ</summary>
    private const int Multi2Round = 4;

    [StructLayout(LayoutKind.Sequential)]
    private struct Buffer
    {
        public byte* Data;
        public uint Size;
    }

    /// <summary>`arib_std_b25.h` の <c>ARIB_STD_B25</c>。**並びを変えると黙って壊れる**</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct StdB25
    {
        public void* PrivateData;
        public delegate* unmanaged<StdB25*, void> Release;
        public delegate* unmanaged<StdB25*, int, int> SetMulti2Round;
        public delegate* unmanaged<StdB25*, int, int> SetStrip;
        public delegate* unmanaged<StdB25*, int, int> SetEmmProc;
        public delegate* unmanaged<StdB25*, int, int> SetSimdMode;
        public delegate* unmanaged<StdB25*, int> GetSimdMode;
        public delegate* unmanaged<StdB25*, CasCard*, int> SetBCasCard;
        public delegate* unmanaged<StdB25*, int, int> SetUnitSize;
        public delegate* unmanaged<StdB25*, int> Reset;
        public delegate* unmanaged<StdB25*, int> Flush;
        public delegate* unmanaged<StdB25*, Buffer*, int> Put;
        public delegate* unmanaged<StdB25*, Buffer*, int> Get;
        public delegate* unmanaged<StdB25*, int> GetProgramCount;
        public delegate* unmanaged<StdB25*, void*, int, int> GetProgramInfo;
        public delegate* unmanaged<StdB25*, Buffer*, int> Withdraw;
    }

    /// <summary>`b_cas_card.h` の <c>B_CAS_CARD</c></summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct CasCard
    {
        public void* PrivateData;
        public delegate* unmanaged<CasCard*, void> Release;
        public delegate* unmanaged<CasCard*, int> Init;
        public delegate* unmanaged<CasCard*, void*, int> GetInitStatus;
        public delegate* unmanaged<CasCard*, CardId*, int> GetId;
        public delegate* unmanaged<CasCard*, void*, int> GetPowerOnControl;
        public delegate* unmanaged<CasCard*, void*, byte*, int, int> ProcEcm;
        public delegate* unmanaged<CasCard*, byte*, int, int> ProcEmm;
        public delegate* unmanaged<CasCard*, int, int> SetAcasMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct CardId
    {
        public long* Data;
        public int Count;
    }

    [LibraryImport("aribb25", EntryPoint = "create_arib_std_b25")]
    private static partial StdB25* CreateStdB25();

    [LibraryImport("aribb25", EntryPoint = "create_b_cas_card")]
    private static partial CasCard* CreateCasCard();

    private readonly StdB25* _b25;
    private readonly CasCard* _card;

    /// <summary>
    /// **libaribb25 はスレッドセーフではない。** 1つの実体を2本の流れから
    /// 同時に叩くと、中の節リストが壊れて**プロセスごと落ちる**
    /// (実機で <c>double free or corruption</c>。docs/agent.md)。
    ///
    /// <para>
    /// 実体は**チューナー1本につき1つ**で、選局を跨いで持ち回している
    /// (<c>TunerPool.Held</c>)。掴んでいる選局は常に1つのはずだが、
    /// 前の読み手が止まりきる前に次が始まる窓が実際にあった。ここで順番に
    /// すれば、**その窓が開いていても壊れない。**
    /// </para>
    ///
    /// <para>
    /// 待たされるのは MULTI2 の復号1回ぶんなので、実害は無い。
    /// </para>
    /// </summary>
    private readonly Lock _gate = new();

    /// <summary>
    /// 2本目が入ってこようとした回数。**0 でないなら、上の窓が実際に開いている。**
    /// 静かに直しただけでは、直ったのか元々起きていなかったのか分からない
    /// </summary>
    private int _contended;

    /// <summary>壊れた疑いがある。**次の選局では作り直す** (<c>TunerPool.Acquire</c>)</summary>
    public bool Broken { get; private set; }

    private AribB25(StdB25* b25, CasCard* card)
    {
        _b25 = b25;
        _card = card;
    }

    /// <summary>取り合いが起きた回数。聞いたら 0 に戻す</summary>
    public int TakeContended() => Interlocked.Exchange(ref _contended, 0);

    /// <summary>順番に通す。**取り合いが起きたら数える** (上の説明) */</summary>
    private Guard Enter()
    {
        if (!_gate.TryEnter())
        {
            Interlocked.Increment(ref _contended);
            _gate.Enter();
        }
        return new Guard(_gate);
    }

    private readonly ref struct Guard(Lock gate)
    {
        public void Dispose() => gate.Exit();
    }

    /// <summary>
    /// カードを開いて、解く用意をする。
    ///
    /// <para>
    /// **開けなければ投げる。** 掛かったまま流すかどうかを決めるのは呼んだ側で、
    /// ここで黙って素通しにはしない — いまの <c>recisdb</c> はカードが開けないと
    /// 黙って素通しするので、「録画は成功しているのに中身が全部スクランブル」
    /// という分かりにくい壊れ方をする (Card.cs)。
    /// </para>
    /// </summary>
    /// <param name="cardUrl">
    /// 鍵を配ってくれる相手。**手元にカードが無い拠点だけ**指定する
    /// (<see cref="Remote"/>)。空なら自分に刺さっているカードを読む
    /// </param>
    public static AribB25 Open(string? cardUrl = null)
    {
        var b25 = CreateStdB25();
        if (b25 is null) throw new IOException("libaribb25 を用意できません");

        var card = cardUrl is { Length: > 0 } ? Remote.Create(cardUrl) : CreateCasCard();
        if (card is null)
        {
            b25->Release(b25);
            throw new IOException("カードの口を用意できません");
        }

        var opened = card->Init(card);
        if (opened < 0)
        {
            card->Release(card);
            b25->Release(b25);
            throw new IOException($"カードを読めません ({CardError(opened)})");
        }

        b25->SetMulti2Round(b25, Multi2Round);
        // 掛かったままのパケットも落とさずに通す。**録れないよりまし** で、
        // 解けなかったことは denpa 側が見て分かる (中身を見るのはあちら)
        b25->SetStrip(b25, 0);
        // EMM (契約情報の書き換え) は扱わない。読むだけの側がやることではない
        b25->SetEmmProc(b25, 0);
        b25->SetBCasCard(b25, card);

        return new AribB25(b25, card);
    }

    /// <summary>
    /// 掛かっているところを解く。
    ///
    /// <para>
    /// **返ってくるのは libaribb25 の中の場所。** 次に <see cref="Decode"/> を
    /// 呼ぶまでしか生きていないので、呼んだ側はその場で書き出すか写す。
    /// </para>
    ///
    /// <para>
    /// 入れた長さと出てくる長さは揃わない。ECM が来て鍵が決まるまで中に
    /// 溜まるので、**始めのうちは何も出てこない**。
    /// </para>
    /// </summary>
    public ReadOnlySpan<byte> Decode(ReadOnlySpan<byte> chunk)
    {
        using var _ = Enter();

        fixed (byte* source = chunk)
        {
            var input = new Buffer { Data = source, Size = (uint)chunk.Length };
            var code = _b25->Put(_b25, &input);
            if (code < 0) throw Failed(code);
        }

        var output = default(Buffer);
        var got = _b25->Get(_b25, &output);
        if (got < 0) throw Failed(got);

        return output.Data is null ? [] : new ReadOnlySpan<byte>(output.Data, (int)output.Size);
    }

    /// <summary>
    /// 解けなかった。**この実体はもう使わない。**
    ///
    /// <para>
    /// 途中で投げたということは、中の解析が半端なところで止まっている。
    /// そのまま次の選局で <see cref="Reset"/> して使い回していた頃に、
    /// 実機で ECM の解析に失敗した直後**プロセスごと落ちた**。壊れているかも
    /// しれないものを持ち回るより、作り直すほうが安い。
    /// </para>
    /// </summary>
    private IOException Failed(int code)
    {
        Broken = true;
        return new IOException($"復号に失敗しました ({Error(code)})");
    }

    /// <summary>
    /// 中身を忘れる。**チャンネルを変えたとき。**
    ///
    /// <para>
    /// 掴んだまま選局し直すと、前のチャンネルの PMT と鍵が残ったままになる。
    /// 忘れさせないと、次のチャンネルの ECM が来るまで前の鍵で解こうとする。
    /// </para>
    /// </summary>
    public void Reset()
    {
        using var _ = Enter();
        _b25->Reset(_b25);
    }

    /// <summary>中に溜まっている分を吐き出す。**終わりに1回**</summary>
    public ReadOnlySpan<byte> Flush()
    {
        using var _ = Enter();

        // flush は「中で止めているものを出口まで進める」だけ。受け取るのは get
        if (_b25->Flush(_b25) < 0) return [];

        var output = default(Buffer);
        if (_b25->Get(_b25, &output) < 0) return [];
        return output.Data is null ? [] : new ReadOnlySpan<byte>(output.Data, (int)output.Size);
    }

    /// <summary>
    /// カードの番号。**カードが本当に読めているかの証拠**になる。
    ///
    /// <para>
    /// pcscd が動いていてもリーダーを掴めていないことがあり、そのときは
    /// ここが空になる (Card.cs)。
    /// </para>
    /// </summary>
    public string[] Ids()
    {
        using var _ = Enter();

        var id = default(CardId);
        if (_card->GetId(_card, &id) < 0 || id.Data is null) return [];

        var found = new string[id.Count];
        for (var index = 0; index < id.Count; index++)
        {
            found[index] = id.Data[index].ToString("D16");
        }
        return found;
    }

    private static string Error(int code) => code switch
    {
        -3 => "TS ではありません",
        -4 => "PAT が見つかりません",
        -5 => "PMT が見つかりません",
        -6 => "ECM が見つかりません",
        -7 => "カードが刺さっていません",
        -8 => "カードの状態が正しくありません",
        -9 => "カードが ECM を返しません (契約か、リーダーの不調)",
        -10 => "鍵が合いません",
        _ => $"コード {code}",
    };

    private static string CardError(int code) => code switch
    {
        -2 => "初期化されていません",
        -3 => "カードリーダーが見えません (pcscd は動いていますか)",
        -4 => "どのリーダーにも繋がりません",
        -6 => "カードとのやり取りに失敗しました",
        _ => $"コード {code}",
    };

    public void Dispose()
    {
        // 読んでいる最中に手放さない。**閉じるのも順番のうち**
        using var _ = Enter();
        _b25->Release(_b25);
        _card->Release(_card);
    }
}
