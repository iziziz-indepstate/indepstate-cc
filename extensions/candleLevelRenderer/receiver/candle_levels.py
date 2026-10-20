"""Read closed MT5 candles and exchange owned chart objects with an indicator.

This module has no order, position, login or trading API calls. Only prices
acknowledged by the indicator are advertised as ready for LevelTrack.
"""
import calendar
import csv
import datetime as dt
import hashlib
import io
import json
import math
import multiprocessing
import os
import pathlib
import re
import sqlite3
import time
from collections import OrderedDict
from functools import lru_cache

PERIODS = {'M1': 60, 'M2': 120, 'M3': 180, 'M4': 240, 'M5': 300, 'M6': 360,
           'M10': 600, 'M12': 720, 'M15': 900, 'M20': 1200, 'M30': 1800,
           'H1': 3600, 'H2': 7200, 'H3': 10800, 'H4': 14400, 'H6': 21600,
           'H8': 28800, 'H12': 43200, 'D1': 86400, 'W1': 604800, 'MN1': None}


def available_symbol(mt5, symbol, select=False):
    if (not isinstance(symbol, str) or not 1 <= len(symbol) <= 60 or symbol != symbol.strip()
            or re.search(r'[\x00-\x1f\x7f-\x9f"\\]', symbol)):
        raise ValueError('Invalid exact MT5 candle symbol')
    info = mt5.symbol_info(symbol)
    if not info or getattr(info, 'name', None) != symbol:
        raise ValueError('Exact MT5 candle symbol not found: ' + symbol)
    if select and not getattr(info, 'select', True) and not mt5.symbol_select(symbol, True):
        raise ValueError('MT5 candle symbol cannot be selected for reading')
    return info


def snapshot_protocol(drawing):
    return 2 if any('colorRgb' in row for row in drawing) else 1


def marker_color(row):
    rgb = row.get('colorRgb', 0xff6347 if row['side'] == 'high' else 0x00bfff)
    # Preserve the TV source color; white is displayed red on MT5 charts.
    if rgb == 0xffffff:
        return 0xff0000
    # Source reds use the same purple as the user's minute levels.
    # This changes presentation only: timeframe, side, time and price stay intact.
    if rgb in (0xf23645, 0xff0000):
        return 0x673ab7
    return rgb


@lru_cache(maxsize=4)
def history_zone(data):
    import base64
    import gzip
    from zoneinfo import ZoneInfo
    return ZoneInfo.from_file(io.BytesIO(gzip.decompress(base64.b64decode(data))), key='America/New_York')


def window_offset(config, start, end):
    if config.get('brokerClockModel', 'fixed-offset') != 'new-york-plus-hours':
        return config.get('brokerUtcOffsetSeconds', 0)
    # Apply the recipient-configured historical server calendar.
    # Reuse the receiver's pinned TZif data on Windows; never guess from color
    # or apply today's UTC offset to a winter candle.
    data = config.get('candleNewYorkTzif')
    if not data:
        raise ValueError('Verified historical broker timezone rules are unavailable')
    hours = config.get('brokerClockHours')
    if type(hours) is not int or not -23 <= hours <= 23:
        raise ValueError('Configure an explicit historical broker clock offset in hours')
    zone = history_zone(data)
    def at(stamp):
        return int(dt.datetime.fromtimestamp(stamp, zone).utcoffset().total_seconds()) + hours * 3600
    offset = at(start)
    if offset != at(end - 1):
        raise ValueError('TV window crosses a broker clock change; no price is guessed')
    return offset


