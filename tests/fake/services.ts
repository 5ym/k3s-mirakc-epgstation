/** 偽エージェントが返す局。テスト側からもIDを参照するのでここに置く */
export interface FakeService {
    id: number;
    serviceId: number;
    networkId: number;
    name: string;
    type: 'GR' | 'BS';
    channel: string;
    /**
     * 1番組の長さ。
     * 地上波は本物らしい30分にして番組表のグリッドが成立するようにし、
     * BSだけ10秒にして「録画が終わるまで待つ」テストを現実的な時間で回す。
     */
    slotMs: number;
    /** ARIB のサービス種別。1 がデジタルTV、192 はデータ/ワンセグ */
    serviceType: number;
    /**
     * この中継にロゴのデータカルーセルが載っているか (衛星だけ)。
     *
     * **本物は1つの中継にしか載っていない。** 実機の BS はネットワーク4の
     * 26中継のうち `BS15_0` だけで、CS は12中継のどれにも無かった。
     * 全部の中継に載せてしまうと、外れを見切って次へ行く道が試されない
     */
    carousel?: boolean;
    /**
     * 番組表を出さない局。
     *
     * ロゴの中継まわりを見るためだけに置いてある局は、番組まで生やすと
     * 他のテストが数えている番組の本数がずれる。**まだその局の番組表を
     * 集めていない状態**は本物でも普通に起きるので、無理は無い
     */
    noPrograms?: boolean;
}

export const SERVICES: FakeService[] = [
    {
        id: 3239123608,
        serviceId: 23608,
        networkId: 32391,
        name: 'ＴＯＫＹＯ　ＭＸ',
        type: 'GR',
        channel: 'T16',
        slotMs: 30 * 60_000,
        serviceType: 1,
    },
    {
        id: 3274301064,
        serviceId: 1064,
        networkId: 32743,
        name: 'フジテレビ',
        type: 'GR',
        channel: 'T21',
        slotMs: 30 * 60_000,
        serviceType: 1,
    },
    // データ放送。映像が入っていないので録画対象にしてはいけない。
    // 実機ではこれを録ってしまい、中身の無いファイルで失敗していた
    {
        id: 3239100700,
        serviceId: 700,
        networkId: 32391,
        name: 'ＭＸデータ１',
        type: 'GR',
        channel: 'T16',
        slotMs: 30 * 60_000,
        serviceType: 192,
    },
    {
        id: 400211,
        serviceId: 211,
        networkId: 4,
        name: 'ＢＳ１１イレブン',
        type: 'BS',
        channel: 'BS11_0',
        slotMs: 5_000,
        serviceType: 1,
        carousel: true,
    },
    /*
     * ロゴの載っていない中継。**実機ではこちらが多数派。**
     * BS は26中継のうち25、CS は12中継すべてがこれで、開いても永久に来ない。
     * 見切って次へ行けないと、10分ごとに何十分もチューナーを塞ぐことになる
     */
    {
        id: 400171,
        serviceId: 171,
        networkId: 4,
        name: 'ＢＳテレ東',
        type: 'BS',
        channel: 'BS03_0',
        slotMs: 30 * 60_000,
        serviceType: 1,
        noPrograms: true,
    },
];

export const MX = SERVICES[0];
export const FUJI = SERVICES[1];
export const DATA = SERVICES[2];
export const BS11 = SERVICES[3];
export const BS_NO_LOGO = SERVICES[4];
