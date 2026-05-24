#!/bin/bash
# Watchdog: restarts WhatsApp sender if it dies

WA_DIR="/root/whatsapp-sender"
PID_FILE="$WA_DIR/whatsapp.pid"
LOG="$WA_DIR/whatsapp.log"
WATCHDOG_LOG="$WA_DIR/watchdog.log"

while true; do
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        : # still running
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] WhatsApp sender down — restarting..." >> "$WATCHDOG_LOG"
        # Kill anything still holding port 3001 before starting fresh
        OLD_PID=$(fuser 3001/tcp 2>/dev/null | tr -d ' ')
        [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null && sleep 1
        cd "$WA_DIR"
        nohup node index.js >> "$LOG" 2>&1 &
        echo $! > "$PID_FILE"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarted PID $(cat "$PID_FILE")" >> "$WATCHDOG_LOG"
    fi
    sleep 30
done
