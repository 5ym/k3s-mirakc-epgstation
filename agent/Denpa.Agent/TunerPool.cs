using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace Denpa.Agent;

/// <summary>
/// 選局の仕方。
/// </summary>
/// <param name="CardUrl">鍵を配ってくれる相手。手元にカードが無い拠点だけ (CardShare.cs)</param>
/// <param name="StreamIds">チャンネル名から TSID を引く。衛星の選局に要る</param>
public sealed record TuneOptions(string? CardUrl, Func<string, int?> StreamIds)
{
    public static TuneOptions None => new(null, _ => null);
}

/// <summary>
/// チューナーの取り合い。**エージェントの本体はここ。**
///
/// <para>
/// mirakc がやっていた「誰にどのチューナーを渡すか」を引き取ったもの。
/// bun 版 (<c>agent/tuners.ts</c>) の移し替えで、決まりは1つも変えていない。
/// </para>
///
/// <list type="bullet">
/// <item>**優先度に下限が無い。** mirakc は負値を 0 に丸め、−1 は自分の番組表集めに使っていた</item>
/// <item>**番組表集めが特別扱いされない。** 録画もロゴも番組表も同じ「開きたい人」で、priority だけで並ぶ</item>
/// <item>**同じ物理チャンネルなら1本で足りる。** 番組表・ロゴ・録画が同じ選局に相乗りする</item>
/// </list>
///
/// <para>
/// 選局は**自分で掴む**。ioctl で選局して B25 も自分で解き、掴んだまま
/// チャンネルだけ変える (Tuning.cs / AribB25.cs)。外のコマンドを起こすのは
/// 設定に <c>command</c> が書いてあるときだけで、**<c>recisdb</c> は要らない**。
/// </para>
/// </summary>
public sealed class TunerPool(
    IReadOnlyList<TunerSpec> specs, Action onChange, TuneOptions? tune = null)
{
    private readonly TuneOptions _tune = tune ?? TuneOptions.None;

    /// <summary>誰も読まなくなってから選局を畳むまでの間</summary>
    public static readonly TimeSpan Linger = TimeSpan.FromSeconds(5);

    /// <summary>読む側が遅れてよい上限 (バイト)</summary>
    public const long MaxLag = 64L * 1024 * 1024;

    private readonly Lock _gate = new();
    private readonly Dictionary<int, Lease> _leases = [];

    /// <summary>
    /// **開きっぱなしのデバイス。チューナー1本につき1つ。**
    ///
    /// <para>
    /// ここが選局 (lease) ごとではなく**チューナーごと**なのが肝。チャンネルを
    /// 変えるたびに開き直すと、前の選局がまだ持っているデバイスを開こうとして
    /// <c>Device or resource busy</c> で落ちる。実際そうなっていて、スキャンが
    /// 1チャンネル目以降ぜんぶ落ちた (docs/roadmap.md)。
    /// </para>
    /// </summary>
    private readonly Dictionary<int, Held> _held = [];

    /// <summary>
    /// <see cref="_held"/> を出し入れする間の錠。**取り合い (<see cref="_gate"/>) とは別。**
    ///
    /// <para>
    /// 選局は取り合いの錠を放してからやる (<see cref="Open"/>)。そのぶん、この
    /// 入れ物には錠のかかっていない道から触られることになるので、ここで守る。
    /// 掴む/手放すだけなので、待たされるのは一瞬。
    /// </para>
    /// </summary>
    private readonly Lock _deviceGate = new();

    /// <summary>1本ぶんの実体。**閉じるのは定義が変わったときと、止めるときだけ**</summary>
    private sealed class Held(ITuneDevice device, AribB25? b25) : IDisposable
    {
        public ITuneDevice Device { get; } = device;
        public AribB25? B25 { get; } = b25;

        /// <summary>
        /// **この1本を選局し直す間の錠。本ごとに別**なので、他の本は待たない。
        ///
        /// <para>
        /// 選局の最中に、優先度の高い要求が同じ本を取り上げることがある。
        /// その相手が続けて選局を始めると、1つのデバイスに2つの選局が同時に
        /// 入ることになるので、ここで順番にする。
        /// </para>
        /// </summary>
        public Lock Gate { get; } = new();

        /// <summary>いま合わせているところ。**同じなら選局し直さない**</summary>
        public string? Channel { get; set; }

        public void Dispose()
        {
            Device.Dispose();
            B25?.Dispose();
        }
    }

    private IReadOnlyList<TunerSpec> _specs = specs;

    public IReadOnlyList<TunerSpec> Tuners => _specs;

    /// <summary>自動検出で決めたのか、書いてあるものを読んだのか。画面に出す</summary>
    public bool Detected { get; set; }

    /// <summary>
    /// 機材の定義を入れ替える。**画面から書き換えたとき。**
    ///
    /// <para>
    /// 走っている選局は**そのまま続ける**。名前が変わった・消えた本のものだけ、
    /// 失敗として畳む — 掴んでいるデバイスが別物になったのに流し続けると、
    /// 何が録れているのか分からなくなる。
    /// </para>
    /// </summary>
    public void Replace(IReadOnlyList<TunerSpec> next)
    {
        lock (_gate)
        {
            var before = _specs;
            _specs = next;
            foreach (var (index, lease) in _leases.ToList())
            {
                var was = index < before.Count ? before[index].Name : null;
                var now = index < next.Count ? next[index].Name : null;
                if (was == now && now is not null) continue;
                Release(lease, "チューナーの設定が変わりました");
                // 別の機材になったかもしれない。掴み直す
                Drop(index);
            }
        }
        onChange();
    }

    public sealed class TunerBusyException(string message) : Exception(message);

    /// <summary>
    /// 選局して読み口を返す。掴めなければ <see cref="TunerBusyException"/>。
    ///
    /// <para>同じ物理チャンネルが既に開いていればそこへ混ぜる。**チューナーは増えない。**</para>
    /// </summary>
    public Sink Open(string type, string channel, int priority, string use)
    {
        int index;
        TunerSpec spec;
        Lease lease;
        Sink sink;

        lock (_gate)
        {
            foreach (var open in _leases.Values)
            {
                if (open.Type == type && open.Channel == channel) return Join(open, priority, use);
            }

            index = Pick(type, priority) ?? throw new TunerBusyException($"{type} のチューナーに空きがありません");

            // 蹴る相手が居れば先に片付ける。同じチューナーを2つの選局が掴まないように
            if (_leases.TryGetValue(index, out var victim)) Release(victim, "優先度の高い要求に譲りました");

            spec = Tuners[index];
            lease = new Lease(index, type, channel);
            _leases[index] = lease;
            /*
             * **読み手を入れてから錠を放す。** 選局はこの下、錠の外でやるので、
             * 入れないまま放すと `Pick` に「誰も読んでいない本」と見えて、
             * まだ選局している最中のチューナーを次の要求が持っていく
             */
            sink = Join(lease, priority, use);
        }

        /*
         * **選局は取り合いの錠を放してからやる。**
         *
         * 電波が来ていないチャンネルでは同期待ちに5秒かかる (Tuning.cs)。
         * 掴んだままにすると、その5秒のあいだ `/denpa/tuners` も、他の本への
         * 要求も止まる。実際そうなっていて、
         *
         * - チューナーが2本あっても総当たりは1本ずつしか進まなかった
         * - スキャンを始めてもチューナー画面が「空き」のまま動かなかった
         *
         * ここから先で触るのは、上で押さえた自分の本だけ。
         */
        try
        {
            /*
             * **既定は自分で掴む。** 外のコマンドを起こすのは、設定に
             * `command` が書いてあるときだけ (変わった機材と、試すときの逃げ道。
             * 偽の選局コマンドで走る適合テストもこの道を通る)。
             */
            var command = spec.Resolve();
            if (command is null)
            {
                var held = Acquire(index, spec);
                lock (held.Gate)
                {
                    if (held.Channel != channel)
                    {
                        var tuning = ChannelTable.Parse(channel)
                            ?? throw new IOException($"{channel} は選局表にありません");
                        // 途中で落ちたら「どこにも合っていない」。次は必ず選局し直す
                        held.Channel = null;
                        held.Device.Tune(tuning, ChannelTable.StreamId(channel, tuning, _tune.StreamIds));
                        // 前のチャンネルの PMT と鍵を忘れさせる
                        held.B25?.Reset();
                        held.Channel = channel;
                    }
                    lease.StartNative(held.Device, held.B25, () => OnExit(index, lease));
                }
            }
            else
            {
                lease.Start(Render(command, channel, type), () => OnExit(index, lease));
            }
        }
        catch (Exception error)
        {
            /*
             * **デバイスは閉じない。** 電波が来ていないチャンネルでは選局が
             * 失敗するのが普通で、そのたびに閉じていると次のチャンネルが
             * 「使用中」で開けなくなる (総当たりのスキャンが1本目以降ぜんぶ
             * 落ちたのはこれ)。次の選局で掴み直す
             */
            lock (_gate)
            {
                if (_leases.TryGetValue(index, out var mine) && mine == lease) _leases.Remove(index);
                lease.Sinks.Clear();
            }
            sink.Fail($"{spec.Name}: {error.Message}");
            onChange();
            throw new IOException($"{spec.Name}: {error.Message}");
        }
        return sink;
    }

    /// <summary>
    /// 開きっぱなしの実体を取り出す。**無ければ、そのとき1度だけ開く。**
    ///
    /// <para>
    /// カードが開けなくても選局はする。**掛かったままでも録るほうがまし**で、
    /// 電波は二度と戻ってこない (解けていないことは denpa 側が見て分かる)。
    /// </para>
    /// </summary>
    private Held Acquire(int index, TunerSpec spec)
    {
        lock (_deviceGate)
        {
            if (_held.TryGetValue(index, out var open)) return open;

            var path = spec.Device ?? throw new IOException($"{spec.Name} にデバイスが書かれていません");
            ITuneDevice device = path.Contains("/dvb/", StringComparison.Ordinal)
                ? new DvbTuner(path, spec.Lnb)
                : new Px4Tuner(path, spec.Lnb);

            AribB25? b25 = null;
            try
            {
                b25 = AribB25.Open(_tune.CardUrl);
            }
            catch (Exception error)
            {
                Log.Write($"[{spec.Name}] 解けません: {error.Message}");
            }

            var held = new Held(device, b25);
            _held[index] = held;
            Log.Write($"[{spec.Name}] {path} を掴みました");
            return held;
        }
    }

    /// <summary>実体を手放す。**定義が変わったときと、止めるときだけ**</summary>
    private void Drop(int index)
    {
        lock (_deviceGate)
        {
            if (!_held.Remove(index, out var held)) return;
            held.Dispose();
        }
    }

    private void OnExit(int index, Lease lease)
    {
        lock (_gate)
        {
            if (!_leases.TryGetValue(index, out var held) || held != lease) return;
            _leases.Remove(index);
            // 選局が落ちた。読み手には失敗として伝える (黙って終わると空ファイルになる)
            var reason = lease.Error is null ? "" : $" ({lease.Error})";
            foreach (var sink in lease.Sinks) sink.Fail($"選局が終了しました{reason}");
            lease.Sinks.Clear();
        }
        onChange();
    }

    private Sink Join(Lease lease, int priority, string use)
    {
        lease.CancelLinger();
        var sink = new Sink(use, priority, leaving =>
        {
            lock (_gate)
            {
                lease.Sinks.Remove(leaving);
                if (lease.Sinks.Count == 0) ScheduleRelease(lease);
            }
            onChange();
        });
        lease.Sinks.Add(sink);
        Task.Run(onChange);
        return sink;
    }

    private void ScheduleRelease(Lease lease)
    {
        lease.StartLinger(() =>
        {
            lock (_gate)
            {
                if (lease.Sinks.Count == 0) Release(lease, null);
            }
            onChange();
        }, Linger);
    }

    private void Release(Lease lease, string? reason)
    {
        lease.CancelLinger();
        if (_leases.TryGetValue(lease.Tuner, out var held) && held == lease) _leases.Remove(lease.Tuner);
        foreach (var sink in lease.Sinks)
        {
            if (reason is null) sink.End();
            else sink.Fail(reason);
        }
        lease.Sinks.Clear();
        lease.Kill();
    }

    /// <summary>
    /// どのチューナーを使うか決める。
    ///
    /// <list type="number">
    /// <item>空いているもの</item>
    /// <item>誰も読んでいないもの (畳むのを待っているだけ)</item>
    /// <item>自分より弱い相手が掴んでいるもの。いちばん弱いところから取る</item>
    /// </list>
    /// </summary>
    private int? Pick(string type, int priority)
    {
        var usable = Enumerable.Range(0, Tuners.Count)
            .Where(index => !Tuners[index].Disabled && Tuners[index].Types.Contains(type))
            .ToList();

        foreach (var index in usable)
        {
            if (!_leases.ContainsKey(index)) return index;
        }
        foreach (var index in usable)
        {
            if (_leases.TryGetValue(index, out var idle) && idle.Sinks.Count == 0) return index;
        }

        int? weakest = null;
        var lowest = priority;
        foreach (var index in usable)
        {
            if (!_leases.TryGetValue(index, out var held)) continue;
            if (held.Priority >= lowest) continue;
            weakest = index;
            lowest = held.Priority;
        }
        return weakest;
    }

    /// <summary>
    /// チューナー画面に出るもの。
    ///
    /// <para>
    /// 組み立てを <see cref="JsonNode"/> でやっているのは AOT のため。
    /// 匿名型を反射で書き出す道は、単一実行ファイルにすると使えない。
    /// </para>
    /// </summary>
    public JsonArray Status()
    {
        lock (_gate)
        {
            var list = new JsonArray();
            for (var index = 0; index < Tuners.Count; index++)
            {
                var spec = Tuners[index];
                _leases.TryGetValue(index, out var lease);

                var types = new JsonArray();
                foreach (var type in spec.Types) types.Add((JsonNode?)JsonValue.Create(type));

                var users = new JsonArray();
                if (lease is not null)
                {
                    foreach (var sink in lease.Sinks)
                    {
                        users.Add((JsonNode)new JsonObject { ["use"] = sink.Use, ["priority"] = sink.Priority });
                    }
                }

                list.Add((JsonNode)new JsonObject
                {
                    ["index"] = index,
                    ["name"] = spec.Name,
                    ["types"] = types,
                    ["disabled"] = spec.Disabled,
                    // 画面がそのまま編集できるように、定義もいっしょに返す
                    ["device"] = spec.Device,
                    ["lnb"] = spec.Lnb,
                    // 直に書いた逃げ道。**画面からは触らせない** (読めるだけ)
                    ["command"] = spec.Command,
                    ["channel"] = lease is null
                        ? null
                        : new JsonObject { ["type"] = lease.Type, ["channel"] = lease.Channel },
                    ["users"] = users,
                    ["pid"] = lease?.Pid,
                    ["error"] = lease?.Error,
                });
            }
            return list;
        }
    }

    /// <summary>全部畳む。止めるときに使う</summary>
    public void CloseAll()
    {
        lock (_gate)
        {
            foreach (var lease in _leases.Values.ToList()) Release(lease, "停止します");
            foreach (var index in _held.Keys.ToList()) Drop(index);
        }
    }

    /// <summary>チューナーコマンドの <c>{{channel}}</c> を埋める。mirakc の書き方をそのまま受ける</summary>
    public static string Render(string command, string channel, string type)
    {
        return System.Text.RegularExpressions.Regex.Replace(
            command,
            @"\{\{\{?\s*([a-z_]+)\s*\}?\}\}",
            match => match.Groups[1].Value switch
            {
                "channel" => channel,
                "channel_type" => type,
                "duration" => "-",
                _ => "",
            });
    }
}

