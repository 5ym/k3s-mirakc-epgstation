import { existsSync, readFileSync } from 'node:fs';
import type { Locator } from '@playwright/test';
import { SERVICES } from '../fake/services';
import { airing, cellOf, expect, goto, syncEpg, test, upcoming } from './helpers';

/**
 * 偽 ffmpeg が残した引数を1回ぶんずつに切って、探しているものを選ぶ。
 *
 * **ライブ視聴は ffmpeg を2本起こす** — 映像と字幕。同じファイルに順に足して
 * いくので (`tests/fake/ffmpeg.sh`)、どちらを見たいかで選び分ける
 */
async function ffmpegArgs(
    file: string,
    kind: 'video' | 'captions',
    expect_: typeof expect,
): Promise<string[]> {
    let found: string[] | undefined;
    await expect_(() => {
        expect_(existsSync(file)).toBe(true);
        const runs = readFileSync(file, 'utf8')
            .split('---\n')
            .filter((run) => run.trim() !== '')
            .map((run) => run.split('\n'));
        const wanted = kind === 'video' ? 'libx264' : 'image2pipe';
        found = runs.find((run) => run.includes(wanted));
        expect_(found, `${kind} の ffmpeg が起きていない`).toBeDefined();
    }).toPass({ timeout: 15_000 });
    return found ?? [];
}

/**
 * 2つが寸分同じ枠に居ること。**組み上がりを待つ。**
 *
 * 開いた直後は幅が決まりきっていないので、1回だけ見比べると稀に外れる
 * (実際に flaky で落ちた)
 */
async function sameBox(a: Locator, b: Locator, expect_: typeof expect): Promise<void> {
    await expect_(async () => {
        expect_(await a.boundingBox()).toEqual(await b.boundingBox());
    }).toPass({ timeout: 5_000 });
}

/**
 * ライブ視聴 ([docs/stream.md](../../docs/stream.md) §4)。映像・音声・字幕まで。
 *
 * **絵が出るところまでは見ない。** E2E の ffmpeg は偽物で、流れてくるのも
 * 本物の TS ではないため、MSE が受け取れる fMP4 にはならず、字幕も1枚も出ない。
 * ここで固定するのはその手前まで — **札を取り、WebSocket が繋がり、チューナーを
 * 掴み、選んだ局が「いま映しているもの」になる**という経路と、**ffmpeg に何を
 * 渡したか**。焼いたものが正しいかどうかは実機で測る話になる。
 */
