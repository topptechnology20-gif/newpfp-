import http.server
import socketserver
import os
import json
from datetime import datetime, timezone
from urllib.parse import urlparse

PORT = 5000
GAME_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "game")
INDEX_PATH = os.path.join(GAME_DIR, "newpfp", "index.html")
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
        if path in {"/", ""}:
            try:
                with open(INDEX_PATH, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
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


class Server(socketserver.TCPServer):
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        pass


with Server(("0.0.0.0", PORT), Handler) as httpd:
    print(f"Serving at http://0.0.0.0:{PORT}", flush=True)
    httpd.serve_forever()
