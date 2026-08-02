#!/usr/bin/env python3
"""チューナー側のエージェント。mirakc を抱えて、denpa の代わりにチューナーを触る。

denpa からは触れないものが3つある。

* B-CASカード … pcscd 経由でしか読めず、その pcscd はこのコンテナにしか居ない
* チューナーデバイス … スキャンは mirakc を通さず recisdb で直接叩く
* mirakc の設定 … config.yml は起動時にしか読まれないので、書いたら再起動が要る

そのため mirakc の親としてこれが PID 1 になり、必要なときに mirakc を止めて
スキャンし、設定を書き戻してから起動し直す。
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

PORT = int(os.environ.get('AGENT_PORT', '40773'))
CONFIG = Path(os.environ.get('MIRAKC_CONFIG', '/etc/mirakc/config.yml'))
CONFIG_TEMPLATE = Path('/app-config-defaults/config.yml')
EPG_CACHE = Path(os.environ.get('MIRAKC_EPG_CACHE', '/var/lib/mirakc/epg'))
RECORDED_DIR = Path(os.environ.get('RECORDED_DIR', '/denpa-recorded')).resolve()
RECISDB = os.environ.get('RECISDB', 'recisdb')
SCANNER = os.environ.get('ISDB_SCANNER', 'isdb-scanner')
SCAN_OUTPUT = Path('/tmp/denpa-scan')

# ISDBScanner が選局する物理チャンネルの数。地上波は 13〜62ch を総当たりし、
# 衛星は同じネットワークの情報をまとめて取れるので1波につき1回で済む
GR_CHANNELS = 50
SATELLITE_CHANNELS = {'free': 1, 'all': 3}
# 進み具合はこの行を数えて出す。ISDBScanner は選局のたびにこれを出力する
CHANNEL_LINE = re.compile(r'Channel:\s')
LOG_LIMIT = 400


def log(message):
    print(f'[agent] {message}', flush=True)


def run(command, timeout=30):
    """子プロセスを最後まで回して、出力をまとめて受け取る"""
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        return done.returncode, (done.stdout + done.stderr).strip()
    except (OSError, subprocess.SubprocessError) as error:
        return -1, str(error)


class Mirakc:
    """mirakc の面倒を見る。落ちたら起こし、頼まれたら止める"""

    def __init__(self):
        self.proc = None
        # 設定を置き終わるまで起動させない。設定が無いと mirakc は即死する
        self.wanted = False
        self.lock = threading.Lock()

    def begin(self):
        self.wanted = True
        threading.Thread(target=self._supervise, daemon=True).start()

    def _supervise(self):
        while True:
            with self.lock:
                if self.wanted and self.proc is None:
                    self.proc = subprocess.Popen(['/usr/local/bin/mirakc'])
                    log(f'mirakc を起動しました (pid {self.proc.pid})')
                proc = self.proc
            if proc is not None:
                proc.wait()
                with self.lock:
                    if self.proc is proc:
                        self.proc = None
                        # 止めたのが自分なら黙って抜ける。落ちたのなら起こし直す
                        if self.wanted:
                            log('mirakc が落ちました。起こし直します')
                            time.sleep(1)
            else:
                time.sleep(0.5)

    def stop(self):
        with self.lock:
            self.wanted = False
            proc = self.proc
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
        log('mirakc を止めました')

    def start(self):
        with self.lock:
            self.wanted = True

    def alive(self):
        with self.lock:
            return self.proc is not None


mirakc = Mirakc()


def card_status():
    """カードリーダーが見えているか。

    pcscd が動いていてもリーダーを掴めていないことがある(USBが黙る)。
    そうなると recisdb は黙って復号せずに素通しし、録画は成功したように見えて
    中身が全部スクランブルされたまま、という分かりにくい壊れ方をする。
    """
    running = run(['pgrep', '-x', 'pcscd'], timeout=10)[0] == 0
    output = run(['pcsc_scan', '-r'], timeout=15)[1]
    # 「0: Reader name」の形で並ぶ
    readers = [
        line.strip().split(': ', 1)[1]
        for line in output.splitlines()
        if re.match(r'^\s*\d+:\s', line)
    ]
    if not running:
        message = 'pcscd が動いていません'
    elif readers:
        message = f'カードリーダーが見えています ({len(readers)} 台)'
    else:
        message = 'pcscd は動いていますが、カードリーダーが見つかりません'
    return {'ok': running and bool(readers), 'pcscd': running, 'readers': readers, 'message': message}


def inside_recorded(name):
    """生TSの置き場の中に収まるパスだけ受け付ける。外を読み書きさせない"""
    if not isinstance(name, str) or name == '':
        return None
    full = (RECORDED_DIR / name).resolve()
    return full if full.is_relative_to(RECORDED_DIR) and full != RECORDED_DIR else None


def decode(body):
    """掛かったまま録れたTSを解く。

    recisdb はカードが読めないとき「黙って素通しする」ので、終了コードだけでは
    成否が分からない。出来上がったものを見て判断するのは呼び出し側(denpa)。
    """
    source = inside_recorded(body.get('input'))
    target = inside_recorded(body.get('output'))
    if source is None or target is None:
        return {'ok': False, 'error': f'生TSの置き場 ({RECORDED_DIR}) の外は解除に回せません'}
    if not source.exists():
        return {
            'ok': False,
            'error': f'{source} が見えません。denpa と同じ生TSの置き場をこのコンテナにも見せてください',
        }

    code, output = run([RECISDB, 'decode', '-i', str(source), str(target)], timeout=None)
    if code != 0:
        return {'ok': False, 'error': f'recisdb が {code} で終了しました\n{output}'}
    return {'ok': True, 'error': ''}


scan = {
    'state': 'idle',
    'phase': '',
    'log': [],
    'scanned': 0,
    'total': 0,
    'channels': 0,
    'tuners': 0,
    'error': None,
    'startedAt': None,
    'finishedAt': None,
}
scan_lock = threading.Lock()


def scan_push(line, **fields):
    with scan_lock:
        if line:
            scan['log'] = (scan['log'] + [line])[-LOG_LIMIT:]
            if CHANNEL_LINE.search(line):
                scan['scanned'] += 1
        scan.update(fields)


def merge_config(scanned):
    """スキャン結果を今の設定に混ぜる。

    ISDBScanner が出すのは channels と tuners だけ。epg やサーバの設定は
    こちらのものを残さないと、スキャンのたびに設定が飛ぶ。
    """
    current = yaml.safe_load(CONFIG.read_text()) or {}
    found = yaml.safe_load(scanned.read_text()) or {}
    for key in ('channels', 'tuners'):
        if found.get(key):
            current[key] = found[key]
    # 書きかけを読ませない。mirakc は起動時にしか読まないので壊れると起動しなくなる
    working = CONFIG.with_suffix('.yml.writing')
    working.write_text(yaml.safe_dump(current, allow_unicode=True, sort_keys=False))
    working.replace(CONFIG)
    return len(current.get('channels') or []), len(current.get('tuners') or [])


def clear_epg_cache():
    """mirakc が覚えている局と時刻を捨てる。

    services.json などにスキャン前の局が残っていると、消えたはずの局が
    番組表に出続ける。次の起動で拾い直させる。
    """
    if not EPG_CACHE.is_dir():
        return
    for path in EPG_CACHE.iterdir():
        if path.is_file():
            path.unlink()


def run_scan(exclude_pay_tv):
    try:
        # ISDBScanner は mirakc を通さず直接チューナーを開く。動かしたままだと
        # EPG更新と取り合いになってスキャンが失敗するので、その間だけ止める
        scan_push('mirakc を止めています...', phase='mirakc を停止')
        mirakc.stop()

        shutil.rmtree(SCAN_OUTPUT, ignore_errors=True)
        command = [SCANNER, str(SCAN_OUTPUT)]
        if exclude_pay_tv:
            command.append('--exclude-pay-tv')

        scan_push('チャンネルを探しています...', phase='スキャン中')
        proc = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
        )
        for line in proc.stdout:
            scan_push(line.rstrip())
        code = proc.wait()
        if code != 0:
            raise RuntimeError(f'isdb-scanner が {code} で終了しました')

        scanned = SCAN_OUTPUT / 'mirakc' / 'config.yml'
        if not scanned.is_file():
            raise RuntimeError('スキャン結果が出力されませんでした')

        scan_push('設定を書き込んでいます...', phase='設定を反映')
        channels, tuners = merge_config(scanned)
        # isdb-scanner はチューナーが1台も無くても 0 で終わる。1件も見つからない
        # ときに成功扱いにすると「スキャンしたのに空」が普通に見えてしまう
        if channels == 0:
            raise RuntimeError('チャンネルが1件も見つかりませんでした。チューナーとアンテナを確認してください')
        clear_epg_cache()
        scan_push(f'チャンネル {channels} 件 / チューナー {tuners} 件', channels=channels, tuners=tuners)
    except Exception as error:  # noqa: BLE001 - 何で失敗しても画面に理由を出したい
        scan_push(f'失敗しました: {error}', state='failed', error=str(error), finishedAt=time.time())
    else:
        scan_push('mirakc を起動しています...', state='done', phase='完了', finishedAt=time.time())
    finally:
        mirakc.start()


def start_scan(body):
    with scan_lock:
        if scan['state'] == 'running':
            return {'started': False, 'message': '既に実行中です'}
        exclude_pay_tv = body.get('excludePayTv') is True
        scan.update(
            state='running',
            phase='準備中',
            log=[],
            scanned=0,
            total=GR_CHANNELS + SATELLITE_CHANNELS['free' if exclude_pay_tv else 'all'],
            channels=0,
            tuners=0,
            error=None,
            startedAt=time.time(),
            finishedAt=None,
        )
    threading.Thread(target=run_scan, args=(exclude_pay_tv,), daemon=True).start()
    return {'started': True, 'message': 'チャンネルスキャンを始めました'}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _send(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        # パスと種別しか来ないので、それ以上溜まるのは何かがおかしい
        if length > 64 * 1024:
            raise ValueError('body too large')
        return json.loads(self.rfile.read(length) or b'{}')

    def do_GET(self):
        if self.path == '/denpa/card':
            self._send(200, card_status())
        elif self.path == '/denpa/scan':
            with scan_lock:
                self._send(200, {**scan, 'mirakc': mirakc.alive()})
        else:
            self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        try:
            body = self._body()
        except ValueError as error:
            self._send(400, {'ok': False, 'error': str(error)})
            return

        if self.path == '/denpa/decode':
            result = decode(body)
            self._send(200 if result['ok'] else 500, result)
        elif self.path == '/denpa/scan':
            result = start_scan(body)
            self._send(200 if result['started'] else 409, result)
        else:
            self._send(404, {'ok': False, 'error': 'not found'})


def main():
    if not CONFIG.exists() and CONFIG_TEMPLATE.exists():
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(CONFIG_TEMPLATE, CONFIG)
        log(f'初期設定を置きました: {CONFIG}')
    EPG_CACHE.mkdir(parents=True, exist_ok=True)

    if run(['pgrep', '-x', 'pcscd'], timeout=10)[0] != 0:
        subprocess.Popen(['pcscd', '--foreground', '--disable-polkit'])
        log('pcscd を起動しました')

    def shutdown(*_):
        mirakc.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    mirakc.begin()
    log(f'listening on :{PORT} (recorded: {RECORDED_DIR})')
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
