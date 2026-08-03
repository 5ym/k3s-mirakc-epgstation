import { expect, goto, syncEpg, test } from './helpers';

/**
 * チューナー画面。
 *
 * 選局するのはチューナー側のエージェント。mirakc には走査APIが無く、設定も
 * 起動時にしか読まれないので、あちらが mirakc を止めて総当たりし、書き戻して
 * から起動し直す。denpa は開始を投げて進み具合を見せるだけ。
 */
test.describe('チューナー画面', () => {
    test.afterEach(async ({ request, stack }) => {
        await request.post(`${stack.mirakcUrl}/__control/tuners?busy=0`);
    });

    test('チャンネルスキャンを実行でき、進み具合と結果が出る', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/tuners');

        const card = page.getByTestId('scan-card');
        // 何分もかかってチューナーを全部使うので、そうと分かるようにしておく
        await expect(card).toContainText('チューナーを全部使い');

        await card.getByTestId('scan-start').click();

        await expect(card.getByTestId('scan-state')).toHaveText('完了', { timeout: 30_000 });
        // 総当たりなので、どこまで進んだかを割合で出せる
        await expect(card.getByTestId('scan-count')).toContainText('4 / 4');
        // 受信できた分だけ数える。信号が無かった分は数に入らない
        await expect(card.getByTestId('scan-found')).toContainText('2');
        await expect(card.getByTestId('scan-log')).toContainText('2 サービス');
    });

    test('種別を1つも選ばなければ断る', async ({ page }) => {
        await goto(page, '/tuners');
        const card = page.getByTestId('scan-card');
        await card.getByTestId('scan-types').getByRole('checkbox').first().uncheck();
        await card.getByTestId('scan-start').click();
        await expect(page.getByTestId('tuner-error')).toContainText('種別を選んでください');
    });

    test('チューナーの空きと取れているチャンネルが出る', async ({ page, request, stack }) => {
        await syncEpg(request);
        await request.post(`${stack.mirakcUrl}/__control/tuners?busy=1`);
        await goto(page, '/tuners');

        const tuners = page.getByTestId('tuner-list');
        await expect(tuners.getByTestId('tuner-row')).toHaveCount(4);
        /*
         * 掴んでいる相手が何をしているのか分かるようにする。
         *
         * mirakc が持っているのは User-Agent だけで、渡していなかった頃は
         * `Bun/1.3.14` と出るだけだった。録画なのかロゴ集めなのか読めない
         */
        const using = tuners.getByTestId('tuner-row').nth(0);
        await expect(using).toContainText('使用中');
        await expect(using.getByTestId('tuner-user').first()).toContainText('録画');
        // mirakc 自身の仕事は User-Agent が付かない。ID から読み解く
        await expect(using.getByTestId('tuner-user').nth(1)).toContainText('mirakc: 番組表');
        // 故障は空き/使用中より先に出す。直さないと録れない
        await expect(tuners.getByTestId('tuner-row').nth(3)).toContainText('故障');

        // mirakc の設定に入っている物理チャンネルと、denpa が取り込んだ局名
        const channels = page.getByTestId('channel-list');
        await expect(channels.getByTestId('channel-row').first()).toBeVisible();
        await expect(channels).toContainText('TOKYO MX');

        /*
         * どこまで進んだかを1行で出す。時間がかかるのは mirakc が1局ずつ
         * 選局して調べるところで、denpa はその結果を取り込み直しているだけ。
         * 表を上から下まで見ないと分からない状態だと、止まっているのか
         * 進んでいるのか区別が付かない。
         *
         * 周波数・局・番組表は入れ子で数がそろわないので、3つとも名前を添えて出す
         */
        const coverage = page.getByTestId('channel-coverage');
        await expect(coverage).toContainText('周波数');
        await expect(coverage).toContainText('そこに乗っている局');
        await expect(coverage).toContainText('番組表の届いた局');
    });

    test('mirakc を入れ直せる', async ({ page, request, stack }) => {
        /*
         * **局が足りないときに効くのはこれだけ。** どの局が受信できるかを調べているのは
         * mirakc で、denpa 側で取り込み直しても mirakc がまだ知らない局は増えない。
         * 以前ここにあった「局を取り直す」は、待っている相手を急かす力が無かった
         */
        const before = (await (await request.get(`${stack.mirakcUrl}/__control/restarts`)).json()).restarts;

        await goto(page, '/tuners');
        await page.getByTestId('restart-mirakc').click();
        await expect(page.getByTestId('tuner-notice')).toContainText('入れ直しました');

        const after = (await (await request.get(`${stack.mirakcUrl}/__control/restarts`)).json()).restarts;
        expect(after).toBe(before + 1);
    });
});
