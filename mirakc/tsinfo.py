"""TS から局の一覧を読む。チャンネルスキャンで「この物理チャンネルに何が居るか」を知るために使う。

必要なのは NIT と SDT の2つだけ。

* NIT (PID 0x0010) … ネットワークID と、地上波ならリモコン番号
* SDT (PID 0x0011) … その TS に入っているサービスのIDと種別

局名は読まない。ARIB の文字符号は独自で、まともに解くには外字や漢字集合まで
面倒を見ることになる。名前は mirakc が起動後に自分で拾うので、こちらは
「どの物理チャンネルに何番のサービスが居るか」だけ分かればよい。
"""

PACKET = 188
SYNC = 0x47

PID_NIT = 0x0010
PID_SDT = 0x0011

TABLE_NIT_ACTUAL = 0x40
TABLE_SDT_ACTUAL = 0x42

DESC_SERVICE_LIST = 0x41
DESC_SERVICE = 0x48
DESC_TS_INFORMATION = 0xCD

# 録るに値するサービス種別。Mirakurun のスキャンが通しているものと同じ。
# データ放送やワンセグを混ぜると、映像の無いものが番組表に並ぶ
SERVICE_TYPES = frozenset([0x01, 0x02, 0xA1, 0xA4, 0xA5, 0xAD, 0xC0])

CRC32_POLY = 0x04C11DB7


def _crc32_table():
    table = []
    for i in range(256):
        crc = i << 24
        for _ in range(8):
            crc = ((crc << 1) ^ CRC32_POLY) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
        table.append(crc)
    return table


_CRC32 = _crc32_table()


def crc32(data):
    """MPEG-2 の CRC32。セクション末尾の4バイトを含めて回すと 0 になる"""
    crc = 0xFFFFFFFF
    for byte in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC32[((crc >> 24) ^ byte) & 0xFF]
    return crc


class SectionAssembler:
    """PSI セクションを組み立てる。

    セクションは TS パケットをまたいで運ばれ、パケットの切れ目とは無関係な
    位置で終わる。payload_unit_start_indicator と pointer_field を見て
    頭を合わせ、section_length ぶん溜まったら1本として吐く。
    """

    def __init__(self, pid):
        self.pid = pid
        self.buffer = bytearray()
        self.want = 0

    def feed(self, packet):
        """パケットを1つ食わせる。組み上がったセクションを返す"""
        if packet[0] != SYNC:
            return []
        pid = ((packet[1] & 0x1F) << 8) | packet[2]
        if pid != self.pid:
            return []
        # トランスポートエラーが立っているものは信用しない
        if packet[1] & 0x80:
            return []

        adaptation = (packet[3] >> 4) & 0x03
        if adaptation in (0, 2):
            return []
        offset = 4
        if adaptation == 3:
            offset += 1 + packet[4]
        if offset >= PACKET:
            return []

        payload = packet[offset:]
        started = bool(packet[1] & 0x40)
        if started:
            pointer = payload[0]
            if 1 + pointer > len(payload):
                return []
            # pointer_field の手前は前のセクションの続き
            self._append(payload[1 : 1 + pointer])
            done = self._flush()
            self.buffer = bytearray(payload[1 + pointer :])
            self.want = 0
            return done + self._flush()

        self._append(payload)
        return self._flush()

    def _append(self, data):
        if self.buffer or self.want:
            self.buffer += data

    def _flush(self):
        sections = []
        while True:
            if len(self.buffer) < 3:
                return sections
            # 詰め物。ここから先にセクションは無い
            if self.buffer[0] == 0xFF:
                self.buffer = bytearray()
                return sections
            length = 3 + (((self.buffer[1] & 0x0F) << 8) | self.buffer[2])
            if len(self.buffer) < length:
                return sections
            section = bytes(self.buffer[:length])
            self.buffer = self.buffer[length:]
            # 壊れたセクションを読むと嘘の局が並ぶので、CRC を通ったものだけ使う
            if crc32(section) == 0:
                sections.append(section)


def descriptors(data):
    """記述子の並びを (tag, 中身) に切り分ける"""
    at = 0
    while at + 2 <= len(data):
        tag = data[at]
        length = data[at + 1]
        body = data[at + 2 : at + 2 + length]
        if len(body) < length:
            return
        yield tag, body
        at += 2 + length


