const spawn = require('child_process').spawn;
const ffmpeg = process.env.FFMPEG;

const input = process.env.INPUT;
const output = process.env.OUTPUT;
const isDualMono = parseInt(process.env.AUDIOCOMPONENTTYPE, 10) == 2;

function buildArgs(ss) {
    const args = ['-y'];

    // 字幕用
    args.push('-fix_sub_duration');
    // ARIB字幕をビットマップとして焼き込む(再生側フォントに依存させない)。Rounded M+ 1m for ARIBはlibaribcaption公式推奨フォントで、丸ゴシック+JIS第三水準漢字+ARIB外字を1本でカバーする
    args.push('-sub_type', 'bitmap', '-font', 'Rounded M+ 1m for ARIB');
    if (ss !== null) {
        // 録画開始直後の1秒未満だけ、多重化されたもう一方の映像ストリームのPAT/PMTが
        // 確定しておらずエンコーダの初期化(fps/解像度確定)自体が失敗することがある。
        // 最初の失敗を検知した後だけ頭を少し捨てて再試行する(常時捨てると本編側が削れるため)
        args.push('-ss', String(ss));
    }
    // input 設定(チャンネル切り替え直後は前番組のPAT/PMTの残骸が先頭に混ざることがあるため、長めにprobeしてから構成を確定させる)
    args.push('-analyzeduration', '15000000', '-probesize', '30000000');
    args.push('-i', input);
    // mapで解決できない(型が不明な)ストリームは黙ってスキップする。エンコード自体を止めないため
    args.push('-ignore_unknown');
    // 字幕ストリーム設定(?は字幕ストリームが無い録画でもエンコードが失敗しないようにするため)
    args.push('-map', '0:s?', '-c:s', 'dvdsub');
    // インターレス解除(bwdifはyadifよりコーミング残りが少ない。modeは規定値のsend_fieldのままにし、フィールドごとに1フレーム生成して59.94p出力にする。地上波/BSの実写素材はフィールド単位で別の時間情報を持つため、時間解像度を落とさず活かす方針)
    args.push('-vf', 'bwdif,format=yuv420p10le');
    // ビデオストリーム設定(?はラジオ相当の映像なし録画でもエンコードが失敗しないようにするため。多重化された映像は全て残す)
    args.push('-map', '0:v?', '-c:v', 'libsvtav1');

    // オーディオストリーム設定
    if (isDualMono) {
        // 副音声は2ヶ国語放送(外国語)の場合と解説放送(日本語の音声ガイド)の場合があり判別できないため言語はundにする
        // channelsplitの出力はFL/FRという位置情報付き1chレイアウトのままだとlibopusが受け付けないため、aformatでmonoに付け替える
        args.push(
            '-filter_complex',
            'channelsplit[FL][FR];[FL]aformat=channel_layouts=mono[FLm];[FR]aformat=channel_layouts=mono[FRm]',
            '-map', '[FLm]',
            '-map', '[FRm]',
            '-metadata:s:a:0', 'language=jpn',
            '-metadata:s:a:1', 'language=und',
        );
    } else {
        // 音声ストリームを全て拾う(多言語放送等で複数トラックある場合に備える)。型不明のストリームは-ignore_unknownで弾かれるので安全
        args.push('-map', '0:a');
    }
    args.push('-c:a', 'libopus', '-b:a', '256k'); // 元放送(AAC 256kbps)と同じビットレート

    // トラックのdefaultフラグを明示(未設定だとプレイヤーが自動選択せず字幕/音声が出ないことがある)
    args.push('-disposition:s:0', 'default', '-disposition:v:0', 'default', '-disposition:a:0', 'default');
    // 進捗をkey=value形式でstdoutに吐かせる(標準出力は他用途で使っていないので流用できる)。
    // stderrの人間向けログをフレーム数から目視パースするより、out_time_us/progress=endが直接取れて確実
    args.push('-progress', 'pipe:1');
    // 出力ファイル
    args.push(output);

    return args;
}

// 万一のクラッシュでもエンコード済みの子プロセス(ffmpeg)を巻き込まないよう、終了前にkillしておく
let ffmpegChild = null;
const killChildAndExit = (code) => {
    if (ffmpegChild !== null) {
        try {
            ffmpegChild.kill('SIGTERM');
        } catch (e) {
            // ignore
        }
    }
    process.exitCode = code;
};
process.on('uncaughtException', err => {
    console.error(`uncaughtException: ${err && err.stack || err}`);
    killChildAndExit(1);
});
process.on('unhandledRejection', err => {
    console.error(`unhandledRejection: ${err && err.stack || err}`);
    killChildAndExit(1);
});
process.on('SIGINT', () => {
    if (ffmpegChild !== null) ffmpegChild.kill('SIGINT');
});

