#!/usr/bin/env bash
# Fetch upstream AI rule sources listed in rules/AI.list SOURCES for manual/AI merge.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/.cache/ai-sources"
mkdir -p "$OUT"
urls=(
  "https://raw.githubusercontent.com/Tartarus2014/Loon-Script/master/Rule/Other/AI.lsr"
  "https://ruleset.skk.moe/List/non_ip/ai.conf"
  "https://raw.githubusercontent.com/SukkaW/Surge/master/List/non_ip/ai.conf"
  "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Loon/OpenAI/OpenAI.list"
  "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Loon/Claude/Claude.list"
  "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Loon/Gemini/Gemini.list"
  "https://raw.githubusercontent.com/xpdigital/Apple-Rule/main/Apple-AI.list"
)
for u in "${urls[@]}"; do
  f="$OUT/$(echo "$u" | sed 's#https\?://##;s#[/:]#_#g')"
  echo "GET $u"
  curl -fsSL --max-time 30 "$u" -o "$f" || echo "FAIL $u" >&2
done
echo "Saved under $OUT"
ls -la "$OUT"