def parse_sdt(section):
    """SDT からサービスの一覧を読む。自分の TS のものだけ"""
    if section[0] != TABLE_SDT_ACTUAL:
        return None
    transport_stream_id = (section[3] << 8) | section[4]
    original_network_id = (section[8] << 8) | section[9]

    services = []
    at = 11
    end = len(section) - 4
    while at + 5 <= end:
        service_id = (section[at] << 8) | section[at + 1]
        loop = ((section[at + 3] & 0x0F) << 8) | section[at + 4]
        body = section[at + 5 : at + 5 + loop]
        at += 5 + loop

        for tag, descriptor in descriptors(body):
            if tag == DESC_SERVICE and descriptor:
                services.append({'serviceId': service_id, 'serviceType': descriptor[0]})
                break

    return {
        'transportStreamId': transport_stream_id,
        'originalNetworkId': original_network_id,
        'services': services,
    }


def parse_nit(section):
    """NIT からネットワークIDとリモコン番号、他の TS の顔ぶれを読む"""
    if section[0] != TABLE_NIT_ACTUAL:
        return None
    network_id = (section[3] << 8) | section[4]

    network_length = ((section[8] & 0x0F) << 8) | section[9]
    at = 10 + network_length
    if at + 2 > len(section):
        return None
    at += 2  # transport_stream_loop_length

    remote_control_key_id = None
    streams = []
    end = len(section) - 4
    while at + 6 <= end:
        transport_stream_id = (section[at] << 8) | section[at + 1]
        original_network_id = (section[at + 2] << 8) | section[at + 3]
        loop = ((section[at + 4] & 0x0F) << 8) | section[at + 5]
        body = section[at + 6 : at + 6 + loop]
        at += 6 + loop

        services = []
        for tag, descriptor in descriptors(body):
            if tag == DESC_TS_INFORMATION and descriptor and remote_control_key_id is None:
                remote_control_key_id = descriptor[0]
            elif tag == DESC_SERVICE_LIST:
                for i in range(0, len(descriptor) - 2, 3):
                    services.append(
                        {
                            'serviceId': (descriptor[i] << 8) | descriptor[i + 1],
                            'serviceType': descriptor[i + 2],
                        }
                    )
        streams.append(
            {
                'transportStreamId': transport_stream_id,
                'originalNetworkId': original_network_id,
                'services': services,
            }
        )

    return {
        'networkId': network_id,
        'remoteControlKeyId': remote_control_key_id,
        'transportStreams': streams,
    }


class ServiceReader:
    """流れてくる TS を食べて、NIT と SDT が揃うまで待つ。

    Mirakurun のスキャンと同じで、**両方**揃って初めてそのチャンネルを
    「受信できた」とみなす。SDT だけ取れても、どのネットワークのものか
    分からないと設定に書けない。
    """

    def __init__(self):
        self.nit_assembler = SectionAssembler(PID_NIT)
        self.sdt_assembler = SectionAssembler(PID_SDT)
        self.network = None
        self.transport = None
        self.rest = b''

    @property
    def complete(self):
        return self.network is not None and self.transport is not None

    def feed(self, chunk):
        """任意の長さのバイト列を食わせる。揃ったら True"""
        data = self.rest + chunk
        # 188 の切れ目に関係なく届くので、半端は次に回す
        usable = len(data) - (len(data) % PACKET)
        for at in range(0, usable, PACKET):
            packet = data[at : at + PACKET]
            if self.network is None:
                for section in self.nit_assembler.feed(packet):
                    self.network = parse_nit(section) or self.network
            if self.transport is None:
                for section in self.sdt_assembler.feed(packet):
                    self.transport = parse_sdt(section) or self.transport
        self.rest = data[usable:]
        return self.complete

    def services(self):
        """録るに値するサービスだけ。リモコン番号は NIT のものを配る"""
        if not self.complete:
            return []
        found = []
        for service in self.transport['services']:
            if service['serviceType'] not in SERVICE_TYPES:
                continue
            found.append(
                {
                    **service,
                    'networkId': self.network['networkId'],
                    'transportStreamId': self.transport['transportStreamId'],
                    'remoteControlKeyId': self.network['remoteControlKeyId'],
                }
            )
        return found
