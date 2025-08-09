# Telegram Poster Bot (TypeScript + GramJS)

This project sets up a TypeScript Node.js script that logs in to Telegram using GramJS, persists the session across restarts, periodically updates the list of writable groups, and posts random messages to a random writable group at configurable intervals.

Structure is organized to allow multiple scripts in the future.

## Features
- Login to Telegram via GramJS, with session persisted to file (no repeated login after the first run).
- Pulls the list of dialogs and filters those you can write to (groups only by default).
- Refreshes the writable groups list periodically (default: every 120 minutes).
- Posts a random configured message to a random writable group periodically (default: every 5 minutes).
- Fully configurable via YAML (timings, message list, groups-only switch).
- Robust error handling and flood-wait backoff for 24/7 operation.

## Prerequisites
- Node.js 18+
- Telegram API credentials (api_id and api_hash). Create yours at https://my.telegram.org

## Setup
1. Install dependencies:
   - npm install

2. Configure credentials and settings:
   - Copy config/config.example.yml to config/config.yml and edit the values.
     - telegram.api_id: your API ID
     - telegram.api_hash: your API HASH
     - telegram.phone (optional): E.164 (e.g., +15551234567) for first login convenience
     - telegram.password (optional): 2FA password if enabled
     - telegram.session_file: path to persist session (default sessions/telegram.session)
     - runtime.refresh_groups_interval_minutes: default 120
     - runtime.post_interval_minutes: default 5
     - runtime.groups_only: true to post only to groups
     - messages.list: array of messages to pick from randomly

   - You can also set credentials via environment variables:
     - TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE, TELEGRAM_PASSWORD

3. First run (interactive login):
   - npm run dev
   - The script will ask for your phone number (if not in config), then the code, and optionally 2FA password.
   - On success, it saves a session string to sessions/telegram.session. Next runs won’t ask for login.

4. Production run:
   - npm run build
   - npm start
   - Consider using a process manager (pm2/systemd/docker) for 24/7 operation.

## Project Structure
- src/config/index.ts: YAML config loader with env overrides and defaults.
- src/telegram/TelegramService.ts: GramJS wrapper (login, session persistence, writable group refresh, send message).
- src/scripts/poster.ts: Main script that schedules periodic refresh and posting.
- src/utils/prompt.ts: Console prompt helper (with masked input for passwords).

## Behavior Details
- Writable group detection:
  - Skips broadcast channels, left/deactivated chats, channels where sending is restricted, and non-megagroup channels.
  - If groups_only is true, DMs are skipped.
- Posting:
  - Every post interval, selects a random message and a random writable peer.
  - On send error (including flood wait), errors are logged; some non-writable peers may be removed from the pool.
  - If sending fails, a background refresh is attempted.
- Error handling:
  - Global unhandledRejection/uncaughtException handlers log errors.
  - Timers and session are cleaned on process termination.

## Notes
- Respect Telegram terms and API rate limits. Excessive posting may trigger flood-wait penalties.
- Ensure messages.list is non-empty in your config, otherwise posts are skipped.

## Scripts
- npm run dev: run TypeScript directly (interactive; good for first login)
- npm run build: compile TypeScript to dist
- npm start: run compiled poster script from dist

## License
ISC
