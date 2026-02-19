import subprocess
import json
import re
from datetime import datetime, timedelta


class Things3Ability:
    def __init__(self):
        self.intents = ["things_add", "things_complete", "things_list"]
        self.handlers = {
            "things_add": self.add_task,
            "things_complete": self.complete_task,
            "things_list": self.list_tasks,
        }
        self.examples = {
            "things_add": [
                "add task buy milk",
                "create task call mom",
                "new todo finish report",
            ],
            "things_complete": [
                "complete task buy milk",
                "done with meeting notes",
                "finish task review design",
            ],
            "things_list": [
                "list my tasks",
                "what are my todos",
                "show today's tasks",
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

    def add_task(self, command: str) -> str:
        task_match = re.search(
            r"(?:add|create|new)\s+(?:task|todo|to-do)?\s+(.+)", command, re.IGNORECASE
        )
        if not task_match:
            return "Couldn't understand the task. Try: 'add task buy milk'"

        task_title = task_match.group(1).strip()

        script = f'''
        tell application "Things3"
            set newTask to make new to do with properties {{name: "{task_title}"}}
        end tell
        '''

        result = self._run_applescript(script)
        if "Error" in result:
            return f"Failed to add task: {result}"

        return f"Added task: '{task_title}'"

    def complete_task(self, command: str) -> str:
        search_match = re.search(
            r"(?:complete|finish|done)\s+(?:task)?\s+(.+)", command, re.IGNORECASE
        )
        if not search_match:
            return "Couldn't understand. Try: 'complete task buy milk'"

        search_term = search_match.group(1).strip()

        script = f'''
        tell application "Things3"
            set todosToFind to to dos whose name contains "{search_term}"
            if (count of todosToFind) > 0 then
                set firstTodo to item 1 of todosToFind
                set completed of firstTodo to true
                return name of firstTodo
            else
                return "NOT_FOUND"
            end if
        end tell
        '''

        result = self._run_applescript(script)
        if result == "NOT_FOUND":
            return f"No task found matching '{search_term}'"
        if "Error" in result:
            return f"Failed: {result}"

        return f"Completed: '{result}'"

    def list_tasks(self, command: str) -> str:
        script = """
        tell application "Things3"
            set output to ""
            set todoList to to dos
            repeat with i from 1 to count of todoList
                set todoItem to item i of todoList
                if completed of todoItem is false then
                    set output to output & name of todoItem & "\n"
                end if
            end repeat
            return output
        end tell
        """

        result = self._run_applescript(script)
        if not result or result == "":
            return "No tasks found."

        tasks = result.split("\n")
        return "Your tasks:\n" + "\n".join(f"  • {t}" for t in tasks if t)
