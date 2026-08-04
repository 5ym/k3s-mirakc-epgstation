import { expect, goto, syncEpg, test } from './helpers';

/**
 * チューナー画面。
 *
 * **総当たりを回すのは denpa。** 選局はエージェントに頼むが、NIT と SDT を
 * 解いて局名を取るのはこちらで、見つけた顔ぶれをエージェントに預ける。
 * ここは 13〜62ch を本当に1本ずつ開いていて、偽の放送に居るのは T16 と T21 だけ。
 */
test.describe('チューナー画面', () => {
    test.afterEach(async ({ request, stack }) => {
        await request.post(`${stack.agentUrl}/__control/tuners?busy=0`);
    });

    test('チャンネルスキャンを実行でき、進み具合と結果が出る', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/tuners');

        const card = page.getByTestId('scan-card');
        // 何分もかかって空きチューナーを全部使うので、そうと分かるようにしておく
        await expect(card).toContainText('空いているチューナーを全部使います');

        await card.getByTestId('scan-start').click();

        await expect(card.getByTestId('scan-state')).toHaveText('完了', { timeout: 60_000 });
        // 総当たりなので、どこまで進んだかを割合で出せる (地上波は 13〜62ch)
        await expect(card.getByTestId('scan-count')).toContainText('50 / 50');
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
        await request.post(`${stack.agentUrl}/__control/tuners?busy=1`);
        await goto(page, '/tuners');

        const tuners = page.getByTestId('tuner-list');
        await expect(tuners.getByTestId('tuner-row')).toHaveCount(4);
        /*
         * 掴んでいる相手が何をしているのか分かるようにする。
         *
         * エージェントが持っているのは短い印だけ (`rec 1` / `epg BS11_0`) なので、
         * 番組名に開くのは画面側の仕事。**何を掴んでいるか**も一緒に出す
         */
        const using = tuners.getByTestId('tuner-row').nth(0);
        await expect(using).toContainText('BS11_0');
        await expect(using.getByTestId('tuner-user').first()).toContainText('録画');
        // 録画と番組表が同じ選局に相乗りしている。チューナーは増えない
        await expect(using.getByTestId('tuner-user').nth(1)).toContainText('番組表');

        // スキャンで見つかった物理チャンネルと、denpa が取り込んだ局名
        const channels = page.getByTestId('channel-list');
        await expect(channels.getByTestId('channel-row').first()).toBeVisible();
        await expect(channels).toContainText('TOKYO MX');

        /*
         * どこまで進んだかを1行で出す。時間がかかるのは1チャンネルずつ選局して
         * 番組表を読むところで、表を上から下まで見ないと分からない状態だと、
         * 止まっているのか進んでいるのか区別が付かない。
         *
         * 周波数・局・番組表は入れ子で数がそろわないので、3つとも名前を添えて出す
         */
        const coverage = page.getByTestId('channel-coverage');
        await expect(coverage).toContainText('周波数');
        await expect(coverage).toContainText('そこに乗っている局');
        await expect(coverage).toContainText('番組表の届いた局');
    });
});
