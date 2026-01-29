#!/bin/bash
# claudio-screenshot.sh - Capture screenshot for Claudio voice commands
# Returns the path to the captured screenshot
# Cleans up screenshots older than 1 hour

set -euo pipefail

# Screenshot directory
SCREENSHOT_DIR="/tmp/claudio-screens"
mkdir -p "$SCREENSHOT_DIR"

# Clean up old screenshots (older than 1 hour)
find "$SCREENSHOT_DIR" -name "*.png" -mmin +60 -delete 2>/dev/null || true

# Generate unique filename with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SCREENSHOT_PATH="$SCREENSHOT_DIR/screen-$TIMESTAMP.png"

# Capture screenshot (silent, no cursor, full screen)
screencapture -x "$SCREENSHOT_PATH"

# Output the path
echo "$SCREENSHOT_PATH"
