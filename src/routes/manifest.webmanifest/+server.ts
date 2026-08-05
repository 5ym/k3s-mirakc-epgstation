import { manifest } from '$lib/server/manifest';

/**
 * PWA のマニフェスト。**静的ファイルではなく、ここで組み立てる。**
 *
 * 表示名を**どの名前で来たかで変えたい**ため (`manifest.ts`)。static に
 * 置いたままだと、外向きと LAN 用で同じものが返り、ホーム画面に同じ名前の
 * アイコンが2つ並ぶ。
 */
export function GET({ url, setHeaders }) {
    /*
     * **覚えさせない。** 名前を変えたときに、古い名前のまま入れ直されるのを
     * 避ける。1回きりの小さな JSON なので、毎回聞かせても困らない
     */
    setHeaders({ 'cache-control': 'no-cache' });
    return new Response(JSON.stringify(manifest(url.hostname)), {
        headers: { 'content-type': 'application/manifest+json' },
    });
}
