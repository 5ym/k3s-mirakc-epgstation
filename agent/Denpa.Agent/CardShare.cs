using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;

namespace Denpa.Agent;

/// <summary>
/// **カードを1枚だけ置いて、鍵を配る。**
///
/// <para>
/// 拠点ごとにエージェントとチューナーがある形だと、カードは1箇所にしか
/// ありません。そこで**カードごと持っていく**のではなく、**ECM を投げて鍵を
/// 貰う**ようにします。ECM は 200 バイトほど、返るのは 16 バイトの鍵だけなので、
/// 拠点を跨いでも安く済みます。
/// </para>
///
/// <para>
/// **重いほうは動かしません。** MULTI2 は流れてくる TS ぜんぶに掛かるので、
/// これは各拠点の手元に残します。ネットワークに乗るのは鍵のやり取りだけです。
/// </para>
///
/// <para>
/// 差し込み口は libaribb25 が用意してくれています。カードは <c>B_CAS_CARD</c>
/// という**関数ポインタの表**で渡す作りなので、<c>proc_ecm</c> だけ別のところへ
/// 投げる表を作って渡せば、復号の本体は何も変えずに済みます。
/// </para>
///
/// <para>
/// **拠点にカードがあるならそちらが速いし、落ちません。** 配るのは「カードが
/// 無い拠点」のためのもので、既定にはしません (docs/agent.md)。
/// </para>
/// </summary>
public sealed unsafe partial class AribB25
{
    /// <summary>カードの素。**鍵を作るのに要る定数**で、初めに1回だけ貰う</summary>
    public sealed record CardInit(byte[] SystemKey, byte[] InitCbc, int CaSystemId, long[] Ids);

    /// <summary>`b_cas_card.h` の <c>B_CAS_INIT_STATUS</c></summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct InitStatus
    {
        public fixed byte SystemKey[32];
        public fixed byte InitCbc[8];
        public long CardId;
        public int Status;
        public int CaSystemId;
    }

    /// <summary>`b_cas_card.h` の <c>B_CAS_ECM_RESULT</c></summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct EcmResult
    {
        public fixed byte Key[16];
        public uint ReturnCode;
    }

    /// <summary>
    /// **カードを持っている側。** 自分のカードで ECM を解いて鍵を返す。
    ///
    /// <para>
    /// 開くのはプロセスで1回だけ。カードは pcscd が順番に貸すので、何本の
    /// チューナーから来ても1枚で足ります (用があるのは鍵が変わるときだけ)。
    /// </para>
    /// </summary>
    public static class Server
    {
        private static readonly Lock Gate = new();
        private static CasCard* _card;

        /// <summary>
        /// 同じ ECM には同じ鍵。**拠点が増えるほど効きます。**
        ///
        /// <para>
        /// 衛星は全国で同じ電波なので、3拠点が同じ BS を見ていれば ECM も同じ
        /// ものが3つ来ます。カードに聞くのは1回で済みます。
        /// </para>
        /// </summary>
        private static readonly ConcurrentDictionary<string, (byte[] Key, int Code, DateTime At)> Cache = new();

        /// <summary>鍵が変わる周期より短くする。長く持つと古い鍵を配る</summary>
        private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(3);

        private static CasCard* Card()
        {
            lock (Gate)
            {
                if (_card is not null) return _card;

                var card = CreateCasCard();
                if (card is null) throw new IOException("カードの口を用意できません");
                var opened = card->Init(card);
                if (opened < 0)
                {
                    card->Release(card);
                    throw new IOException($"カードを読めません ({CardError(opened)})");
                }
                _card = card;
                return _card;
            }
        }

        public static CardInit Init()
        {
            var card = Card();
            var status = default(InitStatus);
            lock (Gate)
            {
                if (card->GetInitStatus(card, &status) < 0) throw new IOException("カードの状態を読めません");
            }

            var systemKey = new byte[32];
            var initCbc = new byte[8];
            for (var at = 0; at < 32; at++) systemKey[at] = status.SystemKey[at];
            for (var at = 0; at < 8; at++) initCbc[at] = status.InitCbc[at];

            return new CardInit(systemKey, initCbc, status.CaSystemId, LocalIds());
        }

