import json
import re
from datetime import datetime, timedelta
from pathlib import Path


DATA_FILE = Path.home() / "agent-tools" / "metrics" / "data" / "outreach-log.json"


class CRMAbility:
    def __init__(self):
        self.intents = ["crm_log_outreach", "crm_streak", "crm_company"]
        self.handlers = {
            "crm_log_outreach": self.log_outreach,
            "crm_streak": self.get_streak,
            "crm_company": self.company_info,
        }
        self.examples = {
            "crm_log_outreach": [
                "log outreach to Company X",
                "recorded contact with Jane from Acme",
                "did outreach at Google today",
            ],
            "crm_streak": [
                "what's my outreach streak",
                "how many outreach this week",
                "streak status",
            ],
            "crm_company": [
                "info on Company X",
                "notes about Google",
                "what do I know about Acme",
            ],
        }

    def _load_data(self) -> dict:
        if DATA_FILE.exists():
            with open(DATA_FILE) as f:
                return json.load(f)
        return {"outreaches": [], "responses": [], "interviews": []}

    def _save_data(self, data: dict) -> None:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(DATA_FILE, "w") as f:
            json.dump(data, f, indent=2)

    def _calculate_streak(self, outreaches: list) -> int:
        if not outreaches:
            return 0

        dates = sorted(set(outreach["date"] for outreach in outreaches), reverse=True)

        today = datetime.now().date()
        streak = 0
        check_date = today

        for date_str in dates:
            date = datetime.strptime(date_str, "%Y-%m-%d").date()
            if date == check_date or date == check_date - timedelta(days=1):
                streak += 1
                check_date = date
            else:
                break

        return streak

    def _this_week_count(self, outreaches: list) -> int:
        today = datetime.now()
        week_start = today - timedelta(days=today.weekday())
        week_start_date = week_start.date()

        count = 0
        for outreach in outreaches:
            date = datetime.strptime(outreach["date"], "%Y-%m-%d").date()
            if date >= week_start_date:
                count += 1

        return count

    def log_outreach(self, command: str) -> str:
        company_match = re.search(
            r"(?:to|at|with|from)\s+([A-Z][A-Za-z0-9\s]+?)(?:\s+(?:today|yesterday|$))",
            command,
            re.IGNORECASE,
        )

        if not company_match:
            company_match = re.search(
                r"(?:outreach|contact)\s+(?:to|at|with)?\s+(.+)", command, re.IGNORECASE
            )

        if not company_match:
            return "Couldn't understand. Try: 'log outreach to Company X'"

        company = company_match.group(1).strip().rstrip(".")

        data = self._load_data()
        today = datetime.now().strftime("%Y-%m-%d")

        outreach_entry = {
            "date": today,
            "company": company,
            "type": "voice_log",
            "notes": "Logged via voice command",
        }

        data["outreaches"].append(outreach_entry)
        self._save_data(data)

        streak = self._calculate_streak(data["outreaches"])

        return f"Logged outreach to '{company}'. Current streak: {streak} days"

    def get_streak(self, command: str) -> str:
        data = self._load_data()
        streak = self._calculate_streak(data["outreaches"])
        week_count = self._this_week_count(data["outreaches"])

        total = len(data["outreaches"])
        responses = len(data.get("responses", []))
        interviews = len(data.get("interviews", []))

        return (
            f"Outreach Stats:\n"
            f"  • Current streak: {streak} days\n"
            f"  • This week: {week_count} outreach(s)\n"
            f"  • Total outreach: {total}\n"
            f"  • Responses: {responses}\n"
            f"  • Interviews: {interviews}"
        )

    def company_info(self, command: str) -> str:
        company_match = re.search(
            r"(?:info|notes?|about|on)\s+(?:on|for|about)?\s*(.+)",
            command,
            re.IGNORECASE,
        )

        if not company_match:
            return "Which company? Try: 'info on Company X'"

        search_term = company_match.group(1).strip().lower()

        data = self._load_data()

        matches = [
            o for o in data["outreaches"] if search_term in o.get("company", "").lower()
        ]

        if not matches:
            return f"No outreach found for '{search_term}'"

        company_name = matches[0]["company"]
        outreach_count = len(matches)

        recent = matches[-3:]

        lines = [f"Company: {company_name} ({outreach_count} outreach(s))"]
        for o in reversed(recent):
            lines.append(f"  • {o['date']}: {o.get('notes', 'No notes')}")

        return "\n".join(lines)