const MAX_BUFFER_LEN = 1024 * 1024; // 異常系での無限蓄積を防ぐ安全弁

// 1回のエンコード試行を実行する(先頭破損での再試行用に呼び直せるよう関数化)。
// 動画長/進捗のstateは試行ごとに独立させる必要があるため、ここでローカルに持つ
function runEncode(ss, onClose) {
    const args = buildArgs(ss);
    const child = spawn(ffmpeg, args);
    ffmpegChild = child;

    // 動画長(秒)。ffprobeを別途叩くとチャンネル切り替え直後のTSでハングして巻き込まれることがあるため、
    // ffmpeg自身が起動時にstderrへ出す "Duration: HH:MM:SS.xx" 行から取得する
    let duration = NaN;
    let stderrBuffer = '';
    child.stderr.on('data', data => {
        if (Number.isFinite(duration)) return;
        stderrBuffer += String(data);
        if (stderrBuffer.length > MAX_BUFFER_LEN) stderrBuffer = stderrBuffer.slice(-MAX_BUFFER_LEN);
        const m = stderrBuffer.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m !== null) duration = parseFloat(m[1]) * 3600 + parseFloat(m[2]) * 60 + parseFloat(m[3]);
    });

    /**
     * エンコード進捗表示用に標準出力に進捗情報を吐き出す({"type":"progress","percent":0.8,"log":"..."})
     *
     * -progress pipe:1 が吐く "key=value" のブロック(空行やprogress=continue/endで区切られる)を読む。
     * out_time_usがN/Aになる瞬間(エンコーダのバッファflush中など)はブロックごと更新をスキップして
     * 直前のpercentを維持する。frame数からの概算フォールバックは持たない(bwdifのsend_fieldで出力fpsが
     * 入力fpsと変わるなど、別経路の推定はズレの原因になりやすいため)。progress=endで確実に100%にする
     */
    let percent = 0;
    let block = {};
    let stdoutBuffer = '';
    child.stdout.on('data', data => {
        stdoutBuffer += String(data);
        if (stdoutBuffer.length > MAX_BUFFER_LEN) stdoutBuffer = stdoutBuffer.slice(-MAX_BUFFER_LEN);
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            block[line.slice(0, eq)] = line.slice(eq + 1).trim();
            if (block.progress === undefined) continue;

            const outTimeUs = parseFloat(block.out_time_us);
            if (block.progress === 'end') {
                percent = 1;
            } else if (Number.isFinite(outTimeUs) && Number.isFinite(duration)) {
                // percentだけはNaN汚染を防ぐガードが必要(JSON上typeof NaN === 'number'でEPGStation側のチェックを素通りしてしまう)
                percent = Math.min(1, outTimeUs / 1e6 / duration);
            }
            // percent計算に使っている経過/合計時間をそのままログにも出す。N/Aの間はNaNをそのまま表示させる
            const elapsedMin = (outTimeUs / 1e6 / 60).toFixed(2);
            const totalMin = (duration / 60).toFixed(2);
            const sizeMb = (parseInt(block.total_size, 10) / 1024 / 1024).toFixed(1);
            const rateMbps = (parseFloat(block.bitrate) / 1000).toFixed(2);
            console.log(JSON.stringify({
                type: 'progress',
                percent,
                log: `elapsed: ${elapsedMin}min, total: ${totalMin}min, speed: ${block.speed}, size: ${sizeMb}MB, rate: ${rateMbps}Mbps, drop: ${block.drop_frames}`,
            }));
            block = {};
        }
    });

    child.on('error', (err) => {
        // throw すると enc.js プロセスごと落ちて ffmpeg 子プロセスが孤児化するため、ログのみ残して失敗終了にする
        console.error(err);
        onClose(1);
    });

    child.on('close', (code) => {
        onClose(code);
    });
}

runEncode(null, (code) => {
    if (code === 0) {
        process.exitCode = 0;
        return;
    }
    // 録画開始直後の頭数百msだけ壊れているケースをここで拾う(詳細はbuildArgsのコメント参照)。
    // それ以外の理由での失敗もここに来るが、-ss 0.2を付けても同じ理由でもう一度失敗するだけなので無害
    console.error(`encode failed with code ${code}, retrying with -ss 0.2`);
    runEncode(0.2, (retryCode) => {
        process.exitCode = retryCode;
    });
});
