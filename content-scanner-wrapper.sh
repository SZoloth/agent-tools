#!/bin/bash
# content-scanner-wrapper.sh - Wrapper for launchd execution of content-scanner.js
set -e

export HOME="/Users/samuelz"
export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:$HOME/.local/bin:$HOME/agent-tools:$HOME/go/bin:$PATH"

exec /opt/homebrew/opt/node@22/bin/node "$HOME/agent-tools/content-scanner.js"
