import { expect, test } from './helpers';

/**
 * 放送の延長への追従。
 *
 * 録画中のTSには EIT[p/f] (いま流れている番組) が乗っている。denpa は**同じ
 * ストリームからそれを読んで**、止める時刻を後ろへずらす。mirakc に番組情報を
 * 聞き直していた頃と違って、問い合わせる相手が要らない。
 *
 * 延長そのものは 21 で見る (時間がかかるので分けてある)。
 */
test.describe('放送の延長', () => {
    test('エージェントの知らせを聞いている', async ({ request, stack }) => {
        /*
         * チューナーの様子もスキャンの進み具合も、これを聞いて動く。
         * 繋がっていないと定期実行の保険だけになり、気付くのが分単位まで遅れる
         */
        const status = await (await request.get(`${stack.agentUrl}/__control/listeners`)).json();
        expect(status.listeners, 'denpa が /denpa/events に繋いでいない').toBeGreaterThan(0);
    });
});