/// <summary>1人の読み手。相乗りしているぶんだけ居る</summary>
public sealed class Sink(string use, int priority, Action<Sink> onLeave)
{
    private readonly Channel<byte[]> _queue = Channel.CreateUnbounded<byte[]>(
        new UnboundedChannelOptions { SingleReader = true });
    private long _pending;
    private int _left;

    public string Use { get; } = use;
    public int Priority { get; } = priority;

    /// <summary>読み手が居なくなったか、蹴られたか。どちらでも読み出しは終わる</summary>
    public ChannelReader<byte[]> Reader => _queue.Reader;

    /// <summary>蹴られた理由。**失敗として伝えるために持つ**</summary>
    public string? FailedWith { get; private set; }

    public void Push(byte[] chunk)
    {
        if (_left != 0) return;
        Interlocked.Add(ref _pending, chunk.Length);
        if (!_queue.Writer.TryWrite(chunk)) return;

        /*
         * **録画は落とさない**方針なので遅れは溜める。ただし際限なく溜めると
         * プロセスごと落ちるので、ここを超えたらその読み手だけ切る。切られた
         * 側は「録画に失敗した」と分かるほうが、黙って全部が死ぬよりまし
         */
        if (Interlocked.Read(ref _pending) > TunerPool.MaxLag) Fail("読み出しが追い付かないので切りました");
    }

