# BantahBro Arena

A crypto battle / watch-to-earn arena platform. The UI shows live battles, predictions, a leaderboard, and a trollbox. Users log in via wallet (Privy).

## How to run

The workflow **"Start application"** runs `python serve.py`, which starts a plain Python HTTP server on port 5000. No build step needed — the frontend is pre-built static HTML/CSS/JS served directly from `game/newpfp/`.

```
python serve.py
```

## Stack

- **Frontend**: Static HTML (`game/newpfp/index.html`) + CSS (`game/styles/`) — no framework, no bundler.
- **Wallet auth**: `@privy-io/react-auth@3.33.1` loaded via esm.sh CDN with React 19.
- **Backend**: Pure Python `http.server` (`serve.py`) with a small JSON API.
- **State**: `app_state.json` (profile + notifications), created on first run.

## API routes (serve.py)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/profile` | Fetch user profile |
| PUT | `/api/profile` | Update profile fields |
| GET | `/api/notifications` | List notifications |
| GET | `/api/notifications/unread-count` | Unread count |
| PATCH | `/api/notifications/read-all` | Mark all read |
| PATCH | `/api/notifications/{id}/read` | Mark one read |
| DELETE | `/api/notifications/{id}` | Delete notification |
| DELETE | `/api/notifications/clear-all` | Clear all |

## Privy wallet login

App ID is hardcoded in `game/newpfp/index.html` (`PRIVY_APP_ID`). Both React and Privy versions are pinned (`PRIVY_REACT_VERSION`, `PRIVY_PKG_VERSION`) to prevent silent breakage from CDN updates. The login domain must be whitelisted in the Privy dashboard.

## User preferences
