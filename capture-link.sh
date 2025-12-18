#!/bin/bash
# Quick link capture for weekly ship report
# Usage: capture-link.sh "https://url" "optional note"
# Can be triggered from Alfred, Raycast, or command line

URL="$1"
NOTE="${2:-}"
LINKS_FILE="$HOME/.claude/state/weekly-links.json"
WEEK=$(date +%Y-W%V)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Validate URL
if [[ ! "$URL" =~ ^https?:// ]]; then
    echo "Error: First argument must be a valid URL starting with http:// or https://"
    exit 1
fi

# Ensure state directory exists
mkdir -p "$(dirname "$LINKS_FILE")"

# Initialize or reset file if week changed
if [ ! -f "$LINKS_FILE" ]; then
    echo "{\"week\": \"$WEEK\", \"links\": []}" > "$LINKS_FILE"
else
    CURRENT_WEEK=$(jq -r '.week // ""' "$LINKS_FILE" 2>/dev/null || echo "")
    if [ "$CURRENT_WEEK" != "$WEEK" ]; then
        # Archive old week's count before reset
        OLD_COUNT=$(jq '.links | length' "$LINKS_FILE" 2>/dev/null || echo "0")
        echo "Note: Archived $OLD_COUNT links from $CURRENT_WEEK"
        echo "{\"week\": \"$WEEK\", \"links\": []}" > "$LINKS_FILE"
    fi
fi

# Add the new link
jq --arg url "$URL" \
   --arg note "$NOTE" \
   --arg ts "$TIMESTAMP" \
   '.links += [{"url": $url, "note": $note, "source": "shell", "captured_at": $ts}]' \
   "$LINKS_FILE" > "$LINKS_FILE.tmp" && mv "$LINKS_FILE.tmp" "$LINKS_FILE"

# Get count and confirm
COUNT=$(jq '.links | length' "$LINKS_FILE")
echo "Captured: $URL"
[ -n "$NOTE" ] && echo "Note: $NOTE"
echo "Week $WEEK: $COUNT link(s) total"

# Optional: macOS notification
if command -v osascript &> /dev/null; then
    osascript -e "display notification \"Link captured for ship report\" with title \"$COUNT links this week\""
fi
