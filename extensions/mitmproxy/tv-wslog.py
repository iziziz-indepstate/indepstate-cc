# tv-wslog.py — лог WS-кадров (текст); бинарь — в base64
import json, base64, re
from mitmproxy import http

# ==== настройки фильтрации (по желанию) ====
HOST_ALLOW = None                 # например: r"tradingview\.com$"  (None = все хосты)

# что ловим в WS:
WS_RX = r'alert_fired'            # например: r'"event"\s*:\s*"alert"'
# что ловим в HTTP запросах (см. HTTP_METHODS ниже):
HTTP_RX = r'LineToolHorz(?:Line|Ray)'
HTTP_METHODS = {"PUT"}            # можно добавить методы при необходимости

rx_host = re.compile(HOST_ALLOW, re.I) if HOST_ALLOW else None
rx_ws_text = re.compile(WS_RX, re.I) if WS_RX else None
rx_http_text = re.compile(HTTP_RX, re.I) if HTTP_RX else None

MAX_LOG_TEXT = 2000               # чтобы не раздувать лог
SOURCE_TOOL_TYPES = {
    "LineToolHorzLine": ("line_creations", "line_removals"),
    "LineToolHorzRay": ("ray_creations", "ray_removals"),
}
source_tool_types = {}


def _host_ok(flow: http.HTTPFlow) -> bool:
    h = flow.request.pretty_host
    return True if not rx_host else bool(rx_host.search(h))


def _ws_text_ok(text: str) -> bool:
    return True if not rx_ws_text else bool(rx_ws_text.search(text))


def _http_text_ok(text: str) -> bool:
    return True if not rx_http_text else bool(rx_http_text.search(text))


def _decode_bytes(b: bytes):
    """Пробуем декодировать как UTF-8; иначе вернём None и base64."""
    if b is None:
        return None, None
    try:
        return b.decode("utf-8"), None
    except Exception:
        return None, base64.b64encode(b).decode("ascii")


def _extract_source_updates(flow: http.HTTPFlow, text: str):
    """Вернёт словарь с id созданных/удалённых line/ray tools, если удалось распарсить тело."""
    if not text:
        return None

    path = flow.request.path or ""
    if not path.startswith("/charts-storage/user/sources"):
        return None

    try:
        data = json.loads(text)
    except Exception:
        return None

    sources = data.get("sources")
    if not isinstance(sources, dict):
        return None

    updates = {
        "line_creations": [],
        "line_removals": [],
        "ray_creations": [],
        "ray_removals": [],
        "unknown_removals": [],
    }

    for raw_id, src in sources.items():
        if raw_id is None:
            continue
        line_id = str(raw_id).strip()
        if not line_id:
            continue

        if src is None:
            tool_type = source_tool_types.pop(line_id, None)
            if tool_type in SOURCE_TOOL_TYPES:
                updates[SOURCE_TOOL_TYPES[tool_type][1]].append(line_id)
            else:
                updates["unknown_removals"].append(line_id)
            continue

        if not isinstance(src, dict):
            continue

        state = src.get("state")
        tool_type = state.get("type") if isinstance(state, dict) else None
        if tool_type in SOURCE_TOOL_TYPES:
            source_tool_types[line_id] = tool_type
            updates[SOURCE_TOOL_TYPES[tool_type][0]].append(line_id)

    if not any(updates.values()):
        return None

    return updates


# ================== WebSocket хуки ==================

def websocket_start(flow: http.HTTPFlow):
    if not _host_ok(flow):
        return
    print(json.dumps({
        "event": "start",
        "host": flow.request.pretty_host,
        "path": flow.request.path
    }, ensure_ascii=False), flush=True)


def websocket_message(flow: http.HTTPFlow):
    # ВАЖНО: сообщения лежат в flow.websocket.messages
    if flow.websocket is None:
        return
    if not _host_ok(flow):
        return
    try:
        msg = flow.websocket.messages[-1]   # mitmproxy.ws.WebSocketMessage
    except Exception:
        return

    data = msg.content  # bytes
    direction = "out" if msg.from_client else "in"

    text, b64 = _decode_bytes(data)

    # Фильтрация по тексту, если задана
    if text is not None:
        if not _ws_text_ok(text):
            return
        out = {
            "event": "message",
            "dir": direction,
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "text": text[:MAX_LOG_TEXT]
        }
    else:
        # бинарные кадры — складываем как base64
        out = {
            "event": "message",
            "dir": direction,
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "bin": b64
        }

    print(json.dumps(out, ensure_ascii=False), flush=True)


def websocket_end(flow: http.HTTPFlow):
    if not _host_ok(flow):
        return
    print(json.dumps({
        "event": "end",
        "host": flow.request.pretty_host,
        "path": flow.request.path
    }, ensure_ascii=False), flush=True)


# ================== HTTP хуки ==================

def request(flow: http.HTTPFlow):
    """
    Ловим клиентские HTTP-запросы (до отправки на сервер).
    Нас интересуют методы из HTTP_METHODS и тела, где встречается HTTP_RX.
    """
    if not _host_ok(flow):
        return
    method = (flow.request.method or "").upper()
    if method not in HTTP_METHODS:
        return

    # тело запроса
    body_bytes = flow.request.raw_content or flow.request.content
    text, b64 = _decode_bytes(body_bytes)

    source_updates = None

    # Фильтрация: ищем строку в тексте (если текст декодировался)
    if text is not None:
        source_updates = _extract_source_updates(flow, text)
        if not source_updates and not _http_text_ok(text):
            return
        out = {
            "event": "http_request",
            "dir": "out",  # от клиента к серверу
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "method": method,
            "text": text[:MAX_LOG_TEXT]
        }
        if source_updates:
            for key in ("line_creations", "line_removals", "ray_creations", "ray_removals", "unknown_removals"):
                if source_updates.get(key):
                    out[key] = source_updates[key]
            if source_updates.get("line_removals"):
                out["line_removal"] = True
            if source_updates.get("ray_removals"):
                out["ray_removal"] = True
    else:
        # если текст не декодировался — всё равно логируем, но без фильтра по содержимому
        # (если нужно жёстко фильтровать, можно вместо этого return)
        # Попробуем хотя бы поискать по URL на всякий случай
        url_ok = _http_text_ok(flow.request.pretty_url) if rx_http_text else True
        if not url_ok:
            return
        out = {
            "event": "http_request",
            "dir": "out",
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "method": method,
            "bin": b64
        }

    # Можно добавить полезные метаданные
    ct = flow.request.headers.get("Content-Type")
    if ct:
        out["content_type"] = ct

    print(json.dumps(out, ensure_ascii=False), flush=True)