        private static long[] LocalIds()
        {
            var card = Card();
            var id = default(CardId);
            lock (Gate)
            {
                if (card->GetId(card, &id) < 0 || id.Data is null) return [];
                var found = new long[id.Count];
                for (var at = 0; at < id.Count; at++) found[at] = id.Data[at];
                return found;
            }
        }

        /// <summary>ECM を1つ解いて鍵を返す。**カードに触るのはここだけ**</summary>
        public static (byte[] Key, int Code) Ecm(ReadOnlySpan<byte> ecm)
        {
            var name = Convert.ToBase64String(ecm);
            if (Cache.TryGetValue(name, out var cached) && DateTime.UtcNow - cached.At < CacheFor)
            {
                return (cached.Key, cached.Code);
            }

            var card = Card();
            var result = default(EcmResult);
            int code;
            lock (Gate)
            {
                fixed (byte* source = ecm)
                {
                    code = card->ProcEcm(card, &result, source, ecm.Length);
                }
            }
            if (code < 0) throw new IOException($"カードが ECM を返しません ({CardError(code)})");

            var key = new byte[16];
            for (var at = 0; at < 16; at++) key[at] = result.Key[at];

            if (Cache.Count > 256) Cache.Clear();  // 溜め込まない。持ち主は数秒で入れ替わる
            Cache[name] = (key, (int)result.ReturnCode, DateTime.UtcNow);
            return (key, (int)result.ReturnCode);
        }
    }

    /// <summary>
    /// **カードを持っていない側。** 鍵だけ貰いに行く。
    ///
    /// <para>
    /// libaribb25 に渡す <c>B_CAS_CARD</c> を自分で組み立てる。中身は
    /// 関数ポインタなので、<c>[UnmanagedCallersOnly]</c> の静的メソッドを
    /// そのまま指せる (AOT でも marshalling が挟まらない)。
    /// </para>
    ///
    /// <para>
    /// **同期で呼びます。** libaribb25 は復号の途中で <c>proc_ecm</c> を呼び、
    /// 鍵が返るまで TS を中に溜めて待ちます。ここで待たせるのは正しい振る舞いで、
    /// 遅れた分は取りこぼしではなく遅延になります。
    /// </para>
    /// </summary>
    internal static class Remote
    {
        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };
        private static string _url = "";
        private static CardInit? _init;
        private static long* _ids;
        private static int _idCount;

        /// <summary>鍵を配ってくれる相手を決めて、表を組み立てる</summary>
        internal static CasCard* Create(string url)
        {
            _url = url.TrimEnd('/');
            // 素は初めに1回だけ貰う。ここで駄目なら、あとの ECM も通らない
            _init = Fetch();

            _idCount = _init.Ids.Length;
            _ids = (long*)NativeMemory.AllocZeroed((nuint)Math.Max(1, _idCount) * sizeof(long));
            for (var at = 0; at < _idCount; at++) _ids[at] = _init.Ids[at];

            var card = (CasCard*)NativeMemory.AllocZeroed((nuint)sizeof(CasCard));
            card->Release = &Release;
            card->Init = &Ready;
            card->GetInitStatus = &GetInitStatus;
            card->GetId = &GetId;
            card->GetPowerOnControl = &GetPowerOnControl;
            card->ProcEcm = &ProcEcm;
            card->ProcEmm = &ProcEmm;
            card->SetAcasMode = &SetAcasMode;
            return card;
        }

