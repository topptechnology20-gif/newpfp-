import http.server
import socketserver
import os
import json
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

# Import trending engine (starts background refresh thread)
try:
    import trending_engine as _te
    _HAS_TRENDING = True
except Exception as _te_err:
    print(f"[serve.py] trending_engine import failed: {_te_err}", flush=True)
    _HAS_TRENDING = False

try:
    import psycopg2
    _HAS_DB = True
except ImportError:
    _HAS_DB = False

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def query_db(sql, params=(), fetchone=False):
    if not _HAS_DB or not DATABASE_URL:
        return None
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        cur.execute(sql, params)
        result = cur.fetchone() if fetchone else cur.fetchall()
        conn.close()
        return result
    except Exception as e:
        print(f"DB error: {e}", flush=True)
        return None

PORT = 5000
GAME_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "game")
INDEX_PATH = os.path.join(GAME_DIR, "newpfp", "index.html")
PRIVY_APP_ID = os.environ.get("PRIVY_APP_ID", "")
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app_state.json")

DEFAULT_PROFILE = {
    "id": "demo-user",
    "username": "bantahbro",
    "firstName": "Bantah",
    "lastName": "Bro",
    "bio": "Building the next arena layer for onchain battles.",
    "profileImageUrl": "",
    "walletAddress": "0x4C24768D98F2D30d3AB827d463d7a8A05c66bD0c",
    "primaryWalletAddress": "0x4C24768D98F2D30d3AB827d463d7a8A05c66bD0c",
    "points": 12680,
    "balance": "1234.50",
    "coins": 2400,
    "level": 12,
    "xp": 8400,
    "streak": 5,
    "status": "Ready",
    "myAgents": 3,
    "queue": 2,
    "bantCredit": 12840,
    "bantcClaim": 1240000,
    "earnedUsdc": 1250,
}

DEFAULT_NOTIFICATIONS = [
    {
        "id": "notif-1",
        "type": "challenge",
        "title": "New challenge ready",
        "message": "ROBOT V1 is live against FLOATROBO. Jump in before the queue closes.",
        "icon": "⚔️",
        "read": False,
        "createdAt": "2026-07-05T10:00:00Z",
    },
    {
        "id": "notif-2",
        "type": "reward",
        "title": "Watch 2 Earn payout",
        "message": "You earned 576 BC from your latest watch streak.",
        "icon": "💰",
        "read": False,
        "createdAt": "2026-07-05T09:15:00Z",
    },
    {
        "id": "notif-3",
        "type": "market",
        "title": "Marketplace update",
        "message": "Golden Skin is back in stock for your next loadout.",
        "icon": "🛒",
        "read": True,
        "createdAt": "2026-07-05T08:00:00Z",
    },
]


def load_state():
    if not os.path.exists(STATE_PATH):
        return {"profile": dict(DEFAULT_PROFILE), "notifications": [dict(n) for n in DEFAULT_NOTIFICATIONS]}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return {
            "profile": {**DEFAULT_PROFILE, **(data.get("profile") or {})},
            "notifications": data.get("notifications") or [dict(n) for n in DEFAULT_NOTIFICATIONS],
        }
    except Exception:
        return {"profile": dict(DEFAULT_PROFILE), "notifications": [dict(n) for n in DEFAULT_NOTIFICATIONS]}


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)


