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
        // 録画で掴んでいるものは誰が使っているか分かるようにする
        await expect(tuners.getByTestId('tuner-row').nth(1)).toContainText('使用中');
        await expect(tuners.getByTestId('tuner-row').nth(1)).toContainText('denpa');
        // 故障は空き/使用中より先に出す。直さないと録れない
        await expect(tuners.getByTestId('tuner-row').nth(3)).toContainText('故障');

        // mirakc の設定に入っている物理チャンネルと、denpa が取り込んだ局名
        const channels = page.getByTestId('channel-list');
        await expect(channels.getByTestId('channel-row').first()).toBeVisible();
        await expect(channels).toContainText('TOKYO MX');
    });
});
