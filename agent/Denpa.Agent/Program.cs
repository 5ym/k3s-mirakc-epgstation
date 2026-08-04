using System.Text;
using System.Text.Json.Nodes;
using Denpa.Agent;
using Microsoft.AspNetCore.Http.Features;

/*
 * チューナーエージェント。**機材に触るのはここだけ。**
 *
 * denpa から触れないものが3つある。
 *
 * - B-CASカード … pcscd 経由でしか読めず、その pcscd はこのコンテナにしか居ない
 * - チューナーデバイス … `/dev/dvb/*` が見えているのはこちらだけ
 * - 選局そのもの … デバイスを掴んで ioctl で選局する (Tuning.cs)
 *
 * **中身は読まない。** NIT も SDT も EIT も解かず、TS をそのまま流す。
 * 読むのは denpa (`src/lib/ts`) で、局を選り分けるのも番組表を組み立てるのも、
 * チャンネルスキャンで見つかった局を判断するのもあちらの仕事 (docs/roadmap.md)。
 */

// 実機で選局と復号だけ試す口。サーバは立てない (Probe.cs)
if (args.ElementAtOrDefault(0) == "--tune") return Probe.Run(args);
if (args.ElementAtOrDefault(0) == "--decode-file") return Probe.Decode(args);

var port = int.TryParse(Environment.GetEnvironmentVariable("AGENT_PORT"), out var configured)
    ? configured
    : 25252;
var recorded = Path.GetFullPath(Environment.GetEnvironmentVariable("RECORDED_DIR") ?? "/denpa-recorded");

var config = Config.FromEnvironment();
var events = new Events();
var (tuners, detected) = config.ResolveTuners();

/*
 * 選局は自分でやる。**`recisdb` は要らなくなった。**
 *
 * CARD_URL は「手元にカードが無い拠点」だけ。指定しなければ自分に刺さって
 * いるカードを読む (CardShare.cs)。
 */
var tune = new TuneOptions(
    Environment.GetEnvironmentVariable("CARD_URL"),
    name => config.StreamIds()(name));

var pool = new TunerPool(tuners, () => events.Emit("tuners"), tune) { Detected = detected };

var builder = WebApplication.CreateSlimBuilder(args);
builder.WebHost.ConfigureKestrel(options =>
{
    options.ListenAnyIP(port);
    // 選局は何時間も開きっぱなしになる。既定のまま切られると録画が落ちる
    options.Limits.KeepAliveTimeout = TimeSpan.FromDays(365);
    options.Limits.MinResponseDataRate = null;
});
builder.Logging.ClearProviders();

var app = builder.Build();

// --- 選局。**エージェントの表看板** ---------------------------------------
app.MapGet("/denpa/stream", async (HttpContext http) =>
{
    var query = http.Request.Query;
    var type = query["type"].ToString();
    var channel = query["channel"].ToString();
    if (type.Length == 0 || channel.Length == 0)
    {
        await Respond.Write(http, new JsonObject { ["error"] = "type と channel が要ります" }, 400);
        return;
    }
    _ = int.TryParse(query["priority"].ToString(), out var priority);
    var use = query["use"].ToString() is { Length: > 0 } named ? named : "不明";

    Sink sink;
    try
    {
        sink = pool.Open(type, channel, priority, use);
    }
    catch (TunerPool.TunerBusyException error)
    {
        // 掴めなかった。**409 で返す**ので、呼んだ側は待って掛け直せる
        await Respond.Write(http, new JsonObject { ["error"] = error.Message }, 409);
        return;
    }
    catch (Exception error)
    {
        /*
         * 掴めたが選局できなかった (同期しない・デバイスが開けない…)。
         * **理由を必ず残す。** 空の 500 を返していたせいで、総当たりの
         * スキャンが「選局できません (500)」としか言えず、何が起きているのか
         * 分からなかった (docs/roadmap.md)
         */
        Log.Write($"{type} {channel} ({use}): {error.Message}");
        await Respond.Write(http, new JsonObject { ["error"] = error.Message }, 500);
        return;
    }

    http.Response.ContentType = "video/MP2T";
    // 溜めない。数パケット届いたらそのまま流す (64KB 貯めると 25ms 積み上がる)
    http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

    try
    {
        await foreach (var chunk in sink.Reader.ReadAllAsync(http.RequestAborted))
        {
            await http.Response.Body.WriteAsync(chunk, http.RequestAborted);
            await http.Response.Body.FlushAsync(http.RequestAborted);
            sink.Consumed(chunk.Length);
        }

        /*
         * **蹴られたなら、正常終了として畳まない。**
         *
         * 送っている途中の本文をきれいに閉じると、読む側には「録り終えた」
         * ように届く。実際それで、蹴られた録画が尻切れのまま成功扱いに
         * なっていた (bun 版は接続を壊せなかった)。Kestrel は壊せるので壊す
         */
        if (sink.FailedWith is not null)
        {
            Log.Write($"{channel} ({use}): {sink.FailedWith}");
            http.Abort();
        }
    }
    catch (OperationCanceledException)
    {
        // 読む側が去った。普通の終わり方
    }
    finally
    {
        sink.Leave();
    }
});

