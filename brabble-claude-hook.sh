#!/bin/bash
# brabble-claude-hook.sh - Voice-to-LLM pipeline with multi-turn support
# Receives transcribed text from brabble, sends to configured LLM, speaks response
# Maintains conversation context until user explicitly starts new session

set -euo pipefail

TRANSCRIPTION="$1"
LOG_FILE="${HOME}/Library/Application Support/brabble/claude-hook.log"
SESSION_DIR="${HOME}/.config/brabble/claude-session"
CONFIG_FILE="${HOME}/.config/claudio/hook-config.sh"

# Source config file if it exists (sets CLAUDIO_* environment variables)
if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
fi

# Defaults if not set by config
CLAUDIO_PROVIDER="${CLAUDIO_PROVIDER:-claude}"
CLAUDIO_MODEL="${CLAUDIO_MODEL:-opus}"
CLAUDIO_COPY_CLIPBOARD="${CLAUDIO_COPY_CLIPBOARD:-false}"
CLAUDIO_TRANSCRIBE_ONLY="${CLAUDIO_TRANSCRIBE_ONLY:-false}"
CLAUDIO_SPEAK_RESPONSE="${CLAUDIO_SPEAK_RESPONSE:-true}"
CLAUDIO_API_KEY="${CLAUDIO_API_KEY:-}"
CLAUDIO_SCREEN_CONTEXT="${CLAUDIO_SCREEN_CONTEXT:-off}"
CLAUDIO_AGENTIC_MODE="${CLAUDIO_AGENTIC_MODE:-false}"
CLAUDIO_WAKE_COMMANDS="${CLAUDIO_WAKE_COMMANDS:-}"
CLAUDIO_STREAMING_RESPONSE="${CLAUDIO_STREAMING_RESPONSE:-false}"

# Screenshot helper script
SCREENSHOT_SCRIPT="${HOME}/agent-tools/claudio-screenshot.sh"

# SC-005: Screen context trigger phrases (case-insensitive matching)
SCREEN_TRIGGERS=("look at" "see this" "what's this" "whats this" "this error" "on screen" "showing" "looking at" "see the" "check this")

# Function to check if screen capture should be triggered
should_capture_screen() {
    local text="$1"
    local lower_text=$(echo "$text" | tr '[:upper:]' '[:lower:]')

    # Always capture if mode is "always"
    if [[ "$CLAUDIO_SCREEN_CONTEXT" == "always" ]]; then
        return 0
    fi

    # Check for trigger phrases if mode is "on-demand"
    if [[ "$CLAUDIO_SCREEN_CONTEXT" == "on-demand" ]]; then
        for trigger in "${SCREEN_TRIGGERS[@]}"; do
            if [[ "$lower_text" == *"$trigger"* ]]; then
                return 0
            fi
        done
    fi

    return 1
}