STATE = load_state()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=GAME_DIR, **kwargs)

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/profile":
            self.send_json(STATE["profile"])
            return
        if path == "/api/notifications":
            self.send_json(STATE["notifications"])
            return
        if path == "/api/notifications/unread-count":
            unread_count = sum(1 for notification in STATE["notifications"] if not notification.get("read", False))
            self.send_json({"unreadCount": unread_count})
            return
        if path == "/api/health":
            self.send_json({"ok": True})
            return

        if path == "/api/stats":
            qs = parse_qs(urlparse(self.path).query)
            wallet = (qs.get("wallet") or [""])[0].strip().lower()
            stats = {"myAgents": 0, "queue": 0, "bantCredit": 0,
                     "bantcClaim": 0, "earnedUsdc": 0, "status": "Ready"}
            if wallet:
                r = query_db("SELECT COUNT(*) FROM agents WHERE LOWER(owner_wallet_address)=%s", (wallet,), fetchone=True)
                if r: stats["myAgents"] = int(r[0])

                r = query_db("SELECT COUNT(*) FROM matchmaking_queue WHERE LOWER(wallet_address)=%s", (wallet,), fetchone=True)
                if r: stats["queue"] = int(r[0])

                r = query_db("SELECT COALESCE(balance,0) FROM bantcredit_balances WHERE LOWER(wallet_address)=%s", (wallet,), fetchone=True)
                if r: stats["bantCredit"] = float(r[0])

                r = query_db(
                    "SELECT COALESCE(SUM(amount),0) FROM onchain_sim_battle_reward_claims "
                    "WHERE LOWER(account)=%s AND status NOT IN ('claimed','expired','cancelled')",
                    (wallet,), fetchone=True)
                if r: stats["bantcClaim"] = int(r[0])

                r = query_db(
                    "SELECT COALESCE(SUM(pe.amount),0) FROM payout_entries pe "
                    "JOIN users u ON pe.user_id=u.id "
                    "WHERE LOWER(u.primary_wallet_address)=%s AND pe.status='completed'",
                    (wallet,), fetchone=True)
                if r: stats["earnedUsdc"] = round(float(r[0]) / 1_000_000, 2)

                r = query_db("SELECT status FROM users WHERE LOWER(primary_wallet_address)=%s", (wallet,), fetchone=True)
                if r and r[0]: stats["status"] = r[0]
            self.send_json(stats)
            return

        if path == "/api/my-agents":
            qs = parse_qs(urlparse(self.path).query)
            wallet = (qs.get("wallet") or [""])[0].strip().lower()
            agents = []
            if wallet:
                rows = query_db(
                    "SELECT agent_id, agent_name, avatar_url, win_count, loss_count, points, status "
                    "FROM agents WHERE LOWER(owner_wallet_address)=%s ORDER BY created_at DESC",
                    (wallet,))
                if rows:
                    agents = [{"id": r[0], "name": r[1], "avatarUrl": r[2],
                               "wins": r[3] or 0, "losses": r[4] or 0,
                               "points": r[5] or 0, "status": r[6]} for r in rows]
            self.send_json(agents)
            return

        if path == "/api/fighters":
            rows = query_db(
                "SELECT agent_id, display_name, avatar_url, wins, losses, fame_score "
                "FROM bota_fighter_profiles "
                "WHERE wins > 0 OR losses > 0 "
                "ORDER BY (wins + losses) DESC NULLS LAST, fame_score DESC NULLS LAST "
                "LIMIT 30")
            fighters = []
            if rows:
                fighters = [{"id": r[0], "name": r[1], "avatarUrl": r[2],
                             "wins": r[3] or 0, "losses": r[4] or 0,
                             "fameScore": float(r[5] or 0)} for r in rows]
            self.send_json(fighters)
            return
        # ── PumpFighters Engine endpoints ──────────────────────────────────
        if path == "/api/pumpfighters/state":
            if _HAS_TRENDING:
                s = _te.get_state()
                # Sanitise: make datetime objects JSON-safe
                def _clean(obj):
                    if isinstance(obj, dict):
                        return {k: _clean(v) for k, v in obj.items()}
                    if isinstance(obj, list):
                        return [_clean(i) for i in obj]
                    if hasattr(obj, "isoformat"):
                        return obj.isoformat()
                    return obj
                self.send_json(_clean(s))
            else:
                self.send_json({"fighters": [], "live_match": None,
                                "recent_battles": [], "last_refreshed": None,
                                "error": "engine not available"})
            return

        if path == "/api/pumpfighters/leaderboard":
            qs = parse_qs(urlparse(self.path).query)
            chain = (qs.get("chain") or ["all"])[0]
            limit = int((qs.get("limit") or ["30"])[0])
            if _HAS_TRENDING:
                rows = _te.get_leaderboard(chain=chain, limit=limit)
                def _clean_row(r):
                    out = {}
                    for k, v in r.items():
                        if hasattr(v, "isoformat"):
                            out[k] = v.isoformat()
                        elif isinstance(v, (list, set)):
                            out[k] = list(v)
                        else:
                            out[k] = v
                    return out
                self.send_json([_clean_row(r) for r in rows])
            else:
                self.send_json([])
            return

        if path == "/api/pumpfighters/recent-battles":
            limit = int((parse_qs(urlparse(self.path).query).get("limit") or ["20"])[0])
            if _HAS_TRENDING:
                rows = _te.get_recent_battles(limit=limit)
                def _clean_battle(r):
                    out = {}
                    for k, v in r.items():
                        out[k] = v.isoformat() if hasattr(v, "isoformat") else v
                    return out
                self.send_json([_clean_battle(r) for r in rows])
            else:
                self.send_json([])
            return

        if path == "/api/pumpfighters/trigger-refresh":
            if _HAS_TRENDING:
                threading.Thread(target=_te._refresh_cycle, daemon=True).start()
                self.send_json({"ok": True, "message": "Refresh triggered"})
            else:
                self.send_json({"ok": False, "message": "engine not available"})
            return

        if path in {"/", ""}:
            try:
                with open(INDEX_PATH, "r", encoding="utf-8") as f:
                    content = f.read()
                content = content.replace("'__PRIVY_APP_ID__'", f"'{PRIVY_APP_ID}'")
                body = content.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        try:
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_PUT(self):
        path = urlparse(self.path).path
        if path == "/api/profile":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(body or "{}")
            profile = STATE["profile"]
            if "firstName" in payload:
                profile["firstName"] = payload["firstName"]
            if "lastName" in payload:
                profile["lastName"] = payload["lastName"]
            if "username" in payload:
                profile["username"] = payload["username"]
            if "bio" in payload:
                profile["bio"] = payload["bio"]
            if "profileImageUrl" in payload:
                profile["profileImageUrl"] = payload["profileImageUrl"]
            if "walletAddress" in payload:
                profile["walletAddress"] = payload["walletAddress"]
                profile["primaryWalletAddress"] = payload["walletAddress"]
            save_state(STATE)
            self.send_json(profile)
            return
        if path == "/api/users/me/wallet":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(body or "{}")
            profile = STATE["profile"]
            wallet = payload.get("walletAddress") or payload.get("address")
            if wallet:
                profile["walletAddress"] = wallet
                profile["primaryWalletAddress"] = wallet
                save_state(STATE)
            self.send_json({"success": True, "walletAddress": profile["walletAddress"]})
            return
        self.send_json({"error": "Not found"}, 404)

    def do_PATCH(self):
        path = urlparse(self.path).path
        if path == "/api/notifications/read-all":
            for notification in STATE["notifications"]:
                notification["read"] = True
            save_state(STATE)
            self.send_json({"success": True})
            return
        parts = path.split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "notifications" and parts[3] == "read":
            self.send_json({"error": "Invalid route"}, 404)
            return
        if len(parts) == 5 and parts[1] == "api" and parts[2] == "notifications" and parts[4] == "read":
            notification_id = parts[3]
            for notification in STATE["notifications"]:
                if notification.get("id") == notification_id:
                    notification["read"] = True
                    break
            save_state(STATE)
            self.send_json({"success": True})
            return
        self.send_json({"error": "Not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        parts = path.split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "notifications":
            notification_id = parts[3]
            STATE["notifications"] = [n for n in STATE["notifications"] if n.get("id") != notification_id]
            save_state(STATE)
            self.send_json({"success": True})
            return
        if path == "/api/notifications/clear-all":
            STATE["notifications"] = []
            save_state(STATE)
            self.send_json({"success": True})
            return
        self.send_json({"error": "Not found"}, 404)

    def log_message(self, format, *args):
        pass

    def log_error(self, format, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


# ── Boot trending engine ───────────────────────────────────────────────────
if _HAS_TRENDING:
    def _boot_engine():
        time.sleep(2)
        try:
            _te.ensure_tables()
            _te.start_background_refresh()
        except Exception as e:
            print(f"[serve.py] Engine boot error: {e}", flush=True)
    threading.Thread(target=_boot_engine, daemon=True, name="EngineBootstrap").start()

with Server(("0.0.0.0", PORT), Handler) as httpd:
    print(f"Serving at http://0.0.0.0:{PORT}", flush=True)
    httpd.serve_forever()
