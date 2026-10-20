import ast
import pathlib
import sys
import tempfile
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / 'extensions/candleLevelRenderer/receiver'))
from read_only import Reader


class Terminal:
    TIMEFRAME_M1 = 1

    def __init__(self, directory):
        self.terminal = types.SimpleNamespace(connected=True, data_path=directory)
        self.account = types.SimpleNamespace(login=1, server='synthetic-broker')
        self.initialized = []

    def initialize(self, **options):
        self.initialized.append(options)
        return True

    def terminal_info(self):
        return self.terminal

    def account_info(self):
        return self.account

    def symbol_info(self, symbol):
        return types.SimpleNamespace(name=symbol, select=True) if symbol == 'SYNTHETIC' else None

    def copy_rates_range(self, symbol, timeframe, start, end):
        return [dict(time=int(start.timestamp()), high=105, low=95)]

    def shutdown(self):
        pass


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.mt5 = Terminal(self.temp.name)
        self.config = dict(terminalPath='terminal.exe', expectedDataPath=self.temp.name,
            brokerUtcOffsetSeconds=0, brokerClockModel='fixed-offset')

    def reader(self):
        reader = Reader(self.mt5, self.config, pathlib.Path(self.temp.name) / 'test.sqlite3')
        self.addCleanup(reader.close)
        return reader

    def test_session_is_selected_without_login_password_or_network(self):
        reader = self.reader()
        self.assertEqual(self.mt5.initialized, [dict(path='terminal.exe', timeout=3000)])
        health = reader.dispatch(dict(id=1, route='/health'))
        self.assertIn('candle-levels-window', health['capabilities'])
        self.assertNotIn('account', health)
        self.assertNotIn('server', health)

    def test_unverified_clock_is_rejected(self):
        self.config['brokerUtcOffsetSeconds'] = None
        with self.assertRaises(ValueError):
            self.reader()
        self.assertEqual(self.mt5.initialized, [])

    def test_wrong_terminal_directory_is_rejected(self):
        self.config['expectedDataPath'] = str(pathlib.Path(self.temp.name) / 'different')
        with self.assertRaisesRegex(ValueError, 'directory differs'):
            self.reader()

    def test_changed_terminal_session_blocks_candle_requests(self):
        reader = self.reader()
        self.mt5.account.login = 2
        with self.assertRaisesRegex(ValueError, 'session changed'):
            reader.dispatch(dict(id=1, route='/candle-levels'))

    def test_trading_and_unknown_routes_are_rejected(self):
        reader = self.reader()
        for route in ['/place', '/close', '/orders', '/account', '/unknown']:
            with self.assertRaisesRegex(ValueError, 'Only candle'):
                reader.dispatch(dict(id=1, route=route))

    def test_invalid_protocol_identity_is_rejected(self):
        reader = self.reader()
        for request in [None, {}, dict(id=True, route='/health'), dict(id=1, route='/health', extra=1)]:
            with self.assertRaises(ValueError):
                reader.dispatch(request)

    def test_candle_write_uses_separate_addon_namespace_and_waits_for_indicator(self):
        reader = self.reader()
        response = reader.dispatch(dict(id=1, route='/candle-levels', payload=dict(
            id='a' * 24, revision=1, action='upsert', symbol='SYNTHETIC',
            timeframe='M1', time=1700000040, side='high', tool='line')))
        self.assertEqual(response['candleLevels']['levels'][0]['status'], 'drawing')
        folder = pathlib.Path(self.temp.name) / 'MQL5/Files'
        self.assertTrue((folder / 'iscc-addon-levels.csv').is_file())
        self.assertFalse((folder / 'iscc-candle-levels.csv').exists())

    def test_receiver_sources_have_only_reading_mt5_calls(self):
        allowed = {'initialize', 'shutdown', 'terminal_info', 'account_info', 'symbol_info', 'symbol_select', 'copy_rates_range'}
        for name in ['read_only.py', 'candle_levels.py']:
            tree = ast.parse((ROOT / 'extensions/candleLevelRenderer/receiver' / name).read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    owner = node.func.value
                    direct = isinstance(owner, ast.Name) and owner.id == 'mt5'
                    instance = isinstance(owner, ast.Attribute) and owner.attr == 'mt5'
                    if direct or instance:
                        self.assertIn(node.func.attr, allowed)


if __name__ == '__main__':
    unittest.main()
