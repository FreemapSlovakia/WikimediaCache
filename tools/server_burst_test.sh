#!/bin/bash
# Run this on cloud01 from /opt/WikiMediaCache
set -e
TOKEN=$(grep WIKIMEDIA_ACCESS_TOKEN .env | cut -d'=' -f2- | tr -d '"')
UA="FreemapCacheBot/1.0 (https://freemap.sk; freemap@freemap.sk)"

echo "Token length: ${#TOKEN}"
echo "Fetching 25 random commons file titles..."
TITLES=$(curl -s "https://commons.wikimedia.org/w/api.php?action=query&list=random&rnnamespace=6&rnlimit=25&format=json" | python3 -c "
import json,sys
data = json.load(sys.stdin)
for p in data['query']['random']:
    print(p['title'])
")

echo "Resolving thumb URLs and bursting downloads WITH Authorization header..."
echo "$TITLES" | while read -r title; do
  ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$title")
  API_URL="https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&iiurlwidth=120&titles=$ENC&format=json"
  THUMB=$(curl -s -H "Authorization: Bearer $TOKEN" -H "User-Agent: $UA" "$API_URL" | python3 -c "
import json,sys
data = json.load(sys.stdin)
pages = data.get('query',{}).get('pages',{})
for pid,p in pages.items():
    if 'imageinfo' in p:
        print(p['imageinfo'][0]['thumburl'])
" 2>/dev/null)
  if [ -n "$THUMB" ]; then
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" -H "User-Agent: $UA" "$THUMB")
    echo "$CODE  $THUMB"
  fi
done
