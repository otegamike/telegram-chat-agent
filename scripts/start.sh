#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

SESSION="agent"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed. Run: pkg install tmux"
  exit 1
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already running."
  exec tmux attach -t "$SESSION"
fi

tmux new-session -d -s "$SESSION" -n agent "npm start"
tmux split-window -t "$SESSION" -h "npm run admin"
tmux select-pane -t "$SESSION".0

echo "Started service + admin UI in tmux session '$SESSION'."
echo "  logs:    tmux attach -t $SESSION   (detach: Ctrl-b d)"
echo "  reload:  tmux kill-session -t $SESSION && bash scripts/start.sh"
echo "  stop:    bash scripts/stop.sh"