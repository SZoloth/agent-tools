#!/bin/bash
# claudio-report.sh - Generate daily report for Claudio/brabble
# Usage: claudio-report.sh [days_back] [output_dir]
#   days_back: number of days to analyze (default: 1)
#   output_dir: where to save report (default: ./reports)

DAYS_BACK="${1:-1}"
OUTPUT_DIR="${2:-./reports}"
BRABBLE_DIR="$HOME/Library/Application Support/brabble"
DATE=$(date -v-"${DAYS_BACK}"d +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)

# Create output directory if needed
mkdir -p "$OUTPUT_DIR"

# Output file
REPORT_FILE="$OUTPUT_DIR/report-${TODAY}.md"

# Log files
BRABBLE_LOG="$BRABBLE_DIR/brabble.log"
TRANSCRIPTS_LOG="$BRABBLE_DIR/transcripts.log"
CLAUDE_HOOK_LOG="$BRABBLE_DIR/claude-hook.log"

echo "# Claudio Daily Report - $TODAY" > "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
if [[ "$DAYS_BACK" -eq 0 ]]; then
    echo "Analysis period: Today ($DATE)" >> "$REPORT_FILE"
else
    echo "Analysis period: Last ${DAYS_BACK} day(s) (since $DATE)" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# --- Metrics Section ---
echo "## Metrics" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# Count transcriptions
if [[ -f "$TRANSCRIPTS_LOG" ]]; then
    TOTAL_TRANSCRIPTS=$(grep "^${DATE}" "$TRANSCRIPTS_LOG" 2>/dev/null | wc -l | tr -d ' ')
    echo "- **Total transcriptions:** $TOTAL_TRANSCRIPTS" >> "$REPORT_FILE"
fi

# Count Claude interactions
if [[ -f "$CLAUDE_HOOK_LOG" ]]; then
    RECEIVED_COUNT=$(grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep -c "Received:" || echo "0")
    RESPONSE_COUNT=$(grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep -c "Response:" || echo "0")
    echo "- **Claude requests:** $RECEIVED_COUNT" >> "$REPORT_FILE"
    echo "- **Claude responses:** $RESPONSE_COUNT" >> "$REPORT_FILE"

    if [[ "$RECEIVED_COUNT" -gt 0 ]]; then
        SUCCESS_RATE=$((RESPONSE_COUNT * 100 / RECEIVED_COUNT))
        echo "- **Success rate:** ${SUCCESS_RATE}%" >> "$REPORT_FILE"
    fi
fi

echo "" >> "$REPORT_FILE"

# --- Response Times ---
echo "### Response Times" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

if [[ -f "$CLAUDE_HOOK_LOG" ]]; then
    # Use Python for reliable time parsing
    DATE="$DATE" python3 << 'PYTHON' >> "$REPORT_FILE"
import re
from datetime import datetime
from pathlib import Path
import os

date_filter = os.environ.get('DATE', '')
log_path = Path.home() / "Library/Application Support/brabble/claude-hook.log"

if not log_path.exists():
    print("- No data available")
    exit()

content = log_path.read_text()
lines = content.strip().split('\n')

deltas = []
i = 0
while i < len(lines) - 1:
    if f'[{date_filter}' in lines[i] and 'Received:' in lines[i]:
        # Parse received timestamp
        match1 = re.search(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]', lines[i])
        if match1 and i + 1 < len(lines) and 'Response:' in lines[i+1]:
            match2 = re.search(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]', lines[i+1])
            if match2:
                t1 = datetime.strptime(match1.group(1), '%Y-%m-%d %H:%M:%S')
                t2 = datetime.strptime(match2.group(1), '%Y-%m-%d %H:%M:%S')
                delta = (t2 - t1).total_seconds()
                if 0 < delta < 300:  # Sanity check: 0-5 minutes
                    deltas.append(delta)
    i += 1

if deltas:
    avg = sum(deltas) / len(deltas)
    print(f"- **Average:** {avg:.1f}s")
    print(f"- **Min:** {min(deltas):.1f}s")
    print(f"- **Max:** {max(deltas):.1f}s")
    print(f"- **Samples:** {len(deltas)}")
else:
    print("- No response time data for this period")
PYTHON
fi

echo "" >> "$REPORT_FILE"

# --- Errors Section ---
echo "## Errors & Warnings" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

