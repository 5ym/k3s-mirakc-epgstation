"""tsinfo の単体テスト。

実チューナーが無いので、NIT と SDT を組み立てて食わせる。
セクションがパケットをまたぐ場合も作って、繋ぎ直しを確かめる。
"""

import unittest

from tsinfo import PACKET, SYNC, ServiceReader, crc32, parse_nit, parse_sdt


def with_crc(body):
    """セクション本体に CRC32 を付ける。section_length も実長に直す"""
    section = bytearray(body)
    length = len(section) - 3 + 4
    section[1] = 0xB0 | ((length >> 8) & 0x0F)
    section[2] = length & 0xFF
    return bytes(section) + crc32(bytes(section)).to_bytes(4, 'big')


def sdt_section(transport_stream_id, original_network_id, services):
    body = bytearray(
        [0x42, 0x00, 0x00]
        + list(transport_stream_id.to_bytes(2, 'big'))
        + [0xC1, 0x00, 0x00]
        + list(original_network_id.to_bytes(2, 'big'))
        + [0xFF]
    )
    for service_id, service_type in services:
        # service_descriptor (0x48): 種別 + 事業者名 + サービス名
        descriptor = bytes([0x48, 0x03, service_type, 0x00, 0x00])
        body += service_id.to_bytes(2, 'big')
        body += bytes([0xFC])
        body += (0x8000 | len(descriptor)).to_bytes(2, 'big')
        body += descriptor
    return with_crc(body)


def nit_section(network_id, remote_control_key_id, streams):
    body = bytearray([0x40, 0x00, 0x00] + list(network_id.to_bytes(2, 'big')) + [0xC1, 0x00, 0x00])
    body += (0xF000).to_bytes(2, 'big')  # network_descriptors_length = 0

    loop = bytearray()
    for transport_stream_id, original_network_id, services in streams:
        descriptors = bytearray()
        if remote_control_key_id is not None:
            # TS information descriptor (0xCD)
            descriptors += bytes([0xCD, 0x02, remote_control_key_id, 0x00])
        service_list = bytearray()
        for service_id, service_type in services:
            service_list += service_id.to_bytes(2, 'big') + bytes([service_type])
        descriptors += bytes([0x41, len(service_list)]) + service_list

        loop += transport_stream_id.to_bytes(2, 'big')
        loop += original_network_id.to_bytes(2, 'big')
        loop += (0xF000 | len(descriptors)).to_bytes(2, 'big')
        loop += descriptors

    body += (0xF000 | len(loop)).to_bytes(2, 'big')
    body += loop
    return with_crc(body)


def packetize(pid, section, counter=0, payload_size=PACKET - 4):
    """セクションを TS パケットに詰める。頭のパケットには pointer_field が付く"""
    packets = []
    data = bytes([0x00]) + section  # pointer_field = 0
    first = True
    while data:
        room = payload_size
        chunk, data = data[:room], data[room:]
        header = bytes(
            [SYNC, (0x40 if first else 0x00) | (pid >> 8), pid & 0xFF, 0x10 | (counter & 0x0F)]
        )
        body = chunk + bytes([0xFF] * (PACKET - 4 - len(chunk)))
        packets.append(header + body)
        counter += 1
        first = False
    return b''.join(packets)


class TestSections(unittest.TestCase):
    def test_sdt_reads_services(self):
        section = sdt_section(0x0408, 0x0004, [(1024, 0x01), (1025, 0x01)])
        parsed = parse_sdt(section)
        self.assertEqual(parsed['transportStreamId'], 0x0408)
        self.assertEqual(parsed['originalNetworkId'], 0x0004)
        self.assertEqual(
            parsed['services'],
            [
                {'serviceId': 1024, 'serviceType': 0x01},
                {'serviceId': 1025, 'serviceType': 0x01},
            ],
        )

    def test_nit_reads_network_and_remote_key(self):
        section = nit_section(0x7FE0, 6, [(0x0408, 0x0004, [(1024, 0x01)])])
        parsed = parse_nit(section)
        self.assertEqual(parsed['networkId'], 0x7FE0)
        self.assertEqual(parsed['remoteControlKeyId'], 6)
        self.assertEqual(parsed['transportStreams'][0]['transportStreamId'], 0x0408)
        self.assertEqual(parsed['transportStreams'][0]['services'][0]['serviceId'], 1024)

    def test_broken_crc_is_dropped(self):
        section = bytearray(sdt_section(0x0408, 0x0004, [(1024, 0x01)]))
        section[-1] ^= 0xFF
        reader = ServiceReader()
        reader.feed(packetize(0x0011, bytes(section)))
        self.assertIsNone(reader.transport)


class TestServiceReader(unittest.TestCase):
    def stream(self, **kwargs):
        nit = packetize(0x0010, nit_section(0x7FE0, 6, [(0x0408, 0x0004, [(1024, 0x01)])]), **kwargs)
        sdt = packetize(
            0x0011, sdt_section(0x0408, 0x0004, [(1024, 0x01), (2048, 0xC1)]), counter=3, **kwargs
        )
        return nit + sdt

    def test_waits_for_both_nit_and_sdt(self):
        reader = ServiceReader()
        nit = packetize(0x0010, nit_section(0x7FE0, 6, [(0x0408, 0x0004, [(1024, 0x01)])]))
        self.assertFalse(reader.feed(nit))
        self.assertEqual(reader.services(), [])

        sdt = packetize(0x0011, sdt_section(0x0408, 0x0004, [(1024, 0x01)]))
        self.assertTrue(reader.feed(sdt))

    def test_drops_services_without_video(self):
        reader = ServiceReader()
        reader.feed(self.stream())
        # 0xC1 は蓄積型サービス。Mirakurun のスキャンが通す種別に入っていない
        self.assertEqual([s['serviceId'] for s in reader.services()], [1024])

    def test_carries_network_id_and_remote_key(self):
        reader = ServiceReader()
        reader.feed(self.stream())
        service = reader.services()[0]
        self.assertEqual(service['networkId'], 0x7FE0)
        self.assertEqual(service['transportStreamId'], 0x0408)
        self.assertEqual(service['remoteControlKeyId'], 6)

    def test_section_split_across_packets(self):
        # 1パケットに収まらない長さにして、繋ぎ直しが効いていることを見る
        reader = ServiceReader()
        many = [(1024 + i, 0x01) for i in range(40)]
        reader.feed(packetize(0x0010, nit_section(0x7FE0, 6, [(0x0408, 0x0004, many)])))
        reader.feed(packetize(0x0011, sdt_section(0x0408, 0x0004, many)))
        self.assertTrue(reader.complete)
        self.assertEqual(len(reader.services()), 40)

    def test_chunks_not_aligned_to_packets(self):
        # 実際の入力は 188 の切れ目と無関係に届く
        reader = ServiceReader()
        data = self.stream()
        for at in range(0, len(data), 100):
            reader.feed(data[at : at + 100])
        self.assertTrue(reader.complete)
        self.assertEqual([s['serviceId'] for s in reader.services()], [1024])

    def test_ignores_other_pids(self):
        reader = ServiceReader()
        reader.feed(packetize(0x0100, sdt_section(0x0408, 0x0004, [(1024, 0x01)])))
        self.assertIsNone(reader.transport)


if __name__ == '__main__':
    unittest.main()