def read_window(mt5, payload, offset):
    """One extreme inside [TV open, TV close), never the extra broker hour.

    Aligned candles use their native MT5 bar. For different session boundaries,
    minute history must reproduce every enclosing closed H1 bar's tick volume
    and extremes. Thus legitimate minutes without quotes are allowed, while
    partial history cannot silently produce a price.
    """
    start, end = payload['time'] + offset, payload['endTime'] + offset
    def read(tf, left, right):
        return mt5.copy_rates_range(payload['symbol'], getattr(mt5, 'TIMEFRAME_' + tf),
            dt.datetime.fromtimestamp(left, dt.timezone.utc), dt.datetime.fromtimestamp(right, dt.timezone.utc))
    def prices(rows):
        high, low = max(float(row['high']) for row in rows), min(float(row['low']) for row in rows)
        if any(not all(math.isfinite(value) and value > 0 for value in (float(row['high']), float(row['low'])))
               or float(row['high']) < float(row['low']) for row in rows):
            raise ValueError('Invalid MT5 candle prices')
        return high, low
    nominal = PERIODS[payload['timeframe']]
    if nominal is not None and end - start == nominal:
        native = read(payload['timeframe'], start, start)
        if native is not None and len(native) == 1 and int(native[0]['time']) == start:
            high, low = prices(native)
            return dict(high=high, low=low, brokerTime=start, method='mt5-candle')
    # All requested D1/H1/H4 windows have whole-hour boundaries. Short native
    # minute candles above never change their timeframe to fill a history gap.
    if start % 3600 or end % 3600:
        raise ValueError('No exact native MT5 candle; minute windows are not replaced by adjacent bars')
    hours = read('H1', start, end - 1)
    minutes = read('M1', start, end - 1)
    if hours is None or minutes is None or not len(hours) or not len(minutes):
        raise ValueError('MT5 history for the exact TV window is unavailable')
    if len(hours) > 32 * 24 or len(minutes) > 32 * 1440:
        raise ValueError('MT5 window history exceeds its bounded size')
    parents = {int(row['time']): row for row in hours}
    if (len(parents) != len(hours) or len(parents) != (end - start) // 3600
            or start not in parents or end - 3600 not in parents
            or any(stamp < start or stamp >= end or stamp % 3600 for stamp in parents)):
        raise ValueError('MT5 hourly coverage does not span the exact TV window')
    children = {stamp: [] for stamp in parents}
    previous = start - 60
    for row in minutes:
        stamp = int(row['time'])
        if stamp <= previous or stamp < start or stamp >= end or stamp % 60 or stamp // 3600 * 3600 not in children:
            raise ValueError('Invalid or incomplete MT5 minute window coverage')
        previous = stamp
        children[stamp // 3600 * 3600].append(row)
    for stamp, parent in parents.items():
        rows = children[stamp]
        if not rows:
            raise ValueError('MT5 minute history is incomplete')
        high, low = prices(rows)
        volume = int(parent['tick_volume'])
        if (volume <= 0 or any(int(row['tick_volume']) <= 0 for row in rows)
                or sum(int(row['tick_volume']) for row in rows) != volume
                or high != float(parent['high']) or low != float(parent['low'])):
            raise ValueError('MT5 minute history does not reproduce the hourly tick volume and extremes')
    high, low = prices(minutes)
    return dict(high=high, low=low, brokerTime=start, method='mt5-m1-window', minuteCount=len(minutes), coverageHours=len(hours))


def candle_window_worker(connection, config, payload):
    """Separate read-only MT5 client; never block receiver/trading locks."""
    import MetaTrader5 as mt5
    try:
        if not mt5.initialize(path=config['terminalPath'], timeout=3000):
            raise ValueError('Candle history terminal is unavailable')
        account, terminal = mt5.account_info(), mt5.terminal_info()
        if (not account or str(account.login) != str(config['account']) or account.server != config['server']
                or not terminal or not terminal.connected):
            raise ValueError('Candle history account verification failed')
        available_symbol(mt5, payload['symbol'], select=True)
        offset = window_offset(config, payload['time'], payload['endTime'])
        connection.send({'result': read_window(mt5, payload, offset)})
    except Exception as error:
        connection.send({'error': str(error)})
    finally:
        mt5.shutdown()
        connection.close()


class WindowHistory:
    """At most one read-only child, 20s deadline and 128 immutable results."""
    def __init__(self, config, context=None, clock=time.monotonic, zone_data=None):
        self.config = {key: config[key] for key in ('terminalPath', 'account', 'server', 'brokerUtcOffsetSeconds', 'brokerClockModel', 'brokerClockHours') if key in config}
        if zone_data:
            self.config['candleNewYorkTzif'] = zone_data
        self.context = context or multiprocessing.get_context('spawn')
        self.clock, self.job, self.cache, self.completed = clock, None, OrderedDict(), {}

    def _collect(self):
        if self.job is None:
            return
        job = self.job
        key, process, pipe = job['key'], job['process'], job['pipe']
        result = job['result']
        if result is None:
            try:
                if pipe.poll():
                    result = pipe.recv()
                elif self.clock() >= job['deadline'] or not process.is_alive():
                    result = {'error': 'MT5 candle history read timed out or stopped'}
            except (EOFError, OSError):
                result = {'error': 'MT5 candle history worker disconnected'}
            job['result'] = result
        if result is not None:
            if process.is_alive() and ('error' in result or self.clock() >= job['deadline']):
                process.terminate()
            process.join(timeout=0.05)
            if not process.is_alive():
                pipe.close()
                process.close()
                self.job = None
            if job['delivered']:
                return
            job['delivered'] = True
            if 'result' in result:
                self.cache[key] = (self.clock() + 300, result)
                while len(self.cache) > 128:
                    self.cache.popitem(last=False)
            else:
                self.completed[key] = result
                while len(self.completed) > 128:
                    self.completed.pop(next(iter(self.completed)))

    def get(self, payload):
        self._collect()
        key = (payload['symbol'], payload['timeframe'], payload['time'], payload['endTime'])
        cached = self.cache.get(key)
        if cached and self.clock() < cached[0]:
            self.cache.move_to_end(key)
            return cached[1]
        if key in self.completed:
            return self.completed.pop(key)
        if self.job is None:
            parent, child = self.context.Pipe(duplex=False)
            process = self.context.Process(target=candle_window_worker, args=(child, self.config, payload), daemon=True)
            try:
                process.start()
            except BaseException:
                parent.close(); child.close()
                raise
            child.close()
            self.job = dict(key=key, process=process, pipe=parent, deadline=self.clock()+20, result=None, delivered=False)
        return {'pending': True}

    def close(self):
        if self.job is not None:
            process, pipe = self.job['process'], self.job['pipe']
            if process.is_alive():
                process.terminate()
            process.join(timeout=0.05)
            pipe.close()
            if not process.is_alive():
                process.close()
            self.job = None


class CandleLevels:
    def __init__(self, mt5, config, database, clock=time.time, window_history=None, broker_zone_data=None):
        self.mt5, self.config, self.clock = mt5, config, clock
        self.offset = config.get('brokerUtcOffsetSeconds', 0)
        self.db = sqlite3.connect(database, check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS markers (id TEXT PRIMARY KEY, revision INTEGER, digest TEXT, payload TEXT, result TEXT)')
        self.db.commit()
        self.directory = None
        self.window_history = window_history or WindowHistory(config, zone_data=broker_zone_data)

    def validate(self, payload):
        if not isinstance(payload, dict):
            raise ValueError('Invalid candle marker')
        required = {'id', 'revision', 'action'}
        action = payload.get('action')
        if action == 'upsert':
            required |= {'symbol', 'timeframe', 'time', 'side', 'tool'}
        elif action != 'delete':
            raise ValueError('Unsupported candle marker action')
        allowed = required | ({'colorRgb', 'endTime'} if action == 'upsert' else set())
        if not required <= set(payload) <= allowed or not isinstance(payload.get('id'), str) or not re.fullmatch(r'[a-f0-9]{24}', payload['id']):
            raise ValueError('Invalid candle marker identity')
        revision = payload.get('revision')
        if type(revision) is not int or not 1 <= revision <= 9007199254740991:
            raise ValueError('Invalid candle marker revision')
        if action == 'upsert':
            symbol = payload['symbol']
            available_symbol(self.mt5, symbol)
            if payload['timeframe'] not in PERIODS or payload['side'] not in ('high', 'low') or payload['tool'] not in ('line', 'ray'):
                raise ValueError('Invalid candle timeframe, side or drawing')
            if type(payload['time']) is not int or not 1 <= payload['time'] <= 4102444800:
                raise ValueError('Invalid UTC candle time')
            if 'colorRgb' in payload and (type(payload['colorRgb']) is not int or not 0 <= payload['colorRgb'] <= 0xffffff):
                raise ValueError('Invalid candle color')
            if 'endTime' in payload:
                end, start = payload['endTime'], payload['time']
                maximum = PERIODS[payload['timeframe']]
                maximum = 32 * 86400 if maximum is None else maximum + (7200 if maximum >= 86400 else 0)
                if (type(end) is not int or not start < end <= 4102444800 or end - start > maximum
                        or start % 60 or end % 60):
                    raise ValueError('Invalid exact TV candle window')

    def files(self):
        if self.directory is None:
            info = self.mt5.terminal_info()
            if not info or not getattr(info, 'data_path', None):
                raise ValueError('MT5 terminal data directory is unavailable')
            self.directory = pathlib.Path(info.data_path) / 'MQL5' / 'Files'
            self.directory.mkdir(parents=True, exist_ok=True)
        return self.directory

    def resolve(self, payload, previous=None):
        available_symbol(self.mt5, payload['symbol'], select=True)
        timestamp, tf = payload['time'], payload['timeframe']
        if 'endTime' in payload:
            if self.clock() < payload['endTime']:
                return {'status': 'waiting-close', 'retryAt': payload['endTime'] * 1000 + 1000,
                        'reason': 'Selected TV candle window is still open'}
            history = self.window_history.get(payload)
            if history.get('pending'):
                return {'status': 'waiting-history', 'attempts': (previous or {}).get('attempts', 0),
                        'retryAt': int((self.clock() + 1) * 1000), 'reason': 'Reading the exact TV window in a separate read-only MT5 client'}
            if 'error' in history:
                return self.waiting_history(previous, history['error'])
            result = history['result']
            return {'status': 'drawing', 'price': result[payload['side']], **{key: value for key, value in result.items() if key not in ('high', 'low')}}
        end = timestamp + PERIODS[tf] if tf != 'MN1' else None
        if tf == 'MN1':
            current = dt.datetime.fromtimestamp(timestamp + self.offset, dt.timezone.utc)
            year, month = (current.year + 1, 1) if current.month == 12 else (current.year, current.month + 1)
            end = calendar.timegm(current.replace(year=year, month=month, day=1).timetuple()) - self.offset
        if self.clock() < end:
            return {'status': 'waiting-close', 'retryAt': end * 1000 + 1000,
                    'reason': 'Selected MT5 candle is still open'}
        expected = timestamp + self.offset
        constant = getattr(self.mt5, 'TIMEFRAME_' + tf, None)
        if constant is None:
            return {'status': 'error', 'reason': 'MT5 does not support this timeframe'}
        rates = self.mt5.copy_rates_range(payload['symbol'], constant,
            dt.datetime.fromtimestamp(expected, dt.timezone.utc),
            dt.datetime.fromtimestamp(expected, dt.timezone.utc))
        if rates is None or len(rates) != 1 or int(rates[0]['time']) != expected:
            reason = 'No MT5 candle at the exact selected time; nearest candles are not substituted'
            return self.waiting_history(previous, reason)
        high, low = float(rates[0]['high']), float(rates[0]['low'])
        if not all(math.isfinite(x) and x > 0 for x in (high, low)) or high < low:
            return {'status': 'error', 'reason': 'Invalid MT5 candle prices'}
        price = high if payload['side'] == 'high' else low
        return {'status': 'drawing', 'price': price, 'brokerTime': expected}

    def waiting_history(self, previous, reason):
        attempts = (previous or {}).get('attempts', 0) + 1
        if attempts >= 8:
            return {'status': 'error', 'attempts': attempts, 'reason': reason}
        return {'status': 'waiting-history', 'attempts': attempts,
                'retryAt': int((self.clock() + min(30, 2 ** attempts)) * 1000), 'reason': reason}

    def rows(self):
        return [(identifier, revision, json.loads(payload), json.loads(result))
                for identifier, revision, payload, result in self.db.execute('SELECT id,revision,payload,result FROM markers ORDER BY id')]

    def snapshot(self):
        records = []
        for identifier, revision, payload, result in self.rows():
            if payload['action'] != 'upsert':
                continue
            records.append({**payload, **result, 'id': identifier, 'revision': revision})
        drawing = [row for row in records if row['status'] == 'drawing']
        generation = hashlib.sha256(json.dumps(drawing, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        return generation, records, drawing

    def write_snapshot(self):
        generation, _records, drawing = self.snapshot()
        protocol = snapshot_protocol(drawing)
        buffer = io.StringIO(newline='')
        writer = csv.writer(buffer, delimiter='\t', lineterminator='\n')
        writer.writerow(['ISCC_CANDLE_LEVELS', protocol, generation, len(drawing)])
        for row in drawing:
            values = [row['id'], row['revision'], row['symbol'], row['timeframe'],
                      row['brokerTime'], repr(row['price']), row['tool'], row['side']]
            if protocol == 2:
                values.append(marker_color(row))
            writer.writerow(values)
        writer.writerow(['END', generation, len(drawing)])
        file = self.files() / 'iscc-addon-levels.csv'
        content = buffer.getvalue().encode('utf-8')
        if file.exists() and file.read_bytes() == content:
            return
        temporary = file.with_suffix('.tmp')
        temporary.write_bytes(content)
        os.replace(temporary, file)

    def acknowledgements(self, generation, drawing):
        try:
            file = self.files() / 'iscc-addon-levels-ack.csv'
            stat = file.stat()
            if not 0 <= self.clock() - stat.st_mtime <= 5 or stat.st_size > 1024 * 1024:
                return None
            data = list(csv.reader(io.StringIO(file.read_text(encoding='utf-8-sig')), delimiter='\t'))
            count = len(drawing)
            protocol = snapshot_protocol(drawing)
            if len(data) != count + 2 or data[0] != ['ISCC_CANDLE_LEVELS_ACK', str(protocol), generation, str(count)] or data[-1] != ['END', generation, str(count)]:
                return None
            expected = {row['id']: row for row in drawing}
            found, seen = {}, set()
            for row in data[1:-1]:
                if len(row) != (6 if protocol == 2 else 5) or row[0] not in expected or row[0] in seen:
                    return None
                seen.add(row[0])
                source = expected[row[0]]
                if int(row[1]) != source['revision'] or row[2] != source['symbol'] or row[3] != 'ready':
                    continue
                if protocol == 2 and int(row[5]) != marker_color(source):
                    continue
                price = float(row[4])
                if math.isfinite(price) and abs(price - source['price']) <= max(1e-8, abs(price) * 1e-12):
                    found[row[0]] = True
            return found
        except (OSError, ValueError, UnicodeError, OverflowError):
            return None

    def state(self):
        generation, records, drawing = self.snapshot()
        # Retry an interrupted/locked atomic file replacement on the next read.
        self.write_snapshot()
        acknowledged = self.acknowledgements(generation, drawing)
        snapshot_applied = acknowledged is not None and len(acknowledged) == len(drawing)
        acknowledged = acknowledged or {}
        for row in records:
            if row['id'] in acknowledged:
                row['status'] = 'ready'
            elif row['status'] == 'drawing':
                row['reason'] = 'Waiting for ISCC Candle Levels indicator in the primary MT5 terminal'
        return {'generation': generation, 'levels': records, 'snapshotApplied': snapshot_applied}

    def apply(self, payload):
        self.validate(payload)
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, allow_nan=False).encode()).hexdigest()
        previous = self.db.execute('SELECT revision,digest,result FROM markers WHERE id=?', (payload['id'],)).fetchone()
        prior_result = None
        if previous:
            if previous[0] > payload['revision']:
                return self.state()
            if previous[0] == payload['revision']:
                if previous[1] != digest:
                    raise ValueError('Candle marker revision already has different contents')
                prior_result = json.loads(previous[2])
                if prior_result['status'] not in ('waiting-close', 'waiting-history'):
                    return self.state()
                if self.clock() * 1000 < prior_result.get('retryAt', 0):
                    return self.state()
        elif self.db.execute('SELECT COUNT(*) FROM markers').fetchone()[0] >= 2000:
            raise ValueError('Candle marker limit reached')
        result = {'status': 'removed'} if payload['action'] == 'delete' else self.resolve(payload, prior_result)
        self.db.execute('INSERT OR REPLACE INTO markers VALUES (?,?,?,?,?)',
            (payload['id'], payload['revision'], digest, json.dumps(payload), json.dumps(result, allow_nan=False)))
        self.db.commit()
        return self.state()

    def close(self):
        self.window_history.close()
        self.db.close()
