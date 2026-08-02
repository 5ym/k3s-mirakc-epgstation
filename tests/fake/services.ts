/** 偽mirakcが返す局。テスト側からもIDを参照するのでここに置く */
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
    },
];

export const MX = SERVICES[0];
export const FUJI = SERVICES[1];
export const DATA = SERVICES[2];
export const BS11 = SERVICES[3];