    /// <summary>読み出した分だけ遅れを減らす</summary>
    public void Consumed(int bytes) => Interlocked.Add(ref _pending, -bytes);

    public void End()
    {
        if (Interlocked.Exchange(ref _left, 1) != 0) return;
        _queue.Writer.TryComplete();
    }

    public void Fail(string reason)
    {
        if (Interlocked.Exchange(ref _left, 1) != 0) return;
        FailedWith = reason;
        _queue.Writer.TryComplete();
    }

    /// <summary>読む側が去った。相乗りから抜ける</summary>
    public void Leave()
    {
        if (Interlocked.Exchange(ref _left, 1) != 0) return;
        _queue.Writer.TryComplete();
        onLeave(this);
    }
}

/// <summary>1本の選局。相乗りしている読み手をまとめて持つ</summary>
internal sealed class Lease(int tuner, string type, string channel)
{
    private Process? _child;
    private CancellationTokenSource? _linger;
    private string _stderr = "";

    public int Tuner { get; } = tuner;
    public string Type { get; } = type;
    public string Channel { get; } = channel;
    public List<Sink> Sinks { get; } = [];
    public string? Error { get; private set; }
    public int? Pid => _child?.HasExited == false ? _child.Id : null;

    public int Priority => Sinks.Count == 0 ? int.MinValue : Sinks.Max(sink => sink.Priority);

