#!/bin/bash
# One Development: добавить Kommo в коннектор — Mac. Почту и папку ai-office не трогает.
cd "$(dirname "$0")" || exit 1
NODE="$HOME/.onedev-connector/node/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
for c in /usr/local/bin/node /opt/homebrew/bin/node; do [ -z "$NODE" ] && [ -x "$c" ] && NODE="$c"; done
if [ -z "$NODE" ]; then
  echo "Node.js не найден — значит, основной коннектор One Development не установлен. Напишите Дмитрию."
else
  "$NODE" payload/add-kommo.mjs
fi
[ -t 0 ] && read -r -p "Нажмите Enter, чтобы закрыть окно…" _
exit 0
