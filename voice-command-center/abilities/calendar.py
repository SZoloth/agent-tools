import subprocess
import re
from datetime import datetime, timedelta


class CalendarAbility:
    def __init__(self):
        self.intents = ["calendar_query", "calendar_create"]
        self.handlers = {
            "calendar_query": self.query_calendar,
            "calendar_create": self.create_event,
        }
        self.examples = {
            "calendar_query": [
                "what's on my calendar today",
                "show me tomorrow's meetings",
                "do I have anything at 3pm",
            ],
            "calendar_create": [
                "add meeting with John at 3pm",
                "schedule lunch tomorrow at noon",
                "book 30 min with team Friday",
            ],
        }

    def _run_applescript(self, script: str) -> str:
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return result.stdout.strip()
        except Exception as e:
            return f"Error: {e}"

    def _parse_relative_date(self, text: str) -> str:
        text = text.lower()
        today = datetime.now()

        if "today" in text:
            return today.strftime("%Y-%m-%d")
        if "tomorrow" in text:
            return (today + timedelta(days=1)).strftime("%Y-%m-%d")
        if "monday" in text:
            days_ahead = (7 - today.weekday()) % 7 or 7
            return (today + timedelta(days_ahead)).strftime("%Y-%m-%d")
        if "tuesday" in text:
            days_ahead = (7 - today.weekday() + 1) % 7 or 7
            return (today + timedelta(days_ahead)).strftime("%Y-%m-%d")
        if "wednesday" in text:
            days_ahead = (7 - today.weekday() + 2) % 7 or 7
            return (today + timedelta(days_ahead)).strftime("%Y-%m-%d")
        if "thursday" in text:
            days_ahead = (7 - today.weekday() + 3) % 7 or 7
            return (today + timedelta(days_ahead)).strftime("%Y-%m-%d")
        if "friday" in text:
            days_ahead = (7 - today.weekday() + 4) % 7 or 7
            return (today + timedelta(days_ahead)).strftime("%Y-%m-%d")

        return today.strftime("%Y-%m-%d")

    def query_calendar(self, command: str) -> str:
        date = self._parse_relative_date(command)

        script = f'''
        tell application "Calendar"
            set output to ""
            set calDate to date "{date}"
            set startDate to calDate
            set endDate to calDate + 1 * days
            tell calendar "Home"
                set eventsList to events where start date > startDate and start date < endDate
                repeat with evt in eventsList
                    set output to output & (start time of evt as string) & " - " & summary of evt & "\n"
                end repeat
            end tell
            tell calendar "Work"
                set eventsList to events where start date > startDate and start date < endDate
                repeat with evt in eventsList
                    set output to output & (start time of evt as string) & " - " & summary of evt & "\n"
                end repeat
            end tell
            return output
        end tell
        '''

        result = self._run_applescript(script)
        if not result or result == "":
            return f"No events on {date}"

        return f"Events on {date}:\n{result}"

    def create_event(self, command: str) -> str:
        title_match = re.search(
            r"(?:meeting|event|with|book|schedule)?\s*(?:with\s+)?(.+?)(?:\s+(?:at|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?$",
            command,
            re.IGNORECASE,
        )

        if not title_match:
            return "Couldn't understand. Try: 'add meeting with John at 3pm'"

        title = title_match.group(1).strip()
        if not title:
            title = "New Event"

        time_match = re.search(
            r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", command, re.IGNORECASE
        )

        if time_match:
            hour = int(time_match.group(1))
            minute = int(time_match.group(2) or 0)
            ampm = time_match.group(3)

            if ampm and ampm.lower() == "pm" and hour != 12:
                hour += 12
            elif ampm and ampm.lower() == "am" and hour == 12:
                hour = 0
        else:
            hour = 9
            minute = 0

        date = self._parse_relative_date(command)

        script = f'''
        tell application "Calendar"
            tell calendar "Home"
                make new event with properties {{summary: "{title}", start date: date "{date} {hour}:{minute:02d}", end date: date "{date} {hour}:{minute:02d}" + 30 * minutes}}
            end tell
        end tell
        '''

        result = self._run_applescript(script)
        if "Error" in result:
            return f"Failed to create event: {result}"

        return f"Created event: '{title}' at {hour}:{minute:02d}"
