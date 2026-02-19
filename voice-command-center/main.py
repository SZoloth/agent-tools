import json
from pathlib import Path
from abilities.things3 import Things3Ability
from abilities.calendar import CalendarAbility
from abilities.crm import CRMAbility


class VoiceCommandCenter:
    def __init__(self):
        self.abilities = {
            "things3": Things3Ability(),
            "calendar": CalendarAbility(),
            "crm": CRMAbility(),
        }
        self.ability_registry = self._build_registry()

    def _build_registry(self):
        registry = {}
        for name, ability in self.abilities.items():
            for intent in ability.intents:
                registry[intent] = {
                    "ability": name,
                    "handler": ability.handlers[intent],
                    "examples": ability.examples[intent],
                }
        return registry

    def handle_command(self, command: str) -> str:
        intent = self._classify_intent(command)
        if not intent:
            return "I didn't understand that. Try things like: 'add task buy milk' or 'what's on my calendar tomorrow'"

        ability_name = self.ability_registry[intent]["ability"]
        handler = self.ability_registry[intent]["handler"]

        result = handler(command)
        return result

    def _classify_intent(self, command: str) -> str | None:
        command_lower = command.lower()

        if any(w in command_lower for w in ["task", "todo", "things"]):
            if any(w in command_lower for w in ["add", "create", "new"]):
                return "things_add"
            if any(w in command_lower for w in ["complete", "done", "finish"]):
                return "things_complete"
            return "things_list"

        if any(
            w in command_lower for w in ["calendar", "event", "meeting", "schedule"]
        ):
            if any(w in command_lower for w in ["add", "create", "schedule", "book"]):
                return "calendar_create"
            return "calendar_query"

        if any(
            w in command_lower
            for w in [
                "outreach",
                "contact",
                "company",
                "reach out",
                "streak",
                "crm",
                "info",
                "about",
                "notes",
            ]
        ):
            if any(w in command_lower for w in ["log", "add", "record", "did"]):
                return "crm_log_outreach"
            if "streak" in command_lower:
                return "crm_streak"
            if any(w in command_lower for w in ["company", "notes", "info"]):
                return "crm_company"
            return "crm_log_outreach"

        return None

    def list_intents(self) -> str:
        lines = ["Available commands:"]
        for intent, info in self.ability_registry.items():
            lines.append(f"  • {intent} ({info['ability']})")
            for ex in info["examples"][:2]:
                lines.append(f'    Example: "{ex}"')
        return "\n".join(lines)


def main():
    import sys

    agent = VoiceCommandCenter()

    if len(sys.argv) > 1:
        if sys.argv[1] == "--list":
            print(agent.list_intents())
            return
        result = agent.handle_command(" ".join(sys.argv[1:]))
        print(result)
        return

    print("Voice Command Center ready. Say commands or type them.")
    print(
        "Examples: 'add task buy milk', 'what's on my calendar tomorrow', 'log outreach to Company X'"
    )
    print()

    while True:
        try:
            command = input("> ")
            if command.lower() in ["quit", "exit", "q"]:
                break
            result = agent.handle_command(command)
            print(result)
        except KeyboardInterrupt:
            break


if __name__ == "__main__":
    main()