# SVR-004: Function to speak text progressively (sentence by sentence)
speak_streaming() {
    local text="$1"
    # Split on sentence boundaries and speak each
    echo "$text" | tr '.!?' '\n' | while IFS= read -r sentence; do
        sentence=$(echo "$sentence" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
        if [[ -n "$sentence" && ${#sentence} -gt 2 ]]; then
            say "$sentence" 2>/dev/null
        fi
    done
}

# WC-005: Function to check wake commands and prepend action
apply_wake_command() {
    local text="$1"
    local lower_text=$(echo "$text" | tr '[:upper:]' '[:lower:]')

    # If no wake commands configured, return original text
    if [[ -z "$CLAUDIO_WAKE_COMMANDS" ]]; then
        echo "$text"
        return
    fi

    # Parse wake commands JSON and find matching trigger
    local matched_action=""
    matched_action=$(echo "$CLAUDIO_WAKE_COMMANDS" | jq -r --arg text "$lower_text" '
        .[] | select(.trigger | ascii_downcase | . as $t | $text | contains($t)) | .action
    ' 2>/dev/null | head -1)

    if [[ -n "$matched_action" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Wake command matched: $matched_action" >> "$LOG_FILE"
        echo "$matched_action

$text"
    else
        echo "$text"
    fi
}

# Ensure session directory exists
mkdir -p "$SESSION_DIR"

# Log the incoming transcription
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Received: $TRANSCRIPTION [provider=$CLAUDIO_PROVIDER, model=$CLAUDIO_MODEL, transcribe_only=$CLAUDIO_TRANSCRIBE_ONLY]" >> "$LOG_FILE"

# Skip if transcription is too short
if [[ ${#TRANSCRIPTION} -lt 5 ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipped: too short" >> "$LOG_FILE"
    exit 0
fi

# T-017: Handle transcribe-only mode
if [[ "$CLAUDIO_TRANSCRIBE_ONLY" == "true" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Transcribe-only mode" >> "$LOG_FILE"

    # Clean up transcription with fast model
    CLEANUP_PROMPT="Clean up this transcription. Fix grammar, punctuation, remove filler words. Return only the cleaned text, nothing else."

    CLEANED_TEXT=$(claude -p "$CLEANUP_PROMPT

$TRANSCRIPTION" --model haiku --dangerously-skip-permissions 2>/dev/null || echo "$TRANSCRIPTION")

    # Copy to clipboard
    echo -n "$CLEANED_TEXT" | pbcopy
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied to clipboard: $CLEANED_TEXT" >> "$LOG_FILE"

    # Speak confirmation if enabled
    if [[ "$CLAUDIO_SPEAK_RESPONSE" == "true" ]]; then
        say "Copied" &
    fi

    echo "$CLEANED_TEXT"
    exit 0
fi

# Check for "new conversation" trigger phrases (case-insensitive)
LOWER_TEXT=$(echo "$TRANSCRIPTION" | tr '[:upper:]' '[:lower:]')
NEW_SESSION=false

if [[ "$LOWER_TEXT" == *"new conversation"* ]] || \
   [[ "$LOWER_TEXT" == *"new session"* ]] || \
   [[ "$LOWER_TEXT" == *"end session"* ]] || \
   [[ "$LOWER_TEXT" == *"start over"* ]] || \
   [[ "$LOWER_TEXT" == *"fresh start"* ]] || \
   [[ "$LOWER_TEXT" == *"forget everything"* ]] || \
   [[ "$LOWER_TEXT" == "reset" ]] || \
   [[ "$LOWER_TEXT" == "reset." ]]; then
    NEW_SESSION=true
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting new conversation" >> "$LOG_FILE"
    # Clear session by removing the session directory contents
    rm -rf "${SESSION_DIR:?}"/*
fi

# Get response based on provider
get_response() {
    local prompt="$1"
    local is_new="$2"
    local screenshot_path="$3"

    case "$CLAUDIO_PROVIDER" in
        claude)
            # T-014: Use Claude CLI with configured model
            cd "$SESSION_DIR"
            local image_args=""
            if [[ -n "$screenshot_path" && -f "$screenshot_path" ]]; then
                image_args="--image $screenshot_path"
            fi

            # AG-004: Handle agentic mode vs prompt-only mode
            if [[ "$CLAUDIO_AGENTIC_MODE" == "true" ]]; then
                # Agentic mode: no -p flag, allows tool use
                if [[ "$is_new" == "true" ]]; then
                    echo "$prompt" | claude --model "$CLAUDIO_MODEL" $image_args --dangerously-skip-permissions 2>/dev/null
                else
                    echo "$prompt" | claude --continue --model "$CLAUDIO_MODEL" $image_args --dangerously-skip-permissions 2>/dev/null
                fi
            else
                # Prompt-only mode: use -p flag
                if [[ "$is_new" == "true" ]]; then
                    claude -p "$prompt" --model "$CLAUDIO_MODEL" $image_args --dangerously-skip-permissions 2>/dev/null
                else
                    claude --continue -p "$prompt" --model "$CLAUDIO_MODEL" $image_args --dangerously-skip-permissions 2>/dev/null
                fi
            fi
            ;;

        openai)
            # T-015: Use OpenAI API
            if [[ -z "$CLAUDIO_API_KEY" ]]; then
                echo "Error: OpenAI API key not configured"
                return 1
            fi

            local response
            if [[ -n "$screenshot_path" && -f "$screenshot_path" ]]; then
                # SC-006: Include image for OpenAI vision models
                local base64_image=$(base64 < "$screenshot_path")
                response=$(curl -s https://api.openai.com/v1/chat/completions \
                    -H "Content-Type: application/json" \
                    -H "Authorization: Bearer $CLAUDIO_API_KEY" \
                    -d "$(jq -n --arg model "$CLAUDIO_MODEL" --arg content "$prompt" --arg image "$base64_image" '{
                        model: $model,
                        messages: [{
                            role: "user",
                            content: [
                                {type: "text", text: $content},
                                {type: "image_url", image_url: {url: ("data:image/png;base64," + $image)}}
                            ]
                        }],
                        max_tokens: 500
                    }')")
            else
                response=$(curl -s https://api.openai.com/v1/chat/completions \
                    -H "Content-Type: application/json" \
                    -H "Authorization: Bearer $CLAUDIO_API_KEY" \
                    -d "$(jq -n --arg model "$CLAUDIO_MODEL" --arg content "$prompt" '{
                        model: $model,
                        messages: [{role: "user", content: $content}],
                        max_tokens: 500
                    }')")
            fi

            echo "$response" | jq -r '.choices[0].message.content // "Sorry, I could not process that request."'
            ;;

        ollama)
            # T-015: Use local Ollama API
            local response
            response=$(curl -s http://localhost:11434/api/generate \
                -d "$(jq -n --arg model "$CLAUDIO_MODEL" --arg prompt "$prompt" '{
                    model: $model,
                    prompt: $prompt,
                    stream: false
                }')")

            echo "$response" | jq -r '.response // "Sorry, Ollama could not process that request."'
            ;;

        *)
            echo "Error: Unknown provider $CLAUDIO_PROVIDER"
            return 1
            ;;
    esac
}

# SC-005/SC-006: Capture screenshot if screen context is enabled
SCREENSHOT_PATH=""
if should_capture_screen "$TRANSCRIPTION"; then
    if [[ -x "$SCREENSHOT_SCRIPT" ]]; then
        SCREENSHOT_PATH=$("$SCREENSHOT_SCRIPT" 2>/dev/null || echo "")
        if [[ -n "$SCREENSHOT_PATH" ]]; then
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Screen captured: $SCREENSHOT_PATH" >> "$LOG_FILE"
        fi
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Warning: Screenshot script not found or not executable" >> "$LOG_FILE"
    fi
fi

# Get response from configured LLM
# WC-005: Apply wake command action if matched
PROCESSED_PROMPT=$(apply_wake_command "$TRANSCRIPTION")

RESPONSE=$(get_response "$PROCESSED_PROMPT" "$NEW_SESSION" "$SCREENSHOT_PATH" || echo "Sorry, I couldn't process that request.")

# Clean up screenshot after use
if [[ -n "$SCREENSHOT_PATH" && -f "$SCREENSHOT_PATH" ]]; then
    rm -f "$SCREENSHOT_PATH" 2>/dev/null || true
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Response: $RESPONSE" >> "$LOG_FILE"

# T-016: Copy to clipboard if enabled
if [[ "$CLAUDIO_COPY_CLIPBOARD" == "true" ]]; then
    echo -n "$RESPONSE" | pbcopy
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Response copied to clipboard" >> "$LOG_FILE"
fi

# Clean markdown formatting for speech
CLEAN_RESPONSE=$(echo "$RESPONSE" | sed 's/\*\*//g' | sed 's/\*//g' | sed 's/`//g' | head -c 500)

# SVR-004: Speak using macOS say if enabled
if [[ "$CLAUDIO_SPEAK_RESPONSE" == "true" ]]; then
    if [[ "$CLAUDIO_STREAMING_RESPONSE" == "true" ]]; then
        # Streaming mode: speak sentence by sentence for faster feedback
        speak_streaming "$CLEAN_RESPONSE" &
    else
        # Non-streaming: speak full response at once
        say "$CLEAN_RESPONSE" &
    fi
fi

# Print response for logging
echo "$RESPONSE"
