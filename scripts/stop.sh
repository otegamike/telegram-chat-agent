#!/usr/bin/env bash
set -u
SESSION="agent"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "Stopped session '$SESSION'."
else
  echo "No session '$SESSION' running."
fi

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock
fi