    /// <summary>
    /// 選局を始める。
    ///
    /// <para>
    /// **`setsid` を噛ませる。** `sh -c` に渡すのがパイプラインだと、sh を殺しても
    /// 選局コマンドが生き残ってチューナーを掴んだままになり、次のチャンネルが
    /// 「デバイスが使用中」で失敗し続ける。新しいプロセスグループに入れておいて、
    /// 止めるときはグループごと落とす。
    /// </para>
    /// </summary>
    private bool _native;
    private volatile bool _stopped;
    private Task? _pump;

    /// <summary>
    /// **掴んだまま選局する側。** 外のコマンドを起こさずに ioctl で選局し、
    /// B25 も自分で解く (Tuning.cs / AribB25.cs)。
    ///
    /// <para>
    /// 外から見た振る舞いはプロセス版と同じにしてある。**流れが途切れたら
    /// 失敗として畳む** — 黙って終わると空のファイルが残る。
    /// </para>
    /// </summary>
    /// <summary>
    /// **掴んだままのデバイスから読んで配る。** 選局そのものはプールがやる。
    ///
    /// <para>
    /// デバイスは**チューナーごとに開きっぱなし**で、ここでは閉じない。
    /// 畳むときも読むのをやめるだけ (<see cref="Kill"/>)。
    /// </para>
    /// </summary>
    public void StartNative(ITuneDevice tuner, AribB25? b25, Action onExit)
    {
        _native = true;
        _pump = Task.Run(() =>
        {
            var buffer = new byte[188 * 1024];
            try
            {
                while (!_stopped)
                {
                    var read = tuner.Output.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;

                    var chunk = b25 is null ? buffer[..read] : b25.Decode(buffer.AsSpan(0, read)).ToArray();
                    if (chunk.Length == 0) continue;

                    lock (Sinks)
                    {
                        foreach (var sink in Sinks.ToList()) sink.Push(chunk);
                    }
                }
            }
            catch (Exception error)
            {
                Error = error.Message;
            }
            // 畳めと言われて終わったのなら、それは失敗ではない
            if (!_stopped) onExit();
        });
    }

