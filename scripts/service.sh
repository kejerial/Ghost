#!/bin/zsh
# Run Ghost in the background as a macOS login item (launchd LaunchAgent).
#   scripts/service.sh install    start now, at every login, and after a crash
#   scripts/service.sh uninstall  stop and remove the login item
#   scripts/service.sh restart    restart after a code or .env change
#   scripts/service.sh logs       follow the log
set -euo pipefail

LABEL="com.kejerial.ghost"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$DIR/data/ghost.log"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
    # launchd starts with a minimal PATH. Save this shell's PATH so Ghost finds node, codex, and claude.
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/node_modules/.bin/tsx</string>
    <string>--env-file-if-exists=.env</string>
    <string>src/index.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>90</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout returns before the old process exits (Ghost drains in-flight work first). Wait for it.
    for _ in {1..90}; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Ghost is running in the background. Log: $LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Ghost login item removed."
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Ghost restarted."
    ;;
  logs)
    tail -n 50 -f "$LOG"
    ;;
  *)
    echo "Usage: scripts/service.sh install|uninstall|restart|logs" >&2
    exit 2
    ;;
esac