test.describe('ライブ視聴', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('ヘッダーの「ライブ」から開ける', async ({ page }) => {
        await goto(page, '/');
        await page.getByTestId('nav-live').click();
        await expect(page).toHaveURL(/\/live$/);
        await expect(page.getByTestId('live')).toBeVisible();
    });

    test('右にチャンネルが並ぶ', async ({ page }) => {
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        await expect(channels.first()).toBeVisible();
        expect(await channels.count()).toBeGreaterThan(1);
        // 番組表と同じ並び。地上波はリモコン番号順で先頭に来る
        await expect(channels.first()).toHaveAttribute('data-channel', /^GR\//);
    });

    /*
     * **映像を見ながら選ぶ画面なので、ページごと動かさない。** 動くと絵が
     * 画面から出ていく。動くのは右の一覧だけ
     */
    test('広い画面ではページごとスクロールしない', async ({ page }) => {
        // **低めの画面で見る。** 高いと直す前の作りでも収まってしまい、判別できない
        await page.setViewportSize({ width: 1440, height: 700 });
        await goto(page, '/live');
        await expect(page.getByTestId('live-channel').first()).toBeVisible();

        const doc = await page.evaluate(() => ({
            scrollH: document.documentElement.scrollHeight,
            clientH: document.documentElement.clientHeight,
        }));
        expect(doc.scrollH).toBeLessThanOrEqual(doc.clientH + 1);
    });

    /*
     * **一覧は残りの高さをぜんぶ使う。** 決め打ちで切っていた頃は、画面の下に
     * 余白があるのに一覧のほうが先に終わっていた
     */
    test('チャンネル一覧は表示領域いっぱいまで伸びる', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 700 });
        await goto(page, '/live');
        const list = page.getByTestId('live-channels');
        await expect(list).toBeVisible();

        const box = (await list.boundingBox())!;
        const viewport = page.viewportSize()!;
        // 下端まで、余白ぶん (24px) 以上は空けない
        expect(viewport.height - (box.y + box.height)).toBeLessThanOrEqual(28);
    });

    /*
     * **一覧は種別で切り替える。** 全部縦に並べると、CS の局が100を超える環境で
     * 地上波が上のほうへ流れて見えなくなる。**開いたときは、いま映している局の種別**
     */
    test('チャンネル一覧を地上波/BS/CSで切り替えられる', async ({ page }) => {
        await goto(page, '/live');
        await expect(page.getByTestId('live-type-GR')).toHaveClass(/btn-active/);
        // 地上波を見ているので、一覧に出るのは地上波だけ
        const shown = page.getByTestId('live-channel');
        await expect(shown.first()).toBeVisible();
        for (const channel of await shown.all()) {
            await expect(channel).toHaveAttribute('data-channel', /^GR\//);
        }

        await page.getByTestId('live-type-BS').click();
        await expect(page.getByTestId('live-type-BS')).toHaveClass(/btn-active/);
        await expect(shown.first()).toHaveAttribute('data-channel', /^BS\//);
        // 切り替えただけでは選局しない。見ているものはそのまま
        await expect(page.getByTestId('live-title')).toBeVisible();
    });

    /*
     * **テレビに出ている番号を添える。** 地上波はリモコン番号、BS/CS は
     * サービスID がそのまま3桁番号にあたる (BS朝日1=151)。局名だけだと、
     * テレビで覚えている番号から探せない。
     *
     * 並び自体は SQL の話なので `epg.test.ts` で見ている
     */
    test('チャンネルにテレビと同じ番号が出る', async ({ page }) => {
        await goto(page, '/live');
        const first = page.getByTestId('live-channel').first();
        await expect(first).toBeVisible();
        // 地上波はリモコン番号
        await expect(first.getByTestId('live-number')).toHaveText(/^\d+$/);

        await page.getByTestId('live-type-BS').click();
        await expect(page.getByTestId('live-channel').first()).toBeVisible();
        // BS は3桁番号
        await expect(page.getByTestId('live-channel').first().getByTestId('live-number')).toHaveText(
            /^\d{3}$/,
        );
    });

    /*
     * **押せると分かる形にする。** 平らに並べていた頃は、文字が並んでいるだけに
     * 見えて押せると気付けなかった。枠を持たせ、指の形を変える
     */
    test('チャンネルは押せると分かる形にする', async ({ page }) => {
        await goto(page, '/live');
        const row = page.getByTestId('live-channel').first();
        await expect(row).toBeVisible();
        const look = await row.evaluate((el) => {
            const style = getComputedStyle(el);
            return { cursor: style.cursor, border: Number.parseFloat(style.borderTopWidth) };
        });
        expect(look.cursor).toBe('pointer');
        expect(look.border).toBeGreaterThan(0);
    });

    /*
     * **いま映しているものが分かるようにする。** 色だけだと、色の見え方が違う人に
     * 伝わらないので、文字でも出す
     */
    test('選局中のチャンネルが分かる', async ({ page }) => {
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        const second = channels.nth(1);
        await second.click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await expect(second).toHaveAttribute('data-current', 'true');
        await expect(second).toContainText('視聴中');
        // 印は1つだけ。ほかの行に残っていたら、どれを見ているのか分からない
        expect(await page.locator('[data-testid="live-channel"][data-current="true"]').count()).toBe(1);
    });

    /*
     * **番組表で見つけた番組は、その場から観に行ける。**
     *
     * ライブ画面へ移ってから同じ局を一覧で探し直させるのは遠回りで、局が100を
     * 超える環境では探すほうが手間になる。**局まで名指しで渡す** — 1本の物理
     * チャンネルには複数の局が乗っているので、チャンネルだけでは足りない
     */
    test('番組表の「視聴」から、その局で開く', async ({ page }) => {
        await goto(page, '/guide?type=GR');
        const [target] = await airing(page);
        await cellOf(page, target.programId).getByTestId('program-button').click();

        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await detail.getByTestId('detail-watch').click();

        await expect(page).toHaveURL(new RegExp(`/live\\?service=${target.serviceId}$`));
        const row = page.locator('[data-testid="live-channel"][data-current="true"]');
        await expect(row).toHaveAttribute('data-service', target.serviceId);
    });

    /*
     * **これから放送されるものには出さない。** 押しても、その局のいま流れている
     * 別の番組が映るだけで、押した人の用は済まない
     */
    test('これからの番組には「視聴」を出さない', async ({ page }) => {
        await goto(page, '/guide?type=GR');
        const [target] = await upcoming(page);
        await cellOf(page, target.programId).getByTestId('program-button').click();

        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail.getByTestId('detail-reserve')).toBeVisible();
        await expect(detail.getByTestId('detail-watch')).toHaveCount(0);
    });

    /*
     * **局を選び直すのに繋ぎ直さない。**
     *
     * 取り決めは1本の WebSocket に何度でも `tune` を送れる形になっている
     * (`server/live.ts` の `attend`)。張り直していた頃は、切り替えのたびに
     * 札を取り直して握手し直しており、実測で 100ms 掛かっていた
     */
    test('局を選び直しても繋ぎ直さない', async ({ page }) => {
        await page.addInitScript(() => {
            const counted = window as unknown as { __sockets: number };
            counted.__sockets = 0;
            const Original = window.WebSocket;
            window.WebSocket = class extends Original {
                constructor(url: string | URL, protocols?: string | string[]) {
                    super(url, protocols);
                    counted.__sockets += 1;
                }
            };
        });
        const sockets = () => page.evaluate(() => (window as unknown as { __sockets: number }).__sockets);

        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        await channels.first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        const before = await sockets();
        expect(before).toBeGreaterThan(0);

        const second = channels.nth(1);
        await second.click();
        await expect(second).toHaveAttribute('data-current', 'true');

        expect(await sockets(), '局を変えるたびに繋ぎ直している').toBe(before);
    });

    /*
     * **開いたら、いま映しているものまで送っておく。** 局が100を超える環境では
     * 覚えていた局が画面の外にあるほうが普通で、探させるのはテレビを点けたときの
     * 振る舞いから遠い
     */
    test('開くと、選局中のチャンネルまでスクロールしてある', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 700 });
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        // 下のほうの局を選んでから開き直す
        const last = channels.last();
        const picked = await last.getAttribute('data-channel');
        await last.click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await goto(page, '/live');
        const row = page.locator(`[data-testid="live-channel"][data-channel="${picked}"]`);
        await expect(row).toHaveAttribute('data-current', 'true');
        // 一覧の見えている範囲に入っていること
        const inside = await row.evaluate((el) => {
            const list = el.closest('[data-testid="live-channels"]');
            if (list === null) return false;
            const a = el.getBoundingClientRect();
            const b = list.getBoundingClientRect();
            return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
        });
        expect(inside).toBe(true);
    });

    /*
     * **備え付けの操作は出さない。** あれの再生位置は「持っている範囲」を尺として
     * 描くので、0.05秒ごとに中身が届くたびに右へ左へ動く。放送に終わりは無いので、
     * 位置ではなく張り付いているかどうかを出す
     */
    test('自前の操作列を出し、備え付けは使わない', async ({ page }) => {
        await goto(page, '/live');
        await expect(page.getByTestId('live-video')).not.toHaveAttribute('controls', /.*/);
        await expect(page.getByTestId('live-controls')).toBeVisible();
        await expect(page.getByTestId('live-edge')).toBeVisible();
        await expect(page.getByTestId('live-play')).toBeVisible();

        /*
         * **放送の今に居る間は右端に張り付く。** 実際には貯めているぶん後ろに
         * 居るが、そこを描くと溜まりが増えるたびに摘みが左へ動く — 見ている人には
         * 「勝手に戻っている」としか映らない
         */
        const bar = page.getByTestId('live-seek');
        const at = await bar.evaluate((el) => {
            const input = el as HTMLInputElement;
            return { value: input.value, max: input.max };
        });
        expect(at.value).toBe(at.max);

        /*
         * **アイコンは既存の画面と同じ書き方に揃える** (インラインの SVG)。
         * 絵文字にしていた頃は、端末ごとに形も大きさも変わっていた
         */
        expect(await page.getByTestId('live-play').locator('svg').count()).toBe(1);
        expect(await page.getByTestId('live-sound').locator('svg').count()).toBe(1);
        expect(await page.getByTestId('live-full').locator('svg').count()).toBe(1);
    });

    /*
     * **しばらく触らなければ消える。** 絵の上に居座るものなので、見ている間は
     * 引っ込んでいるほうがいい。止めている間は残す — 止めて眺めているときに
     * 消えると、再開する場所が分からなくなる
     */
    test('操作列は触らないでいると消え、動かすと戻る', async ({ page }) => {
        await goto(page, '/live');
        const controls = page.getByTestId('live-controls');
        await expect(controls).toHaveAttribute('data-shown', 'true');

        await page.mouse.move(400, 300);
        await expect(controls).toHaveAttribute('data-shown', 'true');
        await expect(controls).toHaveAttribute('data-shown', 'false', { timeout: 6000 });
        await page.mouse.move(420, 320);
        await expect(controls).toHaveAttribute('data-shown', 'true');

        // 止めている間は残す
        await page.getByTestId('live-play').click();
        await page.waitForTimeout(3500);
        await expect(controls).toHaveAttribute('data-shown', 'true');
    });

    /*
     * 止める・再開するの繋がりだけ見る。
     *
     * **「止めた所から見られる」ところまでは、ここでは確かめられない。** 偽の
     * ffmpeg が流すものは MSE が受け取れないので、そもそも再生が始まらず、
     * 位置も動かない。動く中身での確認は実機で行う
     */
    test('止める・再開するが繋がっている', async ({ page }) => {
        await goto(page, '/live');
        const button = page.getByTestId('live-play');
        await expect(button).toBeVisible();

        await expect(button).toHaveAttribute('aria-label', '一時停止');
        await button.click();
        await expect(button).toHaveAttribute('aria-label', '再生');
        await button.click();
        await expect(button).toHaveAttribute('aria-label', '一時停止');
    });

    /*
     * **放送に終わりは無いと言っておく。** 何も言わないと MediaSource の尺は
     * 「いま持っている中でいちばん後ろ」になり、0.2秒ごとに中身が届くたびに
     * 伸びる。備え付けの再生位置が右端まで行っては少し左へ戻る、を繰り返す
     */
    test('再生位置に終わりを作らない', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await expect(async () => {
            const duration = await page
                .getByTestId('live-video')
                .evaluate((v) => (v as HTMLVideoElement).duration);
            expect(duration).toBe(Number.POSITIVE_INFINITY);
        }).toPass({ timeout: 15_000 });
    });

    /*
     * **既定で黙らせない。** `muted` を書き付けていた頃は、開いても永久に
     * 無音だった (備え付けの操作で外すまで誰も気付けない)。黙るのは
     * 自動再生を断られたときだけで、そのときは押せる場所を出す
     */
    test('音を止めた状態では始めない', async ({ page }) => {
        await goto(page, '/live');
        await expect(page.getByTestId('live-video')).toBeVisible();
        const muted = await page.getByTestId('live-video').evaluate((v) => (v as HTMLVideoElement).muted);
        expect(muted).toBe(false);
    });

    /*
     * **繋がったことは、掴んだチューナーで分かる。** 画面に絵が出ないので、
     * 「押したら何かが起きた」をこちらで見る。用途に `live` と出るのは
     * ライブ視聴だけなので、これが出ていれば経路は通っている
     */
    test('局を選ぶとチューナーを掴む', async ({ page }) => {
        await goto(page, '/live');
        const target = page.getByTestId('live-channel').first();
        const channel = await target.getAttribute('data-channel');
        await target.click();

        // 選んだ局が「いま映しているもの」になる
        await expect(page.getByTestId('live-title')).toBeVisible();

        await goto(page, '/tuners');
        await expect(page.getByText(/ライブ/).first()).toBeVisible();
        expect(channel).not.toBeNull();
    });

    /*
     * **ffmpeg に渡すのは、放送が名乗っている番号。**
     *
     * 1本の物理チャンネルに複数の局が乗っているので局を名指しするのだが、
     * 渡す番号を間違えると ffmpeg はその局を探して見つけられず、**絵も音も
     * 出ない**。denpa の `services.id` は `network_id * 100000 + service_id` の
     * 内部IDで、TS の中には出てこない — 実際にこれを渡して再生できなくなった。
     */
    test('局は放送が名乗っている番号で名指しする', async ({ page, stack }) => {
        await goto(page, '/live');
        const target = page.getByTestId('live-channel').first();
        await target.click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        const args = await ffmpegArgs(stack.liveArgsFile, 'video', expect);

        // 名指ししている先が、内部IDではなく放送の番号になっていること
        const video = args.find((a) => a.startsWith('0:p:') && a.endsWith(':v:0'));
        expect(video).toBeDefined();
        const named = Number(video?.slice('0:p:'.length, -':v:0'.length));
        const service = SERVICES.find((s) => s.serviceId === named);
        expect(service, `${named} は放送の番号ではない (内部IDを渡していないか)`).toBeDefined();
        expect(args).toContain(`0:p:${named}:a:0`);
    });

    /*
     * **音声は番組表を見て組み立てる。**
     *
     * 選べるものは番組ごとに違う (二カ国語なら主/副/主+副、解説放送なら音声1/音声2)
     * ので、いま流れている番組から起こす (`arib.audioTracks`)。偽の放送は普通の
     * ステレオしか流していないので、**選ぶものは1つ**になるのが正しい。
     *
     * 左右の配り直し (`-af pan=...`) が出ていたら、ステレオをデュアルモノと
     * 取り違えている — **絵は出るので、気付くのは音を聞いたときだけ**
     */
    test('普通のステレオでは音をいじらず、切り替えも出さない', async ({ page, stack }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        const args = await ffmpegArgs(stack.liveArgsFile, 'video', expect);

        expect(args).not.toContain('-af');
        // 1本目の音声をそのまま。何本目かを名指ししていること自体は要る
        expect(args.some((a) => a.endsWith(':a:0'))).toBe(true);

        // 選ぶものが1つしか無いのに切り替えを出すと、押しても何も起きない操作が並ぶ
        await expect(page.getByTestId('live-audio')).toHaveCount(0);
    });

    /*
     * **切り替えの間、前の絵を貼っておく場所を持っておく。**
     *
     * 選局にかかる 1.6 秒は削れない (電波の同期待ち 0.65秒 + 放送の MPEG-2 が
     * GOP の頭を待つ 0.75秒)。待ちは変わらないが、その間を真っ黒にしないために
     * 直前の1枚を canvas へ写して重ねる。
     *
     * 貼っていない間は**押す邪魔をしてはいけない** — 映像の上に敷くものなので、
     * 透けているだけでは足りず、当たり判定も抜けている必要がある
     */
    test('切り替え中に貼る絵は、操作の邪魔をしない', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();

        const still = page.getByTestId('live-still');
        await expect(still).toHaveAttribute('data-holding', 'false');
        await expect(still).toHaveCSS('pointer-events', 'none');
        // 映像と同じ場所に重なっていること。ずれていると絵が飛んで見える
        await sameBox(still, page.getByTestId('live-video'), expect);
    });

    /*
     * **放送の字幕は絵で来る。** 文字ではないので `<track>` ではなく canvas に重ねる
     * (放送に乗っているのは文字と描き方の指定で、テレビはそれを見て毎回自分で描く。
     * サーバ側で libaribcaption に描かせたものを送るので、録画で見る字幕と同じ絵になる)。
     *
     * 偽の放送に字幕は乗っていないので、ここで見られるのは敷き方まで。
     * **映像と寸分同じ枠に、当たり判定を抜いて敷く** — ずれると字幕が飛び、
     * 抜けていないと下の操作列が押せなくなる。
     */
    test('字幕を重ねる場所は、映像と同じ枠で、押す邪魔をしない', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();

        const captions = page.getByTestId('live-captions');
        await expect(captions).toHaveCSS('pointer-events', 'none');
        await sameBox(captions, page.getByTestId('live-video'), expect);

        // 字幕の来ていない番組で切り替えを出すと、押しても何も起きない操作が並ぶ
        await expect(captions).toHaveAttribute('data-on', 'false');
        await expect(page.getByTestId('live-caption')).toHaveCount(0);
    });

    /*
     * **字幕は映像とは別の ffmpeg で取り出す。** 局を選ぶと2本起きる。
     *
     * ここで固定するのは、間違えても**絵は出てしまう**種類の指定。
     *
     * - `-copyts` … 無いと ffmpeg は字幕1枚目を 0 秒として数え直す
     *   (フィルタに入れるのが字幕1本だけで、基準になる映像がこちら側に無い)。
     *   映像と同じ物差しでなくなるので、字幕が丸ごとずれる
     * - `-canvas_size` … 無いと libaribcaption は 1440x1080 とみなすので、
     *   1920x1080 の放送では字幕だけ横に伸びる
     * - PNG で受ける … 生の RGBA だと毎秒 13MB 流れる。実機で測ると PNG のほうが
     *   速い (30秒ぶんで 1.05秒 対 1.94秒)
     */
    test('字幕は別の ffmpeg で、映像と同じ物差しで取り出す', async ({ page, stack }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        const args = await ffmpegArgs(stack.liveArgsFile, 'captions', expect);
        expect(args).toContain('-copyts');
        expect(args[args.indexOf('-canvas_size') + 1]).toMatch(/^\d+x\d+$/);
        expect(args[args.indexOf('-sub_type') + 1]).toBe('bitmap');
        expect(args).not.toContain('rawvideo');

        // 字幕も局を名指しする。1本の物理チャンネルに複数の局が乗っている
        const filter = args[args.indexOf('-filter_complex') + 1];
        expect(filter).toMatch(/^\[0:p:\d+:s:0\]showinfo/);
    });

    /*
     * **前回見ていたチャンネルで開く。** テレビを点けたときと同じ振る舞いで、
     * 毎回いちばん上の局から始まると、いつも選び直すことになる
     */
    test('開き直すと、前回見ていた局から始まる', async ({ page }) => {
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        // 先頭以外を選ぶ。先頭だと「覚えている」のか「既定」なのか見分けが付かない
        const second = channels.nth(1);
        const picked = await second.getAttribute('data-channel');
        await second.click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await goto(page, '/live');
        // 覚えていた局が選ばれた状態で開く
        await expect(page.locator(`[data-testid="live-channel"][data-channel="${picked}"]`)).toHaveAttribute(
            'data-current',
            'true',
        );
    });

    /*
     * **札は使い捨て。** URL は履歴にもログにも残るので、拾われても二度目は
     * 通らない。ここが緩むと、チューナーを掴む口が素通しになる
     */
    test('札なしでは WebSocket に繋げない', async ({ page }) => {
        await goto(page, '/live');
        const status = await page.evaluate(
            () =>
                new Promise<string>((resolve) => {
                    const ws = new WebSocket(
                        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live/socket`,
                    );
                    ws.onopen = () => resolve('開いた');
                    ws.onerror = () => resolve('断られた');
                    ws.onclose = () => resolve('断られた');
                    setTimeout(() => resolve('無反応'), 3000);
                }),
        );
        expect(status).toBe('断られた');
    });
});