if [[ -f "$BRABBLE_LOG" ]]; then
    # Count warnings by type for today
    TODAY_OVERFLOW=$(grep "$DATE" "$BRABBLE_LOG" 2>/dev/null | grep -c "input overflow" || echo "0")
    NO_SPEECH=$(grep "$DATE" "$BRABBLE_LOG" 2>/dev/null | grep -c "no speech detected" || echo "0")
    ERRORS=$(grep "$DATE" "$BRABBLE_LOG" 2>/dev/null | grep -c "level=ERROR" | tr -d '\n' || echo "0")
    MULTILINGUAL=$(grep "$DATE" "$BRABBLE_LOG" 2>/dev/null | grep -c "not multilingual" | tr -d '\n' || echo "0")

    echo "| Issue | Count |" >> "$REPORT_FILE"
    echo "|-------|-------|" >> "$REPORT_FILE"
    echo "| Input overflow | $TODAY_OVERFLOW |" >> "$REPORT_FILE"
    echo "| No speech detected | $NO_SPEECH |" >> "$REPORT_FILE"
    echo "| Model not multilingual | $MULTILINGUAL |" >> "$REPORT_FILE"
    echo "| Errors | $ERRORS |" >> "$REPORT_FILE"
fi

echo "" >> "$REPORT_FILE"

# --- Usage Patterns Section ---
echo "## Usage Patterns" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

if [[ -f "$CLAUDE_HOOK_LOG" ]]; then
    echo "### Recent Commands" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"

    # Get recent successful commands
    grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep "Received:" | tail -10 | while read -r line; do
        CMD=$(echo "$line" | sed 's/.*Received: //')
        TIME=$(echo "$line" | grep -oE '\[.+\]' | head -1 | tr -d '[]' | cut -d' ' -f2)
        echo "- \`$TIME\` $CMD" >> "$REPORT_FILE"
    done

    echo "" >> "$REPORT_FILE"

    # Command frequency analysis
    echo "### Command Categories" >> "$REPORT_FILE"
    TIME_QUERIES=$(grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep -i "time" | grep -c "Received:" || echo "0")
    CALENDAR=$(grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep -i "calendar" | grep -c "Received:" | tr -d '\n' || echo "0")
    WEATHER=$(grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep -i "weather" | grep -c "Received:" || echo "0")
    OPEN_CMDS=$(grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep -i "open" | grep -c "Received:" || echo "0")

    echo "- Time queries: $TIME_QUERIES" >> "$REPORT_FILE"
    echo "- Calendar queries: $CALENDAR" >> "$REPORT_FILE"
    echo "- Weather queries: $WEATHER" >> "$REPORT_FILE"
    echo "- Open commands: $OPEN_CMDS" >> "$REPORT_FILE"
fi

echo "" >> "$REPORT_FILE"

# --- Observations Section ---
echo "## Observations" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

OVERFLOW_COUNT=${TODAY_OVERFLOW:-0}
if [[ "$OVERFLOW_COUNT" -gt 50 ]]; then
    echo "- ⚠️ **High input overflow count ($OVERFLOW_COUNT)** - may indicate audio buffer issues" >> "$REPORT_FILE"
fi

if [[ -f "$CLAUDE_HOOK_LOG" ]]; then
    NO_ACCESS=$(grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep -c "don't have access" || echo "0")
    if [[ "$NO_ACCESS" -gt 0 ]]; then
        echo "- ⚠️ **$NO_ACCESS queries couldn't be answered** - missing integrations" >> "$REPORT_FILE"
    fi
fi

echo "" >> "$REPORT_FILE"

# --- Potential Improvements ---
echo "## Potential Improvements" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "_Auto-generated based on patterns:_" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

if [[ -f "$CLAUDE_HOOK_LOG" ]]; then
    WEATHER_REQUESTS=$(grep "\[${DATE}" "$CLAUDE_HOOK_LOG" 2>/dev/null | grep -i "weather" | grep -c "Received:" || echo "0")
    if [[ "$WEATHER_REQUESTS" -gt 0 ]]; then
        echo "- [ ] Add weather API integration ($WEATHER_REQUESTS requests today)" >> "$REPORT_FILE"
    fi
fi

if [[ "${OVERFLOW_COUNT:-0}" -gt 100 ]]; then
    echo "- [ ] Tune audio buffer settings to reduce overflow warnings" >> "$REPORT_FILE"
fi

echo "" >> "$REPORT_FILE"
echo "---" >> "$REPORT_FILE"
echo "_Generated by claudio-report.sh at $(date)_" >> "$REPORT_FILE"

echo "Report saved to: $REPORT_FILE"
cat "$REPORT_FILE"
