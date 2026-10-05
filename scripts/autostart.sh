#!/bin/zsh
# Install / remove the background service that keeps PnL Terminal running (and recording
# history) whenever you're logged in.
#   ./scripts/autostart.sh install    start now + at every login, restart if it crashes
#   ./scripts/autostart.sh uninstall  stop it and remove it
#   ./scripts/autostart.sh restart    pick up code/.env/accounts.json changes
#   ./scripts/autostart.sh logs       tail the server log
set -e
LABEL=com.pnlterminal.server
PLIST=~/Library/LaunchAgents/$LABEL.plist
DIR=${0:A:h:h}
NODE=$(command -v node)

case "$1" in
  install)
    mkdir -p "$DIR/data"
    cat > $PLIST <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--no-warnings</string><string>--env-file-if-exists=.env</string><string>server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/server.log</string>
</dict></plist>
PL
    launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
    launchctl bootstrap gui/$(id -u) $PLIST
    echo "Installed. Dashboard: http://localhost:4200"
    ;;
  uninstall)
    launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
    rm -f $PLIST
    echo "Removed."
    ;;
  restart)
    launchctl kickstart -k gui/$(id -u)/$LABEL
    echo "Restarted."
    ;;
  logs)
    tail -f "$DIR/data/server.log"
    ;;
  *)
    echo "usage: $0 install|uninstall|restart|logs"; exit 1;;
esac
