"""scan の単体テスト。

チューナーの代わりに、組み立てた TS を吐くだけのコマンドを使う。
選局から設定の組み立てまで、実際に子プロセスを回して確かめる。
"""

import os
import tempfile
import unittest

import scan
from test_tsinfo import nit_section, packetize, sdt_section


class TestChannels(unittest.TestCase):
    def test_terrestrial_covers_13_to_62(self):
        channels = scan.channels_for('GR')
        self.assertEqual(channels[0], 'T13')
        self.assertEqual(channels[-1], 'T62')
        self.assertEqual(len(channels), 50)

    def test_bs_has_four_slots_per_channel(self):
        channels = scan.channels_for('BS')
        self.assertEqual(channels[:5], ['BS01_0', 'BS01_1', 'BS01_2', 'BS01_3', 'BS02_0'])
        self.assertEqual(len(channels), 23 * 4)

    def test_cs_starts_at_2(self):
        self.assertEqual(scan.channels_for('CS')[0], 'CS02')

    def test_range_is_clamped_to_what_exists(self):
        # 範囲を広げても放送に無いチャンネルは足さない
        self.assertEqual(scan.channels_for('GR', 1, 999)[0], 'T13')
        self.assertEqual(scan.channels_for('GR', 1, 999)[-1], 'T62')
        self.assertEqual(scan.channels_for('GR', 20, 22), ['T20', 'T21', 'T22'])


class TestRender(unittest.TestCase):
    def test_fills_mirakc_template(self):
        command = 'recisdb tune --device /dev/dvb/adapter0/frontend0 --channel {{{channel}}} -'
        self.assertEqual(
            scan.render(command, 'T27', 'GR'),
            'recisdb tune --device /dev/dvb/adapter0/frontend0 --channel T27 -',
        )

    def test_fills_channel_type_and_duration(self):
        self.assertEqual(scan.render('x {{channel_type}} {{{duration}}}', 'T27', 'GR'), 'x GR -')

    def test_unknown_placeholder_becomes_empty(self):
        self.assertEqual(scan.render('a {{{extra_args}}} b', 'T27', 'GR'), 'a  b')


class TestChannelEntry(unittest.TestCase):
    def test_lists_found_services(self):
        entry = scan.channel_entry('GR', 'T27', [{'serviceId': 1032}, {'serviceId': 1024}])
        self.assertEqual(entry, {'name': 'T27', 'type': 'GR', 'channel': 'T27', 'services': [1024, 1032]})


def write_stream(path, services):
    """NIT と SDT だけの TS。チューナーが吐くものの代わり"""
    nit = packetize(0x0010, nit_section(0x7FE0, 6, [(0x0408, 0x0004, [(1024, 0x01)])]))
    sdt = packetize(0x0011, sdt_section(0x0408, 0x0004, services), counter=3)
    with open(path, 'wb') as out:
        # 頭に無関係なパケットを混ぜておく。すぐには揃わない状況にするため
        out.write(packetize(0x0100, sdt_section(0x0408, 0x0004, services)))
        out.write(nit + sdt)


class TestReadServices(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.stream = os.path.join(self.dir, 'stream.ts')

    def test_reads_services_from_the_tuner_output(self):
        write_stream(self.stream, [(1024, 0x01), (1025, 0x01)])
        services, error = scan.read_services(f'cat {self.stream}', timeout=5)
        self.assertIsNone(error)
        self.assertEqual([s['serviceId'] for s in services], [1024, 1025])
        self.assertEqual(services[0]['remoteControlKeyId'], 6)

    def test_no_signal_when_the_tuner_writes_nothing(self):
        services, error = scan.read_services('true', timeout=5)
        self.assertIsNone(services)
        self.assertEqual(error, '受信できませんでした')

    def test_gives_up_when_only_half_arrives(self):
        # SDT だけ。どのネットワークのものか分からないので設定には書けない
        with open(self.stream, 'wb') as out:
            out.write(packetize(0x0011, sdt_section(0x0408, 0x0004, [(1024, 0x01)])))
        services, error = scan.read_services(f'cat {self.stream}; sleep 5', timeout=2)
        self.assertIsNone(services)
        self.assertEqual(error, '受信できませんでした')

    def test_stops_as_soon_as_both_tables_are_in(self):
        # 揃ったら打ち切る。居る局で毎回 20 秒待っていたら総当たりが終わらない
        write_stream(self.stream, [(1024, 0x01)])
        started = __import__('time').monotonic()
        services, error = scan.read_services(f'cat {self.stream}; sleep 30', timeout=30)
        self.assertIsNone(error)
        self.assertLess(__import__('time').monotonic() - started, 10)


class TestScanner(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.stream = os.path.join(self.dir, 'stream.ts')
        write_stream(self.stream, [(1024, 0x01)])

    def test_builds_channel_definitions(self):
        tuners = [{'name': 'a', 'types': ['GR'], 'command': f'cat {self.stream}'}]
        found = scan.Scanner(tuners).run([('GR', ['T20', 'T21'])])
        self.assertEqual([c['channel'] for c in found], ['T20', 'T21'])
        self.assertEqual(found[0]['services'], [1024])

    def test_skips_types_without_a_tuner(self):
        lines = []
        tuners = [{'name': 'a', 'types': ['GR'], 'command': f'cat {self.stream}'}]
        scanner = scan.Scanner(tuners, on_progress=lambda **kw: lines.append(kw.get('line')))
        self.assertEqual(scanner.run([('BS', ['BS01_0'])]), [])
        self.assertIn('BS: 対応するチューナーがありません', lines)

    def test_ignores_disabled_tuners(self):
        tuners = [{'name': 'a', 'types': ['GR'], 'command': f'cat {self.stream}', 'disabled': True}]
        self.assertEqual(scan.Scanner(tuners).run([('GR', ['T20'])]), [])

    def test_channels_without_signal_are_left_out(self):
        tuners = [{'name': 'a', 'types': ['GR'], 'command': 'true'}]
        self.assertEqual(scan.Scanner(tuners).run([('GR', ['T20', 'T21'])]), [])


if __name__ == '__main__':
    unittest.main()
