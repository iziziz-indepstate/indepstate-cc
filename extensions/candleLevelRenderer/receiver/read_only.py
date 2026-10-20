"""Candle-only JSONL worker. No sockets, login, password or trading API."""
import argparse
import base64
import gzip
import json
import pathlib
import sys

from candle_levels import CandleLevels

CAPABILITIES = ['candle-levels', 'candle-levels-window', 'candle-levels-color']


class Reader:
    def __init__(self, mt5, config, database):
        self.mt5 = mt5
        path, expected = config.get('terminalPath'), config.get('expectedDataPath')
        offset = config.get('brokerUtcOffsetSeconds')
        model = config.get('brokerClockModel')
        if not isinstance(path, str) or not path or not isinstance(expected, str) or not expected:
            raise ValueError('Configure terminalPath and expectedDataPath locally')
        if type(offset) is not int or not -14 * 3600 <= offset <= 14 * 3600:
            raise ValueError('Configure a verified historical broker UTC offset')
        if model not in ('fixed-offset', 'new-york-plus-hours'):
            raise ValueError('Choose an explicit broker clock model')
        if not mt5.initialize(path=path, timeout=3000):
            raise ValueError('MT5 terminal is unavailable')
        terminal, account = mt5.terminal_info(), mt5.account_info()
        if not terminal or not terminal.connected or not account:
            raise ValueError('MT5 terminal must already be connected')
        if pathlib.Path(terminal.data_path).resolve() != pathlib.Path(expected).resolve():
            raise ValueError('Connected MT5 data directory differs from the selected terminal')
        self.identity = (str(account.login), account.server)
        self.data_path = pathlib.Path(expected).resolve()
        private = {**config, 'account': account.login, 'server': account.server}
        zone = None
        if model == 'new-york-plus-hours':
            hours = config.get('brokerClockHours')
            if type(hours) is not int or not -23 <= hours <= 23:
                raise ValueError('Configure brokerClockHours explicitly')
            from importlib.resources import files
            zone = base64.b64encode(gzip.compress(files('tzdata.zoneinfo.America').joinpath('New_York').read_bytes())).decode()
        self.book = CandleLevels(mt5, private, database, broker_zone_data=zone)

    def dispatch(self, request):
        if not isinstance(request, dict) or set(request) - {'id', 'route', 'payload'}:
            raise ValueError('Invalid read-only request')
        identifier = request.get('id')
        if type(identifier) is not int or not 1 <= identifier <= 9007199254740991:
            raise ValueError('Invalid request identity')
        terminal, account = self.mt5.terminal_info(), self.mt5.account_info()
        if (not terminal or not terminal.connected or not account
                or (str(account.login), account.server) != self.identity
                or pathlib.Path(terminal.data_path).resolve() != self.data_path):
            raise ValueError('Selected MT5 terminal session changed; restart the reader')
        route = request.get('route')
        if route == '/health' and 'payload' not in request:
            return {'capabilities': CAPABILITIES}
        if route != '/candle-levels':
            raise ValueError('Only candle-level requests are allowed')
        payload = request.get('payload')
        state = self.book.state() if payload is None else self.book.apply(payload)
        return {'candleLevels': state}

    def close(self):
        self.book.close()
        self.mt5.shutdown()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=pathlib.Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8'))
    import MetaTrader5 as mt5
    reader = None
    try:
        reader = Reader(mt5, config, args.config.parent / 'renderer-levels.sqlite3')
        while True:
            line = sys.stdin.buffer.readline(65537)
            if not line:
                break
            if len(line) > 65536 or not line.endswith(b'\n'):
                break
            identifier = None
            try:
                request = json.loads(line)
                if isinstance(request, dict):
                    identifier = request.get('id')
                result = {'id': identifier, 'result': reader.dispatch(request)}
            except (ValueError, TypeError, KeyError, OSError):
                result = {'id': identifier, 'error': 'Candle request rejected; check terminal, clock and exact candle data'}
            print(json.dumps(result, allow_nan=False), flush=True)
    finally:
        if reader:
            reader.close()
        else:
            mt5.shutdown()


if __name__ == '__main__':
    main()
