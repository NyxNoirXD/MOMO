#!/usr/bin/env bash
# Sanity-check both upstream APIs without WhatsApp: AniList search and nekostream links.
set -euo pipefail

echo "== AniList search: 'one piece' =="
curl -sS -X POST "https://graphql.anilist.co" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"query":"query($s:String){Page(page:1,perPage:2){media(search:$s,type:ANIME){id idMal title{romaji} format}}}","variables":{"s":"one piece"}}' \
  | python3 -m json.tool

echo
echo "== nekostream: MAL 61316 episode 1 =="
curl -sS --compressed "https://mapper.nekostream.site/api/mal/61316/1/$(date +%s)" | python3 -m json.tool