// --- 知らせ (SSE) ---------------------------------------------------------
app.MapGet("/denpa/events", async (HttpContext http) =>
{
    http.Response.ContentType = "text/event-stream";
    http.Response.Headers.CacheControl = "no-cache";
    http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

    var queue = events.Subscribe();
    try
    {
        await foreach (var block in queue.Reader.ReadAllAsync(http.RequestAborted))
        {
            await http.Response.WriteAsync(block, http.RequestAborted);
            await http.Response.Body.FlushAsync(http.RequestAborted);
        }
    }
    catch (OperationCanceledException)
    {
        // 購読者が去った
    }
    finally
    {
        events.Unsubscribe(queue);
    }
});

// --- チューナーとチャンネル -----------------------------------------------
app.MapGet("/denpa/tuners", (HttpContext http) =>
    Respond.Write(http, new JsonObject { ["tuners"] = pool.Status(), ["detected"] = pool.Detected }));

/*
 * 機材の定義を書き換える。**画面から。**
 *
 * 受け取るのはデバイスと種別だけで、選局コマンドは組み立てる。自由な文字列を
 * 受けると「denpa に入れた人がチューナー側で好きなコマンドを走らせられる」
 * ことになる (しかもあちらは privileged)。
 *
 * 空を渡すと定義そのものを消す = **自動検出に戻す**。
 */
app.MapPut("/denpa/tuners", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    if (body?["tuners"] is not JsonArray list)
    {
        await Respond.Write(http, new JsonObject { ["error"] = "tuners が要ります" }, 400);
        return;
    }

    var next = new List<TunerSpec>();
    foreach (var node in list)
    {
        if (TunerSpec.FromJson(node) is not { } spec)
        {
            await Respond.Write(http, new JsonObject { ["error"] = "name の無いチューナーがあります" }, 400);
            return;
        }
        // 画面から渡ってきたコマンドは捨てる。ファイルに直に書いたものだけ効く
        next.Add(spec with { Command = null });
    }

    config.SaveTuners(next);
    var (resolved, auto) = config.ResolveTuners();
    pool.Detected = auto;
    pool.Replace(resolved);
    await Respond.Write(http, new JsonObject { ["tuners"] = pool.Status(), ["detected"] = pool.Detected });
});

app.MapGet("/denpa/channels", (HttpContext http) => Respond.Write(http, config.LoadChannels()));

/*
 * スキャンの結果を預かる。**書いてくるのは denpa。**
 *
 * 総当たりの選局はこちらに頼まれるが、NIT も SDT も解かないので「何が居たか」は
 * 分からない。読むのはあちらの仕事で、こちらは控えを持って配るだけ。
 */