    public void Start(string command, Action onExit)
    {
        var start = new ProcessStartInfo("setsid")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add("sh");
        start.ArgumentList.Add("-c");
        start.ArgumentList.Add(command);

        var child = Process.Start(start)!;
        _child = child;

        _ = Task.Run(async () =>
        {
            var buffer = new byte[64 * 1024];
            var stream = child.StandardOutput.BaseStream;
            try
            {
                for (; ; )
                {
                    var read = await stream.ReadAsync(buffer);
                    if (read <= 0) break;
                    var chunk = buffer[..read];
                    lock (Sinks)
                    {
                        foreach (var sink in Sinks.ToList()) sink.Push(chunk);
                    }
                }
            }
            catch (Exception error)
            {
                _stderr = error.Message;
            }
        });

        _ = Task.Run(async () =>
        {
            // 選局が失敗した理由を拾うため、末尾だけ持つ
            _stderr += await child.StandardError.ReadToEndAsync();
            if (_stderr.Length > 2000) _stderr = _stderr[^2000..];
        });

        _ = Task.Run(async () =>
        {
            await child.WaitForExitAsync();
            Error = _stderr.Trim().Split('\n').LastOrDefault()?.Trim() is { Length: > 0 } tail ? tail : null;
            onExit();
        });
    }

    public void StartLinger(Action release, TimeSpan after)
    {
        if (_linger is not null) return;
        var source = new CancellationTokenSource();
        _linger = source;
        _ = Task.Delay(after, source.Token).ContinueWith(task =>
        {
            if (task.IsCanceled) return;
            _linger = null;
            release();
        }, TaskScheduler.Default);
    }

    public void CancelLinger()
    {
        _linger?.Cancel();
        _linger = null;
    }

    public void Kill()
    {
        /*
         * **掴んだままのほうは閉じない。** デバイスはチューナーごとに開いた
         * ままで、次の選局が同じものを使う。ここでやるのは読むのをやめること
         * だけ (読み口は 200ms ごとに起きるので、すぐ気付く)。
         */
        if (_native)
        {
            _stopped = true;
            _pump?.Wait(TimeSpan.FromSeconds(2));
            _pump = null;
        }

        var child = _child;
        _child = null;
        if (child is null || child.HasExited) return;
        Interop.KillGroup(child.Id);
    }
}
