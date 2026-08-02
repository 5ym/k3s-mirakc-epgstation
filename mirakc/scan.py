"""チャンネルスキャン。物理チャンネルを片端から選局して、居る局を探す。

Mirakurun の走査に合わせてある。

* 地上波は 13〜62ch を総当たり、BS は 01〜23 の各 4 スロット、CS は 02〜24ch
* 1チャンネルにつき最大 20 秒待ち、NIT と SDT が**両方**揃ったら受信できたとみなす
* 録るに値するサービス種別だけ残す (tsinfo.SERVICE_TYPES)

チューナーは mirakc の設定に書いてあるものをそのまま使う。台数ぶん並べて回すので、
2台あれば半分の時間で終わる。スキャンの間 mirakc は止まっているので取り合いにならない。
"""

import queue
import re
import select
import subprocess
import threading
import time

import tsinfo

# 1チャンネルあたりの待ち時間。Mirakurun と同じ。
# 電波が無ければ recisdb がすぐ落ちるので、実際にここまで待つのは受信できた局だけ
TUNE_TIMEOUT = 20.0
READ_CHUNK = 64 * 1024

CHANNEL_RANGES = {
    'GR': {'min': 13, 'max': 62},
    'BS': {'min': 1, 'max': 23},
    'CS': {'min': 2, 'max': 24},
}
# BS は1つの物理チャンネルに最大4本の TS が相乗りしている
BS_SLOTS = 4


def channels_for(channel_type, minimum=None, maximum=None):
    """選局する物理チャンネルの一覧。recisdb が受け付ける書き方で返す"""
    bounds = CHANNEL_RANGES[channel_type]
    low = bounds['min'] if minimum is None else max(minimum, bounds['min'])
    high = bounds['max'] if maximum is None else min(maximum, bounds['max'])

    if channel_type == 'GR':
        return [f'T{ch}' for ch in range(low, high + 1)]
    if channel_type == 'BS':
        return [f'BS{ch:02}_{slot}' for ch in range(low, high + 1) for slot in range(BS_SLOTS)]
    return [f'CS{ch:02}' for ch in range(low, high + 1)]


def render(command, channel, channel_type):
    """mirakc のチューナーコマンド (Mustache) にチャンネルを埋める"""
    values = {'channel': channel, 'channel_type': channel_type, 'duration': '-', 'extra_args': ''}
    def replace(match):
        return values.get(match.group(1).strip(), '')
    return re.sub(r'\{\{\{?\s*([a-z_]+)\s*\}?\}\}', replace, command)


def read_services(command, timeout=TUNE_TIMEOUT):
    """1チャンネル選局して、NIT と SDT が揃うまで読む。

    揃った時点で打ち切る。最後まで読む必要はないし、居ない局で 20 秒待つのは
    総当たりだと効いてくる。
    """
    try:
        proc = subprocess.Popen(
            command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
    except OSError as error:
        return None, str(error)

    reader = tsinfo.ServiceReader()
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([proc.stdout], [], [], 0.5)
            if not ready:
                # 電波が無いと recisdb は何も出さずに落ちる
                if proc.poll() is not None:
                    break
                continue
            chunk = proc.stdout.read1(READ_CHUNK)
            if not chunk:
                break
            if reader.feed(chunk):
                return reader.services(), None
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        proc.stdout.close()

    if reader.network is None:
        return None, '受信できませんでした'
    return None, 'サービス情報が揃いませんでした'


def channel_entry(channel_type, channel, services):
    """mirakc の channels に入れる1件。

    物理チャンネルごとに1件にして、サービスの絞り込みはしない (`services` を
    空にすると mirakc が見つけたものを全部出す)。サービスごとに分けても
    選局先は同じで、設定が長くなるだけ。
    """
    return {'name': channel, 'type': channel_type, 'channel': channel, 'services': []} | (
        {'services': sorted(s['serviceId'] for s in services)} if services else {}
    )


class Scanner:
    """チューナーの台数ぶん並べて総当たりする"""

    def __init__(self, tuners, on_progress=None):
        self.tuners = [t for t in tuners if not t.get('disabled')]
        self.on_progress = on_progress or (lambda **_: None)
        self.lock = threading.Lock()
        self.found = {}

    def _usable(self, channel_type):
        return [t for t in self.tuners if channel_type in (t.get('types') or [])]

    def run(self, targets):
        """targets は (種別, チャンネル) の並び。見つかった channels 定義を返す"""
        for channel_type, channels in targets:
            tuners = self._usable(channel_type)
            if not tuners:
                self.on_progress(
                    line=f'{channel_type}: 対応するチューナーがありません', skipped=len(channels)
                )
                continue

            pending = queue.Queue()
            for channel in channels:
                pending.put(channel)

            workers = [
                threading.Thread(target=self._work, args=(tuner, channel_type, pending), daemon=True)
                for tuner in tuners
            ]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()

        order = {'GR': 0, 'BS': 1, 'CS': 2}
        return [
            self.found[key]
            for key in sorted(self.found, key=lambda k: (order.get(k[0], 9), k[1]))
        ]

    def _work(self, tuner, channel_type, pending):
        while True:
            try:
                channel = pending.get_nowait()
            except queue.Empty:
                return

            command = render(tuner['command'], channel, channel_type)
            services, error = read_services(command)
            if error is not None:
                self.on_progress(line=f'{channel}: {error}', scanned=1)
                continue
            if not services:
                self.on_progress(line=f'{channel}: 録れるサービスがありません', scanned=1)
                continue

            with self.lock:
                self.found[(channel_type, channel)] = channel_entry(channel_type, channel, services)
            self.on_progress(
                line=f'{channel}: {len(services)} サービス', scanned=1, channels=1
            )
