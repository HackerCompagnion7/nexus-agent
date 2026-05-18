#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  JARVIS — Termux Background Service
#  Keeps JARVIS running in background with wake-lock
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.jarvis.pid"
LOG_FILE="$SCRIPT_DIR/jarvis.log"

start() {
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if kill -0 "$OLD_PID" 2>/dev/null; then
            echo "JARVIS already running (PID $OLD_PID)"
            return 1
        fi
        rm -f "$PID_FILE"
    fi

    echo "Starting JARVIS..."

    # Acquire wake lock (keeps CPU alive)
    if command -v termux-wake-lock &>/dev/null; then
        termux-wake-lock
        echo "Wake lock acquired"
    fi

    # Start in background with nohup
    nohup node "$SCRIPT_DIR/index.js" --web 8080 > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    sleep 2

    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "JARVIS started (PID $(cat "$PID_FILE"))"
        echo "Web interface: http://localhost:8080"
        echo "Log: $LOG_FILE"
    else
        echo "Failed to start. Check $LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "JARVIS not running"
        return 0
    fi

    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "JARVIS stopped (PID $PID)"
    fi

    rm -f "$PID_FILE"

    # Release wake lock
    if command -v termux-wake-unlock &>/dev/null; then
        termux-wake-unlock
        echo "Wake lock released"
    fi
}

status() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "JARVIS running (PID $PID)"
            echo "Web: http://localhost:8080"
            return 0
        fi
    fi
    echo "JARVIS not running"
    return 1
}

log() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        echo "No log file found"
    fi
}

case "${1:-start}" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; sleep 1; start ;;
    status)  status ;;
    log)     log ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|log}"
        echo ""
        echo "  start    Start JARVIS in background"
        echo "  stop     Stop JARVIS"
        echo "  restart  Restart JARVIS"
        echo "  status   Check if running"
        echo "  log      Follow log output"
        ;;
esac
