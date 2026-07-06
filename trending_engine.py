"""
Trending Coin Arena Engine — PumpFighters layer
================================================
Part 1: Chain Fetchers   (DexScreener: SOL, BSC, Base)
Part 2: Fighter Generator (ECPS combat profile formula)
Part 3: Image Pipeline    (Pillow circular crop → base64)
Part 4: Arena Seeder      (upsert profiles, retire stale)
Part 5: Matching Engine   (KING_CLASH → chain rivalry → ECPS balance)
Part 6: Battle Engine     (round-based HP simulation)
Part 7: Leaderboard       (win/loss/streak, per-chain + global rank)
Part 8: Orchestrator      (5-min refresh cycle, in-memory state)
"""

import base64
import io
import json
import math
import os
import random
import threading
import time
from datetime import datetime, timezone

import requests
from PIL import Image, ImageDraw

try:
    import psycopg2
    _HAS_DB = True
except ImportError:
    _HAS_DB = False

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

DEXSCREENER = "https://api.dexscreener.com"
REFRESH_INTERVAL = 5 * 60          # seconds between full refresh cycles
AVATAR_SIZE = 200                   # px for circular avatar
MAX_RECENT_BATTLES = 30

CHAIN_CONFIG = {
    "solana": {"label": "SOL",  "color": "#9945FF", "emoji": "🟣", "slots": 6},
    "bsc":    {"label": "BSC",  "color": "#F3BA2F", "emoji": "🟡", "slots": 5},
    "base":   {"label": "BASE", "color": "#0052FF", "emoji": "🔵", "slots": 5},
}

# Chain personality modifiers applied on top of base stats
CHAIN_MODS = {
    "solana": {"speed": 15,  "luck": 10},
    "bsc":    {"defense": 10, "aggression": 8},
    "base":   {"intelligence": 12},
}

# ─────────────────────────────────────────────────────────────────────────────
# IN-MEMORY STATE  (what the API reads — no DB hit per request)
# ─────────────────────────────────────────────────────────────────────────────

_state = {
    "fighters": [],          # list of active fighter dicts
    "live_match": None,      # {fighter_a, fighter_b, match_type, label}
    "recent_battles": [],    # last MAX_RECENT_BATTLES results
    "last_refreshed": None,  # ISO timestamp
    "next_refresh_in": REFRESH_INTERVAL,
    "is_refreshing": False,
    "error": None,
}
_lock = threading.Lock()
_refresh_start_time = None


def get_state():
    """Return a snapshot of the current engine state (safe to JSON-serialise)."""
    with _lock:
        s = dict(_state)
        if _refresh_start_time:
            elapsed = time.time() - _refresh_start_time
            s["next_refresh_in"] = max(0, int(REFRESH_INTERVAL - elapsed))
        return s


# ─────────────────────────────────────────────────────────────────────────────
# PART 1 — DB HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _conn():
    if not _HAS_DB or not DATABASE_URL:
        return None
    try:
        return psycopg2.connect(DATABASE_URL)
    except Exception as e:
        print(f"[TrendingEngine] DB connect: {e}", flush=True)
        return None


def _exec(sql, params=()):
    c = _conn()
    if not c:
        return
    try:
        cur = c.cursor()
        cur.execute(sql, params)
        c.commit()
    except Exception as e:
        print(f"[TrendingEngine] DB exec: {e}", flush=True)
    finally:
        try:
            c.close()
        except Exception:
            pass


def _query(sql, params=()):
    c = _conn()
    if not c:
        return []
    try:
        cur = c.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]
    except Exception as e:
        print(f"[TrendingEngine] DB query: {e}", flush=True)
        return []
    finally:
        try:
            c.close()
        except Exception:
            pass


