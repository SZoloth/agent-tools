#!/bin/bash
# Start or attach to a persistent Claude Code tmux session

SESSION_NAME="${1:-claude}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Attaching to existing session: $SESSION_NAME"
    tmux attach -t "$SESSION_NAME"
else
    echo "Creating new session: $SESSION_NAME"
    tmux new-session -s "$SESSION_NAME" -d
    tmux send-keys -t "$SESSION_NAME" "claude" Enter
    tmux attach -t "$SESSION_NAME"
fi
