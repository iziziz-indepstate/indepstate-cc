import csv
import datetime as dt
import io
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock
ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / 'extensions/candleLevelRenderer/receiver'))
from candle_levels import CandleLevels, WindowHistory, read_window, candle_window_worker, window_offset

class Terminal:
    TIMEFRAME_M1 = 1
    def __init__(self, directory, stamp):
        self.directory, self.stamp, self.reads = directory, stamp, []
        self.high, self.low = 30380.25, 30342.5
    def terminal_info(self):
        return types.SimpleNamespace(data_path=self.directory)
    def symbol_info(self, symbol):
        return types.SimpleNamespace(name=symbol,digits=2,trade_tick_size=0.01) if symbol in ('USTEC', 'SPX500', 'XAUUSD') else None
    def copy_rates_range(self, symbol, timeframe, start, end):
        self.reads.append((symbol, timeframe, start.timestamp(), end.timestamp()))
        return [dict(time=self.stamp, high=self.high, low=self.low)]

class CandleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.stamp, self.offset = 1791981720, 10800
        self.now = self.stamp + 3600
        self.mt5 = Terminal(self.temporary.name, self.stamp + self.offset)
        self.book = CandleLevels(self.mt5, {'symbols': ['USTEC', 'SPX500'], 'brokerUtcOffsetSeconds': self.offset},
            pathlib.Path(self.temporary.name) / 'levels.sqlite3', clock=lambda: self.now)
        self.addCleanup(self.book.close)
        self.payload = dict(id='a'*24, revision=1, action='upsert', symbol='USTEC', timeframe='M1', time=self.stamp, side='high', tool='line')

    def ack(self, state, price=None, generation=None, complete=True, color=None, protocol=None):
        generation = generation or state['generation']; rows = [row for row in state['levels'] if row['status'] == 'drawing']
        protocol = protocol or (2 if any('colorRgb' in row for row in rows) else 1)
        file = pathlib.Path(self.temporary.name) / 'MQL5/Files/iscc-addon-levels-ack.csv'
        with file.open('w', newline='') as handle:
            writer = csv.writer(handle, delimiter='\t', lineterminator='\n')
            writer.writerow(['ISCC_CANDLE_LEVELS_ACK', protocol, generation, len(rows)])
            for row in rows:
                values = [row['id'], row['revision'], row['symbol'], 'ready', row['price'] if price is None else price]
                if protocol == 2:
                    values.append(row.get('colorRgb', 0xff6347 if row['side'] == 'high' else 0x00bfff) if color is None else color)
                writer.writerow(values)
            if complete: writer.writerow(['END', generation, len(rows)])
        os.utime(file, (self.now, self.now))
        return file

    def test_white_source_requires_red_display_readback_without_changing_source_or_price(self):
        for side in ('high', 'low'):
            with self.subTest(side=side):
                self.payload['revision'] += 1
                state = self.book.apply(dict(self.payload, side=side, colorRgb=0xffffff))
                row = state['levels'][0]
                price = self.mt5.high if side == 'high' else self.mt5.low
                self.assertEqual(row['colorRgb'], 0xffffff)
                self.assertEqual(row['price'], price)
                rows = list(csv.reader(io.StringIO((self.book.files()/'iscc-addon-levels.csv').read_text()), delimiter='\t'))
                self.assertEqual(int(rows[1][8]), 0xff0000)
                self.ack(state, color=0xffffff)
                self.assertEqual(self.book.state()['levels'][0]['status'], 'drawing')
                self.ack(state, color=0xff0000)
                ready = self.book.state()['levels'][0]
                self.assertEqual((ready['status'], ready['colorRgb'], ready['price']), ('ready', 0xffffff, price))

    def test_exact_mt5_high_and_broker_clock_are_used(self):
        state = self.book.apply(self.payload); row = state['levels'][0]
        self.assertEqual(row['price'], self.mt5.high); self.assertEqual(row['status'], 'drawing')
        self.assertEqual(self.mt5.reads[0][2:], (self.stamp+self.offset, self.stamp+self.offset))
        self.ack(state)
        self.assertEqual(self.book.state()['levels'][0]['status'], 'ready')

    def test_arbitrary_tv_price_is_rejected_before_history_or_drawing(self):
        with self.assertRaises(ValueError):
            self.book.apply(dict(self.payload,mode='tv-price',side='price',price=30355.37))
        self.assertEqual(self.mt5.reads,[])
        self.assertEqual(self.book.state()['levels'],[])

    def test_red_source_is_purple_without_changing_candle_period_price_or_color_in_state(self):
        for source_color in (0xf23645,0xff0000,0x673ab7):
            for side in ('high','low'):
                self.payload['revision'] += 1
                state=self.book.apply(dict(self.payload,side=side,colorRgb=source_color))
                row=state['levels'][0]
                expected_price=self.mt5.high if side=='high' else self.mt5.low
                self.assertEqual((row['timeframe'],row['time'],row['side'],row['colorRgb'],row['price']),
                                 ('M1',self.stamp,side,source_color,expected_price))
                rows=list(csv.reader(io.StringIO((self.book.files()/'iscc-addon-levels.csv').read_text()),delimiter='\t'))
                self.assertEqual(int(rows[1][8]),0x673ab7)
                self.ack(state,color=0xf23645)
                self.assertEqual(self.book.state()['levels'][0]['status'],'drawing')
                self.ack(state,color=0x673ab7)
                self.assertEqual(self.book.state()['levels'][0]['status'],'ready')

    def test_low_is_a_single_level_and_line_and_ray_preserve_semantics(self):
        state = self.book.apply(dict(self.payload, side='low', tool='ray'))
        self.assertEqual(len(state['levels']), 1); self.assertEqual(state['levels'][0]['price'], self.mt5.low)
        self.assertEqual(state['levels'][0]['tool'], 'ray')

    def test_unmatched_candle_is_not_replaced_by_nearest(self):
        self.mt5.stamp -= 60
        row = self.book.apply(self.payload)['levels'][0]
        self.assertEqual(row['status'], 'waiting-history'); self.assertNotIn('price', row)
        for _ in range(7):
            self.now += 31
            row = self.book.apply(self.payload)['levels'][0]
        self.assertEqual(row['status'], 'error'); self.assertNotIn('price', row)

    def test_history_load_retries_are_bounded_and_can_recover_exact_bar(self):
        expected = self.mt5.stamp
        self.mt5.stamp -= 60
        first = self.book.apply(self.payload)
        self.book.apply(self.payload)
        self.assertEqual(len(self.mt5.reads), 1)
        self.assertNotIn('price', first['levels'][0])
        self.now += 3; self.mt5.stamp = expected
        row = self.book.apply(self.payload)['levels'][0]
        self.assertEqual(row['status'], 'drawing'); self.assertEqual(row['price'], self.mt5.high)

    def test_forming_candle_waits_without_history_read(self):
        self.now = self.stamp + 10
        row = self.book.apply(self.payload)['levels'][0]
        self.assertEqual(row['status'], 'waiting-close'); self.assertEqual(self.mt5.reads, [])
        self.now += 120
        self.assertEqual(self.book.apply(self.payload)['levels'][0]['status'], 'drawing')

    def test_partial_stale_wrong_generation_and_wrong_price_ack_are_rejected(self):
        state = self.book.apply(self.payload)
        for kwargs in [dict(complete=False), dict(generation='b'*64), dict(price=1)]:
            self.ack(state, **kwargs)
            self.assertEqual(self.book.state()['levels'][0]['status'], 'drawing')
        file = self.ack(state); self.now += 10
        self.assertEqual(self.book.state()['levels'][0]['status'], 'drawing')

    def test_revision_prevents_late_upsert_from_resurrecting_deleted_level(self):
        self.book.apply(self.payload)
        state = self.book.apply(dict(id='a'*24, revision=2, action='delete'))
        self.assertEqual(state['levels'], [])
        self.assertEqual(self.book.apply(self.payload)['levels'], [])
        with self.assertRaises(ValueError): self.book.apply(dict(self.payload, revision=2))

    def test_idempotent_resolved_request_does_not_requery_mt5(self):
        self.book.apply(self.payload); self.book.apply(self.payload)
        self.assertEqual(len(self.mt5.reads), 1)

    def test_invalid_symbols_nan_and_path_traversal_are_rejected(self):
        for patch in [dict(symbol='../other'), dict(id='../other'), dict(time=True), dict(revision=True), dict(timeframe='tick'), dict(side='both')]:
            with self.assertRaises(ValueError): self.book.apply(dict(self.payload, **patch))
        self.mt5.high = float('nan')
        self.assertEqual(self.book.apply(self.payload)['levels'][0]['status'], 'error')

    def test_source_color_reaches_file_and_requires_matching_indicator_color(self):
        state = self.book.apply(dict(self.payload, colorRgb=0x2962ff))
        self.assertEqual(state['levels'][0]['colorRgb'], 0x2962ff)
        file = self.book.files() / 'iscc-addon-levels.csv'
        rows = list(csv.reader(io.StringIO(file.read_text()), delimiter='\t'))
        self.assertEqual(rows[0][1], '2'); self.assertEqual(len(rows[1]), 9)
        self.assertEqual(rows[1][8], str(0x2962ff))
        self.ack(state, color=0xffffff)
        self.assertEqual(self.book.state()['levels'][0]['status'], 'drawing')
        self.assertFalse(self.book.state()['snapshotApplied'])
        self.ack(state)
        self.assertEqual(self.book.state()['levels'][0]['status'], 'ready')
        self.assertTrue(self.book.state()['snapshotApplied'])

    def test_old_indicator_cannot_acknowledge_a_colored_snapshot(self):
        state = self.book.apply(dict(self.payload, colorRgb=0x673ab7))
        self.ack(state, protocol=1)
        self.assertEqual(self.book.state()['levels'][0]['status'], 'drawing')
        self.ack(state)
        self.assertEqual(self.book.state()['levels'][0]['status'], 'ready')

    def test_color_only_edit_replaces_same_marker_and_rejects_old_generation(self):
        first = self.book.apply(dict(self.payload, colorRgb=0x2962ff))
        self.ack(first)
        second = self.book.apply(dict(self.payload, colorRgb=0xffffff, revision=2))
        self.assertNotEqual(first['generation'], second['generation'])
        self.assertEqual(second['levels'][0]['status'], 'drawing')
        self.assertEqual(len(self.book.rows()), 1)
        self.assertEqual(second['levels'][0]['price'], self.mt5.high)
        self.ack(second, color=0xff0000)
        self.assertEqual(self.book.state()['levels'][0]['status'], 'ready')

    def test_mixed_legacy_and_colored_markers_share_a_complete_version_two_snapshot(self):
        self.book.apply(self.payload)
        state = self.book.apply(dict(self.payload, id='b'*24, colorRgb=0x673ab7, side='low'))
        rows = list(csv.reader(io.StringIO((self.book.files()/'iscc-addon-levels.csv').read_text()), delimiter='\t'))
        self.assertEqual(rows[0][1], '2'); self.assertEqual(len(rows), 4)
        self.assertEqual([int(row[8]) for row in rows[1:-1]], [0xff6347, 0x673ab7])
        self.ack(state)
        self.assertTrue(all(row['status'] == 'ready' for row in self.book.state()['levels']))

    def test_invalid_color_never_reaches_the_terminal(self):
        for color in [-1, 0x1000000, True, 1.0, 'white', None]:
            with self.assertRaisesRegex(ValueError, 'color'):
                self.book.apply(dict(self.payload, colorRgb=color))
        self.assertEqual(self.mt5.reads, [])

    def test_exact_daily_hourly_and_five_minute_periods_are_not_downgraded(self):
        anchors = [('D1', dt.datetime(2026, 10, 13, 21, tzinfo=dt.timezone.utc)),
                   ('H1', dt.datetime(2026, 10, 14, 13, tzinfo=dt.timezone.utc)),
                   ('M5', dt.datetime(2026, 10, 14, 13, 35, tzinfo=dt.timezone.utc))]
        self.now = dt.datetime(2026, 10, 17, tzinfo=dt.timezone.utc).timestamp()
        for index, (tf, anchor) in enumerate(anchors):
            with self.subTest(timeframe=tf):
                value = index + 100
                setattr(self.mt5, 'TIMEFRAME_'+tf, value)
                timestamp = int(anchor.timestamp()); self.mt5.stamp = timestamp + self.offset
                row = self.book.apply(dict(self.payload, revision=index+1, timeframe=tf, time=timestamp, colorRgb=0xffffff))['levels'][0]
                self.assertEqual(row['status'], 'drawing'); self.assertEqual(row['timeframe'], tf)
                self.assertEqual(self.mt5.reads[-1][1:], (value, timestamp+self.offset, timestamp+self.offset))

    def test_an_adjacent_hour_or_shifted_daily_boundary_is_never_silently_used(self):
        self.now = self.stamp + 3*86400
        for index, tf in enumerate(['H1', 'D1']):
            setattr(self.mt5, 'TIMEFRAME_'+tf, index+10)
            self.mt5.stamp = self.stamp + self.offset - 3600
            row = self.book.apply(dict(self.payload, revision=index+1, timeframe=tf))['levels'][0]
            self.assertEqual(row['status'], 'waiting-history'); self.assertNotIn('price', row)

    def test_color_and_exact_anchor_survive_backend_restart(self):
        state = self.book.apply(dict(self.payload, colorRgb=0xf23645))
        self.book.close()
        self.book = CandleLevels(self.mt5, {'symbols':['USTEC','SPX500'], 'brokerUtcOffsetSeconds':self.offset},
            pathlib.Path(self.temporary.name)/'levels.sqlite3', clock=lambda:self.now)
        self.addCleanup(self.book.close)
        restored = self.book.state()['levels'][0]
        self.assertEqual(restored['time'], self.stamp); self.assertEqual(restored['colorRgb'], 0xf23645)
        self.assertEqual(restored['price'], state['levels'][0]['price'])

    def test_deletion_needs_fresh_ack_of_the_new_empty_snapshot(self):
        first = self.book.apply(dict(self.payload, colorRgb=0x2962ff))
        self.ack(first)
        self.assertTrue(self.book.state()['snapshotApplied'])
        removed = self.book.apply(dict(id=self.payload['id'], revision=2, action='delete'))
        self.assertEqual(removed['levels'], []); self.assertFalse(removed['snapshotApplied'])
        self.ack(removed, complete=False)
        self.assertFalse(self.book.state()['snapshotApplied'])
        self.ack(removed)
        self.assertTrue(self.book.state()['snapshotApplied'])
        self.now += 6
        self.assertFalse(self.book.state()['snapshotApplied'])
