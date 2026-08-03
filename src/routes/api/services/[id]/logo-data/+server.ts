import { error } from '@sveltejs/kit';
import { readLearnedLogo } from '$lib/server/logo-data';

/**
 * その局について logoframe が**覚えたロゴ**を絵にして返す。
 *
 * 番組表に出すロゴ (`/api/services/<id>/logo`) とは別物。あちらは放送波から
 * 拾った局のマークで、こちらは「画面のどこにロゴが出ているか」を録画から
 * 学習したもの。覚えているものが絵になっていない (ロゴではない縁を拾った) とき、
 * それを確かめる手立てが無かったので出す。
 *
 * 濃さをそのまま明るさにした白黒。原寸は小さいので (実機の TOKYO MX で 48×158)、
 * 出す側で拡大する。
 */
export function GET({ params }) {
    const logo = readLearnedLogo(Number(params.id));
    if (logo === null) throw error(404, 'まだロゴを覚えていません');

    return new Response(new Uint8Array(logo.png), {
        headers: {
            'Content-Type': 'image/png',
            // 覚え直すまで中身は変わらないが、覚え直したらすぐ見たい
            'Cache-Control': 'no-cache',
            /*
             * 覚えている枠と濃さ。**記録されているコマの座標**で、地上波のHDなら
             * 1440×1080 の中の位置。絵と一緒に数字も出したいので見出しで渡す
             * (コマの取り出しが X-Source-Width を渡しているのと同じやり方)
             */
            'X-Logo-Area': `${logo.x},${logo.y},${logo.width},${logo.height}`,
            'X-Logo-Depth': String(logo.depth),
            'X-Logo-Name': encodeURIComponent(logo.name),
            // いつ覚えたか。「CM判定に失敗」の記録より新しければ、その失敗は別のロゴのもの
            'X-Logo-Learned-At': String(logo.learnedAt),
        },
    });
}
