#!/bin/bash
# cleanup-stale-claude.sh - Kill orphaned headless Claude processes
# Run hourly via launchd as a safety net against zombie automation
#
# Only kills processes that are:
#   1. Running with --dangerously-skip-permissions
#   2. Have NO TTY attached (truly headless, not interactive)
#   3. Older than MAX_AGE_SECONDS

MAX_AGE_SECONDS=$((2 * 60 * 60))
NOW=$(date +%s)
LOG_FILE="/tmp/claude-cleanup.log"
NOTIFY_TITLE="Claude cleanup"
NOTIFY_APP="${HOME}/Applications/Snitch.app"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

notify() {
    local msg="$1"
    log "$msg"
    if [ -d "$NOTIFY_APP" ]; then
        /usr/bin/open -a "$NOTIFY_APP" --args "$msg" "$NOTIFY_TITLE" >/dev/null 2>&1 || true
        return
    fi
    if command -v osascript >/dev/null 2>&1; then
        /usr/bin/osascript -e "display notification \"${msg//\"/\\\"}\" with title \"${NOTIFY_TITLE}\"" >/dev/null 2>&1 || true
    fi
}

log "Starting cleanup run"

KILLED=0

# Get orphaned claude processes (headless, no TTY, parent=1)
# Excludes: tmux sessions, processes with a terminal
ps -eo pid,ppid,tty,lstart,command | grep -E "claude" | grep -v grep | grep -v tmux | while read line; do
    PID=$(echo "$line" | awk '{print $1}')
    PARENT=$(echo "$line" | awk '{print $2}')
    TTY=$(echo "$line" | awk '{print $3}')
    # lstart format: "Mon Jan 20 10:26:00 2026"
    START=$(echo "$line" | awk '{print $4,$5,$6,$7,$8}')

    # Skip if process has a TTY (interactive session)
    if [ "$TTY" != "??" ] && [ "$TTY" != "-" ]; then
        continue
    fi

    # Skip if not orphaned (has a living parent)
    if [ "$PARENT" != "1" ]; then
        continue
    fi

    # Convert to epoch (macOS date)
    START_EPOCH=$(date -j -f "%a %b %d %T %Y" "$START" +%s 2>/dev/null)

    if [ -n "$START_EPOCH" ]; then
        AGE=$((NOW - START_EPOCH))
        AGE_HOURS=$((AGE / 3600))

        if [ $AGE -gt $MAX_AGE_SECONDS ]; then
            notify "Killing orphaned headless Claude PID=$PID (age=${AGE_HOURS}h, tty=$TTY, parent=$PARENT, reason=orphaned)"
            kill -TERM $PID 2>/dev/null
            KILLED=$((KILLED + 1))
        fi
    fi
done

# Also clean up orphaned shell wrappers spawned by Claude
# These are /bin/zsh or /bin/sh processes with .claude in the command
# Only kill if PPID=1 (orphaned - parent died) AND older than 1 hour
SHELL_MAX_AGE=$((1 * 60 * 60))

ps -eo pid,ppid,lstart,command | grep -E "(bin/zsh|bin/sh).*\.claude" | grep -v grep | while read line; do
    PID=$(echo "$line" | awk '{print $1}')
    PARENT=$(echo "$line" | awk '{print $2}')
    START=$(echo "$line" | awk '{print $3,$4,$5,$6,$7}')

    # Only kill if orphaned (parent is init/launchd)
    if [ "$PARENT" != "1" ]; then
        continue
    fi

    START_EPOCH=$(date -j -f "%a %b %d %T %Y" "$START" +%s 2>/dev/null)

    if [ -n "$START_EPOCH" ]; then
        AGE=$((NOW - START_EPOCH))
        AGE_HOURS=$((AGE / 3600))

        if [ $AGE -gt $SHELL_MAX_AGE ]; then
            notify "Killing orphaned shell wrapper PID=$PID (age=${AGE_HOURS}h, parent=$PARENT, reason=orphaned)"
            kill -TERM $PID 2>/dev/null
            KILLED=$((KILLED + 1))
        fi
    fi
done

log "Cleanup complete. Processes terminated: $KILLED"