        private static CardInit Fetch()
        {
            using var response = Http.Send(new HttpRequestMessage(HttpMethod.Get, $"{_url}/denpa/card/init"));
            if (!response.IsSuccessStatusCode)
            {
                throw new IOException($"鍵を配る相手からカードの素を貰えません ({(int)response.StatusCode})");
            }

            // 32 バイトの system_key + 8 バイトの init_cbc + ca_system_id + カード番号
            var body = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
            if (body.Length < 44) throw new IOException("カードの素が短すぎます");

            var ids = new long[(body.Length - 44) / 8];
            for (var at = 0; at < ids.Length; at++)
            {
                ids[at] = BinaryPrimitives.ReadInt64BigEndian(body.AsSpan(44 + at * 8));
            }
            return new CardInit(
                body[..32], body[32..40], BinaryPrimitives.ReadInt32BigEndian(body.AsSpan(40)), ids);
        }

        [UnmanagedCallersOnly]
        private static void Release(CasCard* card)
        {
            if (_ids is not null) NativeMemory.Free(_ids);
            _ids = null;
            NativeMemory.Free(card);
        }

        [UnmanagedCallersOnly]
        private static int Ready(CasCard* card) => _init is null ? -2 : 0;

        [UnmanagedCallersOnly]
        private static int GetInitStatus(CasCard* card, void* destination)
        {
            if (_init is null) return -2;

            var status = (InitStatus*)destination;
            for (var at = 0; at < 32; at++) status->SystemKey[at] = _init.SystemKey[at];
            for (var at = 0; at < 8; at++) status->InitCbc[at] = _init.InitCbc[at];
            status->CardId = _idCount > 0 ? _ids[0] : 0;
            status->Status = 0;
            status->CaSystemId = _init.CaSystemId;
            return 0;
        }

        [UnmanagedCallersOnly]
        private static int GetId(CasCard* card, CardId* destination)
        {
            destination->Data = _ids;
            destination->Count = _idCount;
            return 0;
        }

        [UnmanagedCallersOnly]
        private static int GetPowerOnControl(CasCard* card, void* destination) => -1;

        /// <summary>**ここだけが本番。** ECM を投げて鍵を貰う</summary>
        [UnmanagedCallersOnly]
        private static int ProcEcm(CasCard* card, void* destination, byte* source, int length)
        {
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Post, $"{_url}/denpa/card/ecm")
                {
                    Content = new ByteArrayContent(new ReadOnlySpan<byte>(source, length).ToArray()),
                };
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

                using var response = Http.Send(request);
                if (!response.IsSuccessStatusCode) return -6;

                var body = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
                if (body.Length < 18) return -6;

                var result = (EcmResult*)destination;
                for (var at = 0; at < 16; at++) result->Key[at] = body[at];
                result->ReturnCode = BinaryPrimitives.ReadUInt16BigEndian(body.AsSpan(16));
                return 0;
            }
            catch (Exception error)
            {
                // 相手が落ちている・繋がらない。**掛かったまま流れる**ことになるので、
                // 黙って諦めない (denpa 側は録れたものを見て気付く)
                Log.Write($"鍵を貰えません: {error.Message}");
                return -6;
            }
        }

        [UnmanagedCallersOnly]
        private static int ProcEmm(CasCard* card, byte* source, int length) => 0;

        [UnmanagedCallersOnly]
        private static int SetAcasMode(CasCard* card, int enable) => 0;
    }

    /// <summary>`AribB25.Server.Init()` の答えを、そのまま線に流せる形にする</summary>
    public static byte[] Pack(CardInit init)
    {
        var body = new byte[44 + init.Ids.Length * 8];
        init.SystemKey.CopyTo(body, 0);
        init.InitCbc.CopyTo(body, 32);
        BinaryPrimitives.WriteInt32BigEndian(body.AsSpan(40), init.CaSystemId);
        for (var at = 0; at < init.Ids.Length; at++)
        {
            BinaryPrimitives.WriteInt64BigEndian(body.AsSpan(44 + at * 8), init.Ids[at]);
        }
        return body;
    }

    /// <summary>鍵と返り値を1つにまとめる (16 バイトの鍵 + 2 バイトの返り値)</summary>
    public static byte[] Pack(byte[] key, int code)
    {
        var body = new byte[18];
        key.CopyTo(body, 0);
        BinaryPrimitives.WriteUInt16BigEndian(body.AsSpan(16), (ushort)code);
        return body;
    }
}