app.MapPut("/denpa/channels", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    if (body?["channels"] is not JsonArray found || body["scanned"] is not JsonArray scanned
        || scanned.Count == 0)
    {
        await Respond.Write(http, new JsonObject { ["error"] = "channels と scanned が要ります" }, 400);
        return;
    }
    // 1件も無いまま上書きすると、今まで録れていた局まで消える
    if (found.Count == 0)
    {
        await Respond.Write(http, new JsonObject { ["error"] = "チャンネルが1件もありません" }, 400);
        return;
    }

    var types = scanned.Select(node => node?.GetValue<string>() ?? "").ToHashSet();
    var merged = config.SaveChannels(found, types);
    Log.Write($"チャンネルを保存しました: {found.Count} 件 ({string.Join(", ", types)})");
    /*
     * 局が入れ替わった。denpa は**これを合図に取り込み直す。**
     * mirakc を入れ直していた頃と違って、こちらは何も再起動しない
     */
    events.Emit("channels");
    await Respond.Write(http, merged);
});

// --- カードとスクランブル解除 ---------------------------------------------
app.MapGet("/denpa/card", async (HttpContext http) => await Respond.Write(http, await Card.Status()));

app.MapPost("/denpa/decode", async (HttpContext http) =>
{
    var body = await Respond.Read(http);
    var result = Scramble.Decode(
        recorded, body?["input"]?.GetValue<string>(), body?["output"]?.GetValue<string>(),
        Environment.GetEnvironmentVariable("CARD_URL"));
    await Respond.Write(http, result, result["ok"]!.GetValue<bool>() ? 200 : 500);
});

/*
 * 鍵を配る口。**カードを1枚だけ置いて、他の拠点にも使わせる。**
 *
 * 拠点ごとにエージェントとチューナーがある形だと、カードは1箇所にしか
 * ありません。カードごと持っていく代わりに、ECM を投げて鍵を貰います
 * (CardShare.cs)。重い MULTI2 は各拠点の手元に残ります。
 *
 * **自分にカードが刺さっていなければ、ここは 503 を返すだけ**です。
 */
app.MapGet("/denpa/card/init", async (HttpContext http) =>
{
    try
    {
        http.Response.ContentType = "application/octet-stream";
        await http.Response.Body.WriteAsync(AribB25.Pack(AribB25.Server.Init()));
    }
    catch (Exception error)
    {
        await Respond.Write(http, new JsonObject { ["error"] = error.Message }, 503);
    }
});

app.MapPost("/denpa/card/ecm", async (HttpContext http) =>
{
    using var body = new MemoryStream();
    await http.Request.Body.CopyToAsync(body);
    if (body.Length is 0 or > 4096)
    {
        await Respond.Write(http, new JsonObject { ["error"] = "ECM が入っていません" }, 400);
        return;
    }

    try
    {
        var (key, code) = AribB25.Server.Ecm(body.ToArray());
        http.Response.ContentType = "application/octet-stream";
        await http.Response.Body.WriteAsync(AribB25.Pack(key, code));
    }
    catch (Exception error)
    {
        await Respond.Write(http, new JsonObject { ["error"] = error.Message }, 503);
    }
});

app.MapFallback((HttpContext http) =>
    Respond.Write(http, new JsonObject { ["ok"] = false, ["error"] = "not found" }, 404));

await Card.EnsurePcscd();
app.Lifetime.ApplicationStopping.Register(pool.CloseAll);

Log.Write($"listening on :{port} (tuners: {config.TunersFile} / channels: {config.ChannelsFile})");
Log.Write($"チューナー {pool.Tuners.Count} 本 / チャンネル {config.LoadChannels().Count} 件");
await app.RunAsync();
return 0;

/// <summary>HTTP に JSON を書く / 読む。中身の作りは <see cref="Json"/></summary>
internal static class Respond
{
    public static async Task Write(HttpContext http, JsonNode? body, int status = 200)
    {
        http.Response.StatusCode = status;
        http.Response.ContentType = "application/json";
        await http.Response.WriteAsync(body?.ToJsonString(Json.Compact) ?? "null");
    }

    public static async Task<JsonNode?> Read(HttpContext http)
    {
        try
        {
            using var reader = new StreamReader(http.Request.Body, Encoding.UTF8);
            return JsonNode.Parse(await reader.ReadToEndAsync());
        }
        catch
        {
            return null;
        }
    }
}
