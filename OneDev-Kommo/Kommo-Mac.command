#!/bin/bash
# One Development: Kommo для Claude — Mac. Двойной щелчок или «bash Kommo-Mac.command auto» (без ожидания Enter).
# Node.js не обязателен: если подходящего (20+) нет, скачивается официальный (nodejs.org, сверка SHA-256)
# в ~/.onedev-kommo/node.
cd "$(dirname "$0")" || exit 1
VER=v24.21.0
ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }
NODE=""
for c in "$HOME/.onedev-kommo/node/bin/node" "$HOME/.onedev-connector/node/bin/node" "$(command -v node)" /usr/local/bin/node /opt/homebrew/bin/node; do
  [ -z "$NODE" ] && ok "$c" && NODE="$c"
done
if [ -z "$NODE" ]; then
  if [ "$(uname -m)" = "arm64" ]; then ARCH=arm64; SUM=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057
  else ARCH=x64; SUM=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097; fi
  NAME="node-${VER}-darwin-${ARCH}"
  TMP="$(mktemp -d)"
  echo "Скачиваю Node.js (${NAME})…"
  curl -fsSL -o "${TMP}/${NAME}.tar.gz" "https://nodejs.org/dist/${VER}/${NAME}.tar.gz" || { echo "Не удалось скачать Node.js"; exit 1; }
  [ "$(shasum -a 256 "${TMP}/${NAME}.tar.gz" | cut -d' ' -f1)" = "$SUM" ] || { echo "Контрольная сумма Node.js не совпала"; exit 1; }
  mkdir -p "$HOME/.onedev-kommo/node/bin"
  tar -xzf "${TMP}/${NAME}.tar.gz" -C "$TMP" "${NAME}/bin/node" && mv "${TMP}/${NAME}/bin/node" "$HOME/.onedev-kommo/node/bin/node"
  rm -r "$TMP"
  NODE="$HOME/.onedev-kommo/node/bin/node"
fi
"$NODE" payload/install.mjs
RC=$?
[ "$1" != "auto" ] && [ -t 0 ] && read -r -p "Нажмите Enter, чтобы закрыть окно…" _
exit $RC