def ensure_tables():
    """Create tables if they don't exist. Called once on server start."""
    _exec("""
        CREATE TABLE IF NOT EXISTS trending_fighter_profiles (
            unique_id        TEXT PRIMARY KEY,
            chain            TEXT NOT NULL,
            display_name     TEXT NOT NULL,
            full_name        TEXT,
            image_uri        TEXT,
            processed_avatar TEXT,
            arena_status     TEXT DEFAULT 'active',
            admin_tier       TEXT DEFAULT 'B_STANDARD',
            is_king          BOOLEAN DEFAULT FALSE,
            market_cap_usd   NUMERIC DEFAULT 0,
            volume_24h_usd   NUMERIC DEFAULT 0,
            aggression       INT DEFAULT 50,
            defense          INT DEFAULT 50,
            intelligence     INT DEFAULT 50,
            speed            INT DEFAULT 50,
            luck             INT DEFAULT 50,
            hp               INT DEFAULT 100,
            last_refreshed   TIMESTAMP DEFAULT NOW()
        )
    """)
    _exec("""
        CREATE TABLE IF NOT EXISTS trending_fighter_stats (
            fighter_unique_id TEXT PRIMARY KEY
                REFERENCES trending_fighter_profiles(unique_id),
            chain            TEXT NOT NULL,
            wins             INT DEFAULT 0,
            losses           INT DEFAULT 0,
            win_streak       INT DEFAULT 0,
            total_bc_earned  INT DEFAULT 0,
            global_rank      INT DEFAULT 999,
            chain_rank       INT DEFAULT 999,
            badges           TEXT[] DEFAULT '{}',
            last_fought_at   TIMESTAMP
        )
    """)
    _exec("""
        CREATE TABLE IF NOT EXISTS trending_battle_results (
            id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
            match_id         TEXT NOT NULL,
            match_type       TEXT NOT NULL,
            winner_id        TEXT,
            loser_id         TEXT,
            winner_chain     TEXT,
            loser_chain      TEXT,
            winner_name      TEXT,
            loser_name       TEXT,
            winner_hp_remaining INT,
            rounds_fought    INT,
            bc_pool          INT DEFAULT 576,
            created_at       TIMESTAMP DEFAULT NOW()
        )
    """)
    print("[TrendingEngine] DB tables ready.", flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# PART 2 — CHAIN FETCHERS
# ─────────────────────────────────────────────────────────────────────────────

_http = requests.Session()
_http.headers.update({"User-Agent": "BantahBro/1.0"})


def _safe_get(url, timeout=10):
    try:
        r = _http.get(url, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[TrendingEngine] fetch {url}: {e}", flush=True)
        return None


def _enrich_token(address, chain):
    """
    Call DexScreener pairs endpoint for a token address.
    Returns the best pair dict (highest liquidity) or None.
    """
    data = _safe_get(f"{DEXSCREENER}/latest/dex/tokens/{address}")
    if not data:
        return None
    pairs = data.get("pairs") or []
    # filter to matching chain, sort by liquidity desc
    chain_pairs = [p for p in pairs if p.get("chainId") == chain]
    if not chain_pairs:
        chain_pairs = pairs
    if not chain_pairs:
        return None
    chain_pairs.sort(key=lambda p: p.get("liquidity", {}).get("usd", 0) or 0, reverse=True)
    return chain_pairs[0]


def _normalize_token(address, chain, display_name, full_name, image_uri, pair):
    """Build the unified coin dict from raw + enriched pair data."""
    age_ms = 0
    if pair and pair.get("pairCreatedAt"):
        age_ms = max(0, time.time() * 1000 - pair["pairCreatedAt"])
    age_seconds = age_ms / 1000

    mcap = 0
    vol24 = 0
    if pair:
        mcap = float(pair.get("marketCap") or pair.get("fdv") or 0)
        vol24 = float((pair.get("volume") or {}).get("h24") or 0)
        # Better image: use info.imageUrl if available
        if pair.get("info", {}).get("imageUrl"):
            image_uri = pair["info"]["imageUrl"]

    return {
        "unique_id":      f"{chain}_{address}",
        "chain":          chain,
        "mint_address":   address,
        "display_name":   display_name[:20] if display_name else "UNKNOWN",
        "full_name":      full_name or display_name or "Unknown",
        "image_uri":      image_uri,
        "market_cap_usd": mcap,
        "volume_24h_usd": vol24,
        "age_seconds":    age_seconds,
        "is_king":        False,
    }


def _is_valid(coin):
    return (
        coin.get("image_uri")
        and coin.get("market_cap_usd", 0) > 5_000      # $5K min mcap
        and coin.get("market_cap_usd", 0) < 500_000_000 # not mega cap
        and len(coin.get("display_name", "")) < 30
        and "http" not in coin.get("display_name", "")
    )


def fetch_solana_trending(slots=6):
    """Top boosted Solana tokens from DexScreener → unified CoinProfile list."""
    raw = _safe_get(f"{DEXSCREENER}/token-boosts/top/v1") or []
    sol_entries = [x for x in raw if x.get("chainId") == "solana"][:slots * 2]

    coins = []
    for entry in sol_entries:
        addr = entry.get("tokenAddress", "")
        if not addr:
            continue
        pair = _enrich_token(addr, "solana")
        symbol = ""
        name = entry.get("description", "")
        if pair:
            symbol = pair.get("baseToken", {}).get("symbol", "")
            name = pair.get("baseToken", {}).get("name", name)

        image_uri = entry.get("icon", "")
        # icon from token-boosts may be a short key — use openGraph or CDN pattern
        if image_uri and not image_uri.startswith("http"):
            og = f"https://cdn.dexscreener.com/token-images/og/solana/{addr}"
            image_uri = og

        coin = _normalize_token(addr, "solana", symbol or name[:12], name, image_uri, pair)
        if _is_valid(coin):
            coins.append(coin)
        if len(coins) >= slots:
            break

    print(f"[TrendingEngine] Solana: {len(coins)} valid coins", flush=True)
    return coins


def fetch_bsc_trending(slots=5):
    """Top BSC tokens from DexScreener token-profiles → unified CoinProfile list."""
    raw = _safe_get(f"{DEXSCREENER}/token-profiles/latest/v1") or []
    bsc_entries = [x for x in raw if x.get("chainId") == "bsc"][:slots * 3]

    coins = []
    for entry in bsc_entries:
        addr = entry.get("tokenAddress", "")
        if not addr:
            continue
        pair = _enrich_token(addr, "bsc")
        symbol = ""
        name = entry.get("description", "")
        if pair:
            symbol = pair.get("baseToken", {}).get("symbol", "")
            name = pair.get("baseToken", {}).get("name", name)

        image_uri = entry.get("icon", "")

        coin = _normalize_token(addr, "bsc", symbol or name[:12], name, image_uri, pair)
        if _is_valid(coin):
            coins.append(coin)
        if len(coins) >= slots:
            break

    print(f"[TrendingEngine] BSC: {len(coins)} valid coins", flush=True)
    return coins


def fetch_base_trending(slots=5):
    """
    Top Base tokens: try token-profiles (often empty), fall back to
    DexScreener trending search for 'base' chain.
    """
    raw = _safe_get(f"{DEXSCREENER}/token-profiles/latest/v1") or []
    base_entries = [x for x in raw if x.get("chainId") == "base"][:slots * 3]

    # Fallback: search boosted for base
    if len(base_entries) < 2:
        boosted = _safe_get(f"{DEXSCREENER}/token-boosts/top/v1") or []
        base_entries = [x for x in boosted if x.get("chainId") == "base"][:slots * 3]

    coins = []
    for entry in base_entries:
        addr = entry.get("tokenAddress", "")
        if not addr:
            continue
        pair = _enrich_token(addr, "base")
        symbol = ""
        name = entry.get("description", "")
        if pair:
            symbol = pair.get("baseToken", {}).get("symbol", "")
            name = pair.get("baseToken", {}).get("name", name)

        image_uri = entry.get("icon", "")
        if image_uri and not image_uri.startswith("http"):
            image_uri = f"https://cdn.dexscreener.com/token-images/og/base/{addr}"

        coin = _normalize_token(addr, "base", symbol or name[:12], name, image_uri, pair)
        if _is_valid(coin):
            coins.append(coin)
        if len(coins) >= slots:
            break

    print(f"[TrendingEngine] Base: {len(coins)} valid coins", flush=True)
    return coins


# ─────────────────────────────────────────────────────────────────────────────
# PART 3 — FIGHTER GENERATOR  (ECPS combat profile)
# ─────────────────────────────────────────────────────────────────────────────

def _norm(val, lo, hi):
    """Normalise value to 0-100."""
    if hi == lo:
        return 0
    return min(100, max(0, ((val - lo) / (hi - lo)) * 100))


def generate_fighter_profile(coin):
    """Convert a unified CoinProfile → FighterProfile with combat stats."""
    age_hours = coin["age_seconds"] / 3600

    traits = {
        "aggression":   _norm(coin["market_cap_usd"],  0, 5_000_000) * 100,
        "defense":      _norm(age_hours,               0, 168) * 100,   # 1 week = max defense
        "intelligence": _norm(age_hours,               0, 72)  * 100,   # 3 days = max intel
        "speed":        _norm(coin["volume_24h_usd"],  0, 2_000_000) * 100,
        "luck":         88.0 if coin["is_king"] else _norm(random.random(), 0, 1) * 50 + 20,
    }
    hp = 80 + _norm(coin["market_cap_usd"], 0, 5_000_000) * 120

    # Apply chain personality modifiers
    mods = CHAIN_MODS.get(coin["chain"], {})
    for stat, bonus in mods.items():
        traits[stat] = min(100, traits[stat] + bonus)

    return {
        "unique_id":      coin["unique_id"],
        "chain":          coin["chain"],
        "display_name":   coin["display_name"].upper(),
        "full_name":      coin["full_name"],
        "image_uri":      coin["image_uri"],
        "processed_avatar": None,           # filled by image pipeline
        "market_cap_usd": coin["market_cap_usd"],
        "volume_24h_usd": coin["volume_24h_usd"],
        "is_king":        coin["is_king"],
        "arena_status":   "active",
        "admin_tier":     "D_LEGENDARY" if coin["is_king"] else "B_STANDARD",
        "aggression":     int(round(traits["aggression"])),
        "defense":        int(round(traits["defense"])),
        "intelligence":   int(round(traits["intelligence"])),
        "speed":          int(round(traits["speed"])),
        "luck":           int(round(traits["luck"])),
        "hp":             int(round(hp)),
        "wins":           0,
        "losses":         0,
        "win_streak":     0,
        "global_rank":    999,
        "chain_rank":     999,
        "last_refreshed": datetime.now(timezone.utc).isoformat(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# PART 4 — IMAGE PIPELINE  (Pillow circular crop)
# ─────────────────────────────────────────────────────────────────────────────

def process_coin_logo(image_uri):
    """
    Fetch a token image URL, crop to circle at AVATAR_SIZE×AVATAR_SIZE,
    return base64 PNG data-URI.  Returns None on failure (CSS fallback used).
    """
    if not image_uri:
        return None
    try:
        r = _http.get(image_uri, timeout=8, stream=True)
        r.raise_for_status()
        raw = r.content

        img = Image.open(io.BytesIO(raw)).convert("RGBA")
        img = img.resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)

        # Circular mask
        mask = Image.new("L", (AVATAR_SIZE, AVATAR_SIZE), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse((0, 0, AVATAR_SIZE, AVATAR_SIZE), fill=255)

        result = Image.new("RGBA", (AVATAR_SIZE, AVATAR_SIZE), (0, 0, 0, 0))
        result.paste(img, mask=mask)

        # Slight brightness boost to prevent dark squares
        from PIL import ImageEnhance
        result = ImageEnhance.Brightness(result.convert("RGB")).enhance(1.05)

        buf = io.BytesIO()
        result.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        return f"data:image/png;base64,{b64}"
    except Exception as e:
        print(f"[TrendingEngine] Image pipeline failed for {image_uri[:60]}: {e}", flush=True)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# PART 5 — ARENA SEEDER  (DB upsert)
# ─────────────────────────────────────────────────────────────────────────────

def upsert_fighter_profile(profile):
    """Insert or update a fighter profile. Also ensures stats row exists."""
    _exec("""
        INSERT INTO trending_fighter_profiles
            (unique_id, chain, display_name, full_name, image_uri,
             processed_avatar, arena_status, admin_tier, is_king,
             market_cap_usd, volume_24h_usd,
             aggression, defense, intelligence, speed, luck, hp,
             last_refreshed)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
        ON CONFLICT (unique_id) DO UPDATE SET
            display_name     = EXCLUDED.display_name,
            full_name        = EXCLUDED.full_name,
            image_uri        = EXCLUDED.image_uri,
            processed_avatar = COALESCE(EXCLUDED.processed_avatar,
                                        trending_fighter_profiles.processed_avatar),
            arena_status     = 'active',
            is_king          = EXCLUDED.is_king,
            market_cap_usd   = EXCLUDED.market_cap_usd,
            volume_24h_usd   = EXCLUDED.volume_24h_usd,
            aggression       = EXCLUDED.aggression,
            defense          = EXCLUDED.defense,
            intelligence     = EXCLUDED.intelligence,
            speed            = EXCLUDED.speed,
            luck             = EXCLUDED.luck,
            hp               = EXCLUDED.hp,
            last_refreshed   = NOW()
    """, (
        profile["unique_id"], profile["chain"], profile["display_name"],
        profile["full_name"], profile["image_uri"], profile.get("processed_avatar"),
        "active", profile["admin_tier"], profile["is_king"],
        profile["market_cap_usd"], profile["volume_24h_usd"],
        profile["aggression"], profile["defense"], profile["intelligence"],
        profile["speed"], profile["luck"], profile["hp"],
    ))

    # Ensure stats row
    _exec("""
        INSERT INTO trending_fighter_stats (fighter_unique_id, chain)
        VALUES (%s, %s)
        ON CONFLICT (fighter_unique_id) DO NOTHING
    """, (profile["unique_id"], profile["chain"]))


def retire_stale_fighters(keep_ids):
    """Mark any active fighter not in keep_ids as retired."""
    if not keep_ids:
        return
    placeholders = ",".join(["%s"] * len(keep_ids))
    _exec(f"""
        UPDATE trending_fighter_profiles
        SET arena_status = 'retired'
        WHERE arena_status = 'active'
        AND unique_id NOT IN ({placeholders})
    """, tuple(keep_ids))


def load_active_fighters_from_db():
    """Load all active fighters with their stats from DB."""
    return _query("""
        SELECT f.*, s.wins, s.losses, s.win_streak,
               s.total_bc_earned, s.global_rank, s.chain_rank, s.badges
        FROM trending_fighter_profiles f
        LEFT JOIN trending_fighter_stats s ON s.fighter_unique_id = f.unique_id
        WHERE f.arena_status = 'active'
        ORDER BY COALESCE(s.global_rank, 999) ASC
    """)


# ─────────────────────────────────────────────────────────────────────────────
# PART 6 — MATCHING ENGINE  (ECPS score + chain rivalry priority)
# ─────────────────────────────────────────────────────────────────────────────

def calculate_ecps(fighter):
    """Effective Combat Power Score."""
    return (
        fighter.get("aggression",   50) * 0.30 +
        fighter.get("defense",      50) * 0.20 +
        fighter.get("speed",        50) * 0.20 +
        fighter.get("intelligence", 50) * 0.20 +
        fighter.get("luck",         50) * 0.10
    )


def _create_match(a, b, match_type):
    labels = {
        "KING_CLASH":  f"👑 King Clash — {a['display_name']} vs {b['display_name']}",
        "SOL_VS_BSC":  f"⚔️ Chain Rivalry — SOL vs BSC",
        "BSC_VS_BASE": f"⚔️ Chain Rivalry — BSC vs BASE",
        "SOL_VS_BASE": f"⚔️ Chain Rivalry — SOL vs BASE",
        "BALANCED":    f"🥊 {a['display_name']} vs {b['display_name']}",
    }
    return {
        "id":         f"match_{int(time.time())}_{random.randint(1000,9999)}",
        "fighter_a":  a,
        "fighter_b":  b,
        "match_type": match_type,
        "label":      labels.get(match_type, f"{a['display_name']} vs {b['display_name']}"),
    }


def build_match_queue(fighters):
    """
    Build a prioritised match queue:
    1. King Clashes (any two is_king fighters)
    2. Cross-chain rivalry (SOL vs BSC, BSC vs BASE, SOL vs BASE)
    3. ECPS-balanced same-chain pairs
    """
    matched = set()
    queue   = []
    avail   = list(fighters)

    # Pass 1 — King Clashes
    kings = [f for f in avail if f.get("is_king")]
    for i in range(0, len(kings) - 1, 2):
        queue.append(_create_match(kings[i], kings[i + 1], "KING_CLASH"))
        matched.add(kings[i]["unique_id"])
        matched.add(kings[i + 1]["unique_id"])

    remaining = [f for f in avail if f["unique_id"] not in matched]

    # Pass 2 — Cross-chain rivalry
    by_chain = {
        "solana": [f for f in remaining if f["chain"] == "solana"],
        "bsc":    [f for f in remaining if f["chain"] == "bsc"],
        "base":   [f for f in remaining if f["chain"] == "base"],
    }

    rivalry_pairs = [
        (by_chain["solana"], by_chain["bsc"],  "SOL_VS_BSC"),
        (by_chain["bsc"],    by_chain["base"], "BSC_VS_BASE"),
        (by_chain["solana"], by_chain["base"], "SOL_VS_BASE"),
    ]

    for pool_a, pool_b, match_type in rivalry_pairs:
        unused_a = [f for f in pool_a if f["unique_id"] not in matched]
        unused_b = [f for f in pool_b if f["unique_id"] not in matched]
        for a in unused_a:
            if a["unique_id"] in matched:
                continue
            ecps_a = calculate_ecps(a)
            candidates = sorted(
                [b for b in unused_b if b["unique_id"] not in matched],
                key=lambda b: abs(calculate_ecps(b) - ecps_a)
            )
            if not candidates:
                continue
            b = candidates[0]
            ecps_diff = abs(calculate_ecps(b) - ecps_a)
            if ecps_a == 0 or ecps_diff / max(ecps_a, 1) <= 0.40:
                queue.append(_create_match(a, b, match_type))
                matched.add(a["unique_id"])
                matched.add(b["unique_id"])

    # Pass 3 — ECPS balanced (leftover fighters, any chain)
    leftover = [f for f in remaining if f["unique_id"] not in matched]
    for i, a in enumerate(leftover):
        if a["unique_id"] in matched:
            continue
        ecps_a = calculate_ecps(a)
        candidates = sorted(
            [b for j, b in enumerate(leftover) if j != i and b["unique_id"] not in matched],
            key=lambda b: abs(calculate_ecps(b) - ecps_a)
        )
        if candidates:
            b = candidates[0]
            queue.append(_create_match(a, b, "BALANCED"))
            matched.add(a["unique_id"])
            matched.add(b["unique_id"])

    return queue


# ─────────────────────────────────────────────────────────────────────────────
# PART 7 — BATTLE ENGINE  (round-based HP simulation)
# ─────────────────────────────────────────────────────────────────────────────

def simulate_battle(fighter_a, fighter_b):
    """
    Simulate a fight round-by-round.
    Damage formula adapted from ECPS traits.
    Returns a battle result dict.
    """
    hp_a = float(fighter_a.get("hp", 100))
    hp_b = float(fighter_b.get("hp", 100))
    rounds = 0
    max_rounds = 25

    while hp_a > 0 and hp_b > 0 and rounds < max_rounds:
        rounds += 1

        # A attacks B
        atk_a   = fighter_a.get("aggression",   50) / 100.0
        spd_a   = fighter_a.get("speed",        50) / 100.0
        luck_a  = fighter_a.get("luck",         50) / 100.0
        def_b   = fighter_b.get("defense",      50) / 100.0
        intel_a = fighter_a.get("intelligence", 50) / 100.0

        base_dmg_a = (atk_a * 18 + spd_a * 4 + luck_a * 3 + intel_a * 2) * (1 - def_b * 0.45)
        dmg_a = max(1.0, base_dmg_a * random.uniform(0.75, 1.30))
        hp_b -= dmg_a
        if hp_b <= 0:
            break

        # B attacks A
        atk_b   = fighter_b.get("aggression",   50) / 100.0
        spd_b   = fighter_b.get("speed",        50) / 100.0
        luck_b  = fighter_b.get("luck",         50) / 100.0
        def_a   = fighter_a.get("defense",      50) / 100.0
        intel_b = fighter_b.get("intelligence", 50) / 100.0

        base_dmg_b = (atk_b * 18 + spd_b * 4 + luck_b * 3 + intel_b * 2) * (1 - def_a * 0.45)
        dmg_b = max(1.0, base_dmg_b * random.uniform(0.75, 1.30))
        hp_a -= dmg_b

    # Winner
    if hp_a >= hp_b:
        winner, loser = fighter_a, fighter_b
        hp_remaining = int(max(0, hp_a))
    else:
        winner, loser = fighter_b, fighter_a
        hp_remaining = int(max(0, hp_b))

    bc_pool = 576 + int(_norm(winner.get("market_cap_usd", 0), 0, 5_000_000) * 1000)

    return {
        "match_id":             f"battle_{int(time.time())}_{random.randint(1000,9999)}",
        "winner":               winner,
        "loser":                loser,
        "match_type":           "BALANCED",
        "winner_hp_remaining":  hp_remaining,
        "rounds_fought":        rounds,
        "bc_pool":              bc_pool,
        "created_at":           datetime.now(timezone.utc).isoformat(),
    }


def save_battle_result(result, match_type="BALANCED"):
    """Persist battle result to DB."""
    _exec("""
        INSERT INTO trending_battle_results
            (match_id, match_type, winner_id, loser_id,
             winner_chain, loser_chain, winner_name, loser_name,
             winner_hp_remaining, rounds_fought, bc_pool)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """, (
        result["match_id"], match_type,
        result["winner"].get("unique_id"), result["loser"].get("unique_id"),
        result["winner"].get("chain"), result["loser"].get("chain"),
        result["winner"].get("display_name"), result["loser"].get("display_name"),
        result["winner_hp_remaining"], result["rounds_fought"], result["bc_pool"],
    ))


# ─────────────────────────────────────────────────────────────────────────────
# PART 8 — LEADERBOARD SERVICE
# ─────────────────────────────────────────────────────────────────────────────

def update_leaderboard(result):
    """Called after every battle. Updates win/loss/streak + recalculates ranks."""
    winner_id = result["winner"].get("unique_id")
    loser_id  = result["loser"].get("unique_id")
    bc        = result["bc_pool"]

    if winner_id:
        _exec("""
            UPDATE trending_fighter_stats SET
                wins            = wins + 1,
                win_streak      = win_streak + 1,
                total_bc_earned = total_bc_earned + %s,
                last_fought_at  = NOW()
            WHERE fighter_unique_id = %s
        """, (bc, winner_id))

    if loser_id:
        _exec("""
            UPDATE trending_fighter_stats SET
                losses         = losses + 1,
                win_streak     = 0,
                last_fought_at = NOW()
            WHERE fighter_unique_id = %s
        """, (loser_id,))

    # Recalculate global rank: 50% wins + 30% win_streak + 20% bc_earned
    _exec("""
        UPDATE trending_fighter_stats SET global_rank = sub.rank
        FROM (
            SELECT fighter_unique_id,
                   RANK() OVER (
                       ORDER BY (wins * 0.5 + win_streak * 0.3 + total_bc_earned * 0.2) DESC
                   ) AS rank
            FROM trending_fighter_stats
        ) sub
        WHERE trending_fighter_stats.fighter_unique_id = sub.fighter_unique_id
    """)

    # Recalculate per-chain rank
    for chain in ["solana", "bsc", "base"]:
        _exec("""
            UPDATE trending_fighter_stats SET chain_rank = sub.rank
            FROM (
                SELECT fighter_unique_id,
                       RANK() OVER (ORDER BY wins DESC) AS rank
                FROM trending_fighter_stats
                WHERE chain = %s
            ) sub
            WHERE trending_fighter_stats.fighter_unique_id = sub.fighter_unique_id
            AND trending_fighter_stats.chain = %s
        """, (chain, chain))


def get_leaderboard(chain="all", limit=20):
    chain_filter = "" if chain == "all" else f"AND f.chain = '{chain}'"
    return _query(f"""
        SELECT
            f.unique_id, f.chain, f.display_name, f.full_name,
            f.image_uri, f.processed_avatar,
            f.market_cap_usd, f.is_king, f.arena_status,
            COALESCE(s.wins,0) AS wins,
            COALESCE(s.losses,0) AS losses,
            COALESCE(s.win_streak,0) AS win_streak,
            COALESCE(s.total_bc_earned,0) AS total_bc_earned,
            COALESCE(s.global_rank,999) AS global_rank,
            COALESCE(s.chain_rank,999) AS chain_rank,
            COALESCE(s.badges,'{{}}') AS badges,
            s.last_fought_at,
            CASE WHEN (COALESCE(s.wins,0)+COALESCE(s.losses,0))=0 THEN 0
                 ELSE ROUND(COALESCE(s.wins,0)::numeric /
                      (COALESCE(s.wins,0)+COALESCE(s.losses,0)) * 100, 1)
            END AS win_rate_pct
        FROM trending_fighter_profiles f
        LEFT JOIN trending_fighter_stats s ON s.fighter_unique_id = f.unique_id
        WHERE f.arena_status = 'active' {chain_filter}
        ORDER BY COALESCE(s.global_rank, 999) ASC
        LIMIT %s
    """, (limit,))


def get_recent_battles(limit=20):
    return _query("""
        SELECT winner_name, winner_chain, loser_name, loser_chain,
               match_type, rounds_fought, bc_pool, created_at
        FROM trending_battle_results
        ORDER BY created_at DESC
        LIMIT %s
    """, (limit,))


# ─────────────────────────────────────────────────────────────────────────────
# PART 9 — ORCHESTRATOR  (full 5-min refresh cycle)
# ─────────────────────────────────────────────────────────────────────────────

def _refresh_cycle():
    """
    One full cycle:
    1. Fetch coins from 3 chains
    2. Generate + upsert fighter profiles
    3. Process logos (circular avatars)
    4. Build match queue
    5. Simulate battles + update leaderboard
    6. Update in-memory state
    """
    global _refresh_start_time

    print("[TrendingEngine] Refresh cycle starting...", flush=True)
    with _lock:
        _state["is_refreshing"] = True
        _state["error"] = None
    _refresh_start_time = time.time()

    try:
        # ── 1. Fetch all chains ───────────────────────────────────────────────
        solana_coins = fetch_solana_trending(CHAIN_CONFIG["solana"]["slots"])
        bsc_coins    = fetch_bsc_trending(CHAIN_CONFIG["bsc"]["slots"])
        base_coins   = fetch_base_trending(CHAIN_CONFIG["base"]["slots"])

        all_coins = solana_coins + bsc_coins + base_coins
        if not all_coins:
            print("[TrendingEngine] No coins fetched — skipping cycle.", flush=True)
            return

        # ── 2. Generate fighter profiles ──────────────────────────────────────
        new_fighters = [generate_fighter_profile(c) for c in all_coins]

        # ── 3. Process logos (run in parallel via threads for speed) ──────────
        import concurrent.futures
        def process_one(f):
            avatar = process_coin_logo(f["image_uri"])
            f["processed_avatar"] = avatar
            return f

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            new_fighters = list(pool.map(process_one, new_fighters))

        # ── 4. Upsert to DB, retire stale ────────────────────────────────────
        keep_ids = [f["unique_id"] for f in new_fighters]
        retire_stale_fighters(keep_ids)
        for f in new_fighters:
            upsert_fighter_profile(f)

        # ── 5. Reload from DB (has real win/loss stats) ───────────────────────
        db_fighters = load_active_fighters_from_db()

        # Merge processed_avatar into db_fighters (DB may not have it yet)
        avatar_map = {f["unique_id"]: f.get("processed_avatar") for f in new_fighters}
        for f in db_fighters:
            uid = f.get("unique_id") or f.get("fighter_unique_id", "")
            if not f.get("processed_avatar") and uid in avatar_map:
                f["processed_avatar"] = avatar_map[uid]
            # Normalise fields (DB columns use underscores, stats join uses alias)
            for k in ["wins", "losses", "win_streak", "global_rank", "chain_rank"]:
                if f.get(k) is None:
                    f[k] = 0 if k != "global_rank" and k != "chain_rank" else 999

        # ── 6. Build match queue + simulate battles ───────────────────────────
        match_queue = build_match_queue(db_fighters)
        battle_results = []
        live_match = None

        for match in match_queue:
            result = simulate_battle(match["fighter_a"], match["fighter_b"])
            result["match_type"] = match["match_type"]
            result["label"]      = match["label"]
            save_battle_result(result, match["match_type"])
            update_leaderboard(result)
            battle_results.append({
                "winner_name":  result["winner"]["display_name"],
                "winner_chain": result["winner"]["chain"],
                "loser_name":   result["loser"]["display_name"],
                "loser_chain":  result["loser"]["chain"],
                "match_type":   result["match_type"],
                "label":        result.get("label", ""),
                "rounds":       result["rounds_fought"],
                "bc_pool":      result["bc_pool"],
                "created_at":   result["created_at"],
            })

        # Pick one match as the "live" display match (prefer chain rivalry)
        if match_queue:
            priority = ["KING_CLASH", "SOL_VS_BSC", "BSC_VS_BASE", "SOL_VS_BASE", "BALANCED"]
            for ptype in priority:
                m = next((m for m in match_queue if m["match_type"] == ptype), None)
                if m:
                    live_match = {
                        "fighter_a":  m["fighter_a"],
                        "fighter_b":  m["fighter_b"],
                        "match_type": m["match_type"],
                        "label":      m["label"],
                    }
                    break

        # ── 7. Reload fresh stats + update state ─────────────────────────────
        final_fighters = load_active_fighters_from_db()
        for f in final_fighters:
            uid = f.get("unique_id", "")
            if not f.get("processed_avatar") and uid in avatar_map:
                f["processed_avatar"] = avatar_map[uid]
            for k in ["wins", "losses", "win_streak", "global_rank", "chain_rank"]:
                if f.get(k) is None:
                    f[k] = 0 if k not in ("global_rank", "chain_rank") else 999

        recent = get_recent_battles(MAX_RECENT_BATTLES)
        # Convert datetime objects to ISO strings for JSON
        for r in recent:
            if r.get("created_at") and hasattr(r["created_at"], "isoformat"):
                r["created_at"] = r["created_at"].isoformat()

        with _lock:
            _state["fighters"]       = final_fighters
            _state["live_match"]     = live_match
            _state["recent_battles"] = recent
            _state["last_refreshed"] = datetime.now(timezone.utc).isoformat()
            _state["is_refreshing"]  = False

        print(
            f"[TrendingEngine] Cycle complete: {len(final_fighters)} fighters, "
            f"{len(match_queue)} matches simulated.", flush=True
        )

    except Exception as e:
        import traceback
        err = traceback.format_exc()
        print(f"[TrendingEngine] Cycle error: {e}\n{err}", flush=True)
        with _lock:
            _state["is_refreshing"] = False
            _state["error"] = str(e)


def _background_loop():
    """Background thread: run refresh cycle every REFRESH_INTERVAL seconds."""
    global _refresh_start_time
    # Small initial delay so server can start first
    time.sleep(5)
    while True:
        _refresh_start_time = time.time()
        try:
            _refresh_cycle()
        except Exception as e:
            print(f"[TrendingEngine] Unhandled error in loop: {e}", flush=True)
        elapsed = time.time() - _refresh_start_time
        sleep_for = max(30, REFRESH_INTERVAL - elapsed)
        print(f"[TrendingEngine] Next refresh in {int(sleep_for)}s.", flush=True)
        time.sleep(sleep_for)


def start_background_refresh():
    """Start the background refresh thread. Call once on server start."""
    t = threading.Thread(target=_background_loop, daemon=True, name="TrendingEngine")
    t.start()
    print("[TrendingEngine] Background refresh thread started.", flush=True)
