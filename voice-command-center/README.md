# Voice Command Center

Voice-first personal assistant for Things 3, Calendar, and CRM.

## Setup on Raspberry Pi

```bash
# Copy to Pi
scp -r voice-command-center/ pi@your-pi:~/

# SSH into Pi
ssh pi@your-pi

# Install
cd voice-command-center
pip install -r requirements.txt

# Run interactively
python3 main.py

# Or with commands
python3 main.py "add task buy milk"
python3 main.py "what's on my calendar tomorrow"
python3 main.py "log outreach to Company X"
```

## Voice Integration

For voice input, integrate with:
- [Vosk](https://github.com/alphacep/vosk-api) - lightweight offline STT
- [Picovoice Porcupine](https://github.com/Picovoice/porcupine) - wake word
- [Piper](https://github.com/rhasspy/piper) - offline TTS for responses

Example wake word + STT pipeline:
```bash
# Stream audio from mic, detect "hey assistant", transcribe
arecord -f S16_LE -r 16000 -c 1 | vosk-model-en-us | parse_for_command
```

## Commands

### Things 3
- `add task <title>` - Create new task
- `complete task <search>` - Mark task complete
- `list tasks` - Show pending tasks

### Calendar
- `what's on my calendar today/tomorrow` - Query events
- `add meeting with <name> at <time>` - Create event

### CRM
- `log outreach to <company>` - Log outreach
- `what's my outreach streak` - Check stats
- `info on <company>` - View company history

## Data

Outreach data saved to: `~/agent-tools/metrics/data/outreach-log.json`
