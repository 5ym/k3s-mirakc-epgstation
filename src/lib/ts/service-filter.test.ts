import { describe, expect, test } from 'bun:test';
import { PACKET } from './psi';
import { ServiceFilter } from './service-filter';
import { packetize, patSection, programMap } from './synth';

/** MX1 と MX2 が同じ TS に乗っている、実機と同じ形 */
const MX1 = 23608;
const MX2 = 23609;
const PMT1 = 0x1f0;
const PMT2 = 0x1f1;

/** 適当な中身のパケットを1つ作る。PID だけ合っていればいい */
function payload(pid: number, counter = 0): Uint8Array {
    const out = new Uint8Array(PACKET).fill(0x00);
    out[0] = 0x47;
    out[1] = (pid >> 8) & 0x1f;
    out[2] = pid & 0xff;
    out[3] = 0x10 | (counter & 0x0f);
    return out;
}

const pat = () =>
    packetize(
        0x0000,
        patSection([
            [MX1, PMT1],
            [MX2, PMT2],
        ]),
    );

/** MX1 は映像 0x100・音声 0x110、MX2 は 0x200・0x210 */
const pmt1 = () =>
    packetize(
        PMT1,
        programMap(
            MX1,
            0x100,
            [
                [0x02, 0x100],
                [0x0f, 0x110],
            ],
            0x900,
        ),
    );
const pmt2 = () =>
    packetize(
        PMT2,
        programMap(MX2, 0x200, [
            [0x02, 0x200],
            [0x0f, 0x210],
        ]),
    );

/** 出てきたバイト列から PID を並べる */
function pids(data: Uint8Array): number[] {
    const out: number[] = [];
    for (let at = 0; at + PACKET <= data.length; at += PACKET) {
        out.push(((data[at + 1] & 0x1f) << 8) | data[at + 2]);
    }
    return out;
}

describe('局の選り分け', () => {
    test('PAT が来るまでは何も出さない', () => {
        const filter = new ServiceFilter(MX1);
        expect(filter.ready).toBe(false);
        expect(filter.filter(payload(0x100))).toHaveLength(0);
    });

    test('自局の ES だけ通す。相乗りしている局は落とす', () => {
        const filter = new ServiceFilter(MX1);
        filter.filter(Uint8Array.from([...pat(), ...pmt1(), ...pmt2()]));
        expect(filter.ready).toBe(true);

        const out = filter.filter(
            Uint8Array.from([
                ...payload(0x100), // MX1 映像
                ...payload(0x110), // MX1 音声
                ...payload(0x200), // MX2 映像 → 落とす
                ...payload(0x210), // MX2 音声 → 落とす
            ]),
        );
        expect(pids(out)).toEqual([0x100, 0x110]);
    });

    test('ECM は残す。掛かったまま録れたものを後から解くのに要る', () => {
        const filter = new ServiceFilter(MX1);
        filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
        expect(pids(filter.filter(payload(0x900)))).toEqual([0x900]);
    });

    test('局に関係ない表 (NIT/SDT/EIT/TDT/CAT) は残す', () => {
        const filter = new ServiceFilter(MX1);
        filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
        const out = filter.filter(
            Uint8Array.from([
                ...payload(0x0001),
                ...payload(0x0010),
                ...payload(0x0011),
                ...payload(0x0012),
                ...payload(0x0014),
            ]),
        );
        expect(pids(out)).toEqual([0x0001, 0x0010, 0x0011, 0x0012, 0x0014]);
    });

    test('詰め物 (PID 0x1FFF) は落とす', () => {
        const filter = new ServiceFilter(MX1);
        filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
        expect(filter.filter(payload(0x1fff))).toHaveLength(0);
    });

    /**
     * **ここが目的。** 丸ごと通すと ffmpeg には2つのプログラムが見えて、
     * 1つ目のつもりで読んだ値が2つ目のものだったりする
     */
    test('PAT はその局1つだけに書き直す', () => {
        const filter = new ServiceFilter(MX1);
        const out = filter.filter(Uint8Array.from([...pat(), ...pmt1()]));
        // PAT は1パケットに収まる。先頭に出てくるはず
        expect(pids(out)[0]).toBe(0x0000);

        const section = out.subarray(5, 5 + 20);
        expect(section[0]).toBe(0x00);
        const programs: number[] = [];
        const length = ((section[1] & 0x0f) << 8) | section[2];
        for (let at = 8; at + 4 <= 3 + length - 4; at += 4) {
            programs.push((section[at] << 8) | section[at + 1]);
        }
        // 0 は NIT の枠。局は MX1 だけ
        expect(programs).toEqual([0, MX1]);
    });

    test('PMT そのものは通す。読む側が ES の意味を知るのに要る', () => {
        const filter = new ServiceFilter(MX1);
        const out = filter.filter(Uint8Array.from([...pat(), ...pmt1(), ...pmt2()]));
        expect(pids(out)).toContain(PMT1);
        expect(pids(out)).not.toContain(PMT2);
    });
});
