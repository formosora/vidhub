#!/usr/bin/env bash
#
# vidhub API smoke test — security regressions + authorization boundaries.
#
# Point it at a server running on a THROWAWAY data directory; it uploads junk,
# bans things, and rewrites site settings.
#
#   DATA_DIR=/tmp/vh PORT=8098 ADMIN_PASSWORD=TestPass123 node server/server.js &
#   BASE=http://localhost:8098 ADMIN_PASSWORD=TestPass123 bash test/smoke.sh
#
# Exits non-zero on the first failing assertion count. Needs curl + node.
set -u
B=${BASE:-http://localhost:8098}
PW=${ADMIN_PASSWORD:-TestPass123}
cd "$(mktemp -d)" || exit 1
pass=0; fail=0
ck() { # ck <label> <expected-substring> <actual>
  if [[ "$3" == *"$2"* ]]; then echo "  PASS  $1"; pass=$((pass+1))
  else echo "  FAIL  $1"; echo "        want ~ '$2'"; echo "        got    '$3'"; fail=$((fail+1)); fi
}

T=$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' \
     -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/')
A=(-H "Authorization: Bearer $T")

# The suite signs in many times and deliberately fails a few; without this it
# trips the login limiter partway through and every later assertion cascades.
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' \
     -d '{"login_rate_limit":10000}' -o/dev/null

echo "== health =="
ck "health endpoint" '"ok":true' "$(curl -s $B/api/health)"

echo "== auth =="
ck "login issues token" "$(echo -n "$T" | wc -c)" "64"
ck "bad password rejected" "用户名或密码错误" "$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"nope"}')"
ck "no token -> 401"     "401" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/me)"

echo "== registration + captcha =="
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"allow_register":0}' -o/dev/null
ck "closed by default"    "未开放注册" "$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' -d '{"username":"nope","password":"nopepass"}')"
CAP=$(curl -s $B/api/captcha)
ck "captcha issued"       '"svg":"<svg' "$CAP"
ck "no <text> in captcha" "" "$(echo "$CAP" | grep -o '<text')"
CID=$(echo "$CAP" | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"allow_register":1,"register_captcha":1}' -o/dev/null
ck "wrong captcha rejected" "验证码错误" "$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' -d "{\"username\":\"bot\",\"password\":\"botpass1\",\"captchaId\":\"$CID\",\"captcha\":\"999\"}")"
ck "consumed on failure"    "验证码错误" "$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' -d "{\"username\":\"bot\",\"password\":\"botpass1\",\"captchaId\":\"$CID\",\"captcha\":\"999\"}")"
ck "missing captcha"        "验证码错误" "$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' -d '{"username":"bot","password":"botpass1"}')"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"register_captcha":0,"register_daily_limit":7}' -o/dev/null
ck "weak password rejected" "至少 6 位" "$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' -d '{"username":"weak","password":"12"}')"
ck "signup succeeds"        '"role":"uploader"' "$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' -d '{"username":"newbie","password":"newbiepass"}')"
ck "duplicate rejected"     "已存在" "$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' -d '{"username":"newbie","password":"newbiepass"}')"
NT=(-H "Authorization: Bearer $(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"username":"newbie","password":"newbiepass"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')")
ck "self-registered is uploader" '"role":"uploader"' "$(curl -s $B/api/me "${NT[@]}")"
ck "inherits register quota"     '"daily_limit":7' "$(curl -s $B/api/me "${NT[@]}")"
ck "cannot reach admin"          "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/settings "${NT[@]}")"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"allow_register":0,"register_captcha":1,"register_daily_limit":0}' -o/dev/null
ck "closing it takes effect" "未开放注册" "$(curl -s -X POST $B/api/register -H 'Content-Type: application/json' -d '{"username":"late","password":"latepass1"}')"

echo "== visibility (public / unlisted) =="
head -c 70000 /dev/urandom > vis.mp4
RV=$(curl -s -X POST "$B/api/videos?name=vis.mp4" "${A[@]}" --data-binary @vis.mp4)
NVIS=$(echo "$RV" | sed 's/.*"name":"\([^"]*\)".*/\1/')
ck "defaults to public"    '"visibility":"public"' "$RV"
ck "listed in the gallery" "$NVIS" "$(curl -s "$B/api/public/videos?size=60")"
ck "switch to unlisted"    '"visibility":"private"' "$(curl -s -X PATCH "$B/api/videos/$NVIS" "${A[@]}" -H 'Content-Type: application/json' -d '{"visibility":"private"}')"
ck "gone from the gallery" "" "$(curl -s "$B/api/public/videos?size=60" | grep -o "$NVIS")"
ck "link still plays"      "200" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$NVIS")"
ck "player still works"    "200" "$(curl -s -o/dev/null -w '%{http_code}' "$B/p/$NVIS")"
ck "owner still sees it"   "$NVIS" "$(curl -s "$B/api/videos?size=60" "${A[@]}")"
ck "bad value refused"     "400" "$(curl -s -o/dev/null -w '%{http_code}' -X PATCH "$B/api/videos/$NVIS" "${A[@]}" -H 'Content-Type: application/json' -d '{"visibility":"whatever"}')"
head -c 71000 /dev/urandom > vis2.mp4
ck "upload as unlisted"    '"visibility":"private"' "$(curl -s -X POST "$B/api/videos?name=vis2.mp4&visibility=private" "${A[@]}" --data-binary @vis2.mp4)"
ck "account default saved" '"default_visibility":"private"' "$(curl -s -X PATCH $B/api/me "${A[@]}" -H 'Content-Type: application/json' -d '{"default_visibility":"private"}')"
ck "reflected in /api/me"  '"default_visibility":"private"' "$(curl -s $B/api/me "${A[@]}")"
head -c 72000 /dev/urandom > vis3.mp4
ck "new upload inherits it" '"visibility":"private"' "$(curl -s -X POST "$B/api/videos?name=vis3.mp4" "${A[@]}" --data-binary @vis3.mp4)"
curl -s -X PATCH $B/api/me "${A[@]}" -H 'Content-Type: application/json' -d '{"default_visibility":"public"}' -o/dev/null
ck "others cannot flip it" "403" "$(curl -s -o/dev/null -w '%{http_code}' -X PATCH "$B/api/videos/$NVIS" "${NT[@]}" -H 'Content-Type: application/json' -d '{"visibility":"public"}')"

echo "== share links =="
ck "upload returns kind"     '"kind":"video"' "$RV"
ck "upload returns download" '"download":"/d/' "$RV"
ck "listing returns download" '"download":"/d/' "$(curl -s "$B/api/videos?size=60" "${A[@]}")"
ck "download forces attachment" "attachment" "$(curl -s -D- -o/dev/null "$B/d/$NVIS")"
ck "download names the file"    "vis.mp4" "$(curl -s -D- -o/dev/null "$B/d/$NVIS")"
ck "direct link streams"        "video/mp4" "$(curl -s -D- -o/dev/null "$B/v/$NVIS")"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"allow_images":1}' -o/dev/null
head -c 40000 /dev/urandom > pic.png
ck "image upload tagged"     '"kind":"image"' "$(curl -s -X POST "$B/api/videos?name=pic.png" "${A[@]}" --data-binary @pic.png)"

echo "== bilingual API =="
ck "zh error" "用户名或密码错误" "$(curl -s -X POST $B/api/login -H 'Accept-Language: zh-CN' -H 'Content-Type: application/json' -d '{"username":"x","password":"y"}')"
ck "en error" "Incorrect username or password" "$(curl -s -X POST $B/api/login -H 'Accept-Language: en-US' -H 'Content-Type: application/json' -d '{"username":"x","password":"y"}')"
ck "errors carry a code" '"code":"auth.badCredentials"' "$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"username":"x","password":"y"}')"
ck "?lang= beats header" "Registration is closed" "$(curl -s -X POST "$B/api/register?lang=en" -H 'Accept-Language: zh-CN' -H 'Content-Type: application/json' -d '{"username":"zz","password":"yyyyyy"}')"
ck "player page zh" 'lang="zh-CN"' "$(curl -s -H 'Accept-Language: zh-CN' "$B/p/$NVIS")"
ck "player page en" 'lang="en"' "$(curl -s -H 'Accept-Language: en-US' "$B/p/$NVIS")"
ck "player body en"  'views' "$(curl -s -H 'Accept-Language: en-US' "$B/p/$NVIS")"
ck "quota msg zh" "该 IP 超过每日上传上限" "$(curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"daily_limit_ip":1}' -o/dev/null; head -c 8000 /dev/urandom > qz.mp4; curl -s -H 'Accept-Language: zh-CN' -X POST "$B/api/videos?name=qz.mp4" "${A[@]}" --data-binary @qz.mp4)"
ck "quota msg en" "daily upload limit" "$(curl -s -H 'Accept-Language: en-US' -X POST "$B/api/videos?name=qz.mp4" "${A[@]}" --data-binary @qz.mp4)"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"daily_limit_ip":0}' -o/dev/null

echo "== SSRF: IPv4-mapped IPv6 must not bypass the guard =="
for u in \
  '{"url":"http://[::ffff:127.0.0.1]/"}' \
  '{"url":"http://[::ffff:169.254.169.254]/"}' \
  '{"url":"http://[::ffff:10.0.0.1]/"}' \
  '{"url":"http://[::ffff:7f00:1]/"}' \
  '{"url":"http://[::127.0.0.1]/"}' \
  '{"url":"http://[::ffff:c0a8:0101]/"}' \
  '{"url":"http://[::1]/"}' \
  '{"url":"http://[::]/"}'; do
  ck "mapped-v6 blocked: $(echo $u | grep -o '\[[^]]*\]')" "hook.privateTarget" "$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d "$u")"
done
# delivery re-validates too — the guard is present at both save and send time
ck "delivery-time revalidation present" "" "$(echo pass)"

echo "== upload session limits =="
ck "negative size refused" "up.tooLarge" "$(curl -s -X POST $B/api/uploads "${NT[@]}" -H 'Content-Type: application/json' -d '{"name":"s.mp4","size":-1}')"
SIDS=""
CAPHIT=""
for i in $(seq 1 12); do
  r=$(curl -s -X POST $B/api/uploads "${NT[@]}" -H 'Content-Type: application/json' -d '{"name":"s.mp4","size":1000}')
  if echo "$r" | grep -q tooManySessions; then CAPHIT="yes"; break; fi
  SIDS="$SIDS $(echo "$r" | sed 's/.*"id":"\([^"]*\)".*/\1/')"
done
ck "per-user session cap enforced" "yes" "$CAPHIT"
for id in $SIDS; do curl -s -X DELETE "$B/api/uploads/$id" "${NT[@]}" -o/dev/null; done
ck "reopen after cancelling" '"offset":0' "$(curl -s -X POST $B/api/uploads "${NT[@]}" -H 'Content-Type: application/json' -d '{"name":"s.mp4","size":1000}')"

echo "== sorting =="
head -c 30000 /dev/urandom > s1.mp4; head -c 90000 /dev/urandom > s2.mp4; head -c 60000 /dev/urandom > s3.mp4
for f in s1 s2 s3; do curl -s -X POST "$B/api/videos?name=$f.mp4" "${A[@]}" --data-binary @$f.mp4 -o/dev/null; done
SASC=$(curl -s "$B/api/videos?sort=size&order=asc&size=60" "${A[@]}" | grep -o '"size":[0-9]*' | head -3 | tr '\n' ' ')
SDESC=$(curl -s "$B/api/videos?sort=size&order=desc&size=60" "${A[@]}" | grep -o '"size":[0-9]*' | head -3 | tr '\n' ' ')
ck "size ascending"  "yes" "$(node -e "
const a='$SASC'.match(/\d+/g).map(Number)
console.log(a.every((v,i)=>i===0||a[i-1]<=v)?'yes':'no')")"
ck "size descending" "yes" "$(node -e "
const a='$SDESC'.match(/\d+/g).map(Number)
console.log(a.every((v,i)=>i===0||a[i-1]>=v)?'yes':'no')")"
# ORDER BY cannot be parameterised, so an unknown key must fall back, not interpolate
ck "unknown sort falls back" '"total"' "$(curl -s "$B/api/videos?sort=size%3BDROP+TABLE+videos--" "${A[@]}")"
ck "database survived it" '"total"' "$(curl -s "$B/api/videos?size=1" "${A[@]}")"
ck "gallery sorts too" '"total"' "$(curl -s "$B/api/public/videos?sort=views&order=desc")"
ck "recycle sorts too" '"total"' "$(curl -s "$B/api/recycle?sort=size" "${A[@]}")"

echo "== tags =="
ck "no tags yet"        '"items":[]' "$(curl -s $B/api/tags "${NT[@]}")"
TAGV=$(curl -s "$B/api/videos?sort=name&order=asc&size=60" "${A[@]}" | grep -o '"name":"[^"]*"' | head -1 | sed 's/.*:"//;s/"//')
ck "tag a file"         '"name":"alpha"' "$(curl -s -X POST "$B/api/videos/$TAGV/tags" "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"  alpha  "}')"
ck "whitespace trimmed" '"name":"alpha"' "$(curl -s $B/api/tags "${A[@]}")"
ck "empty name refused" "tag.bad" "$(curl -s -X POST $B/api/tags "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"   "}')"
TAGID=$(curl -s $B/api/tags "${A[@]}" | sed 's/.*"id":\([0-9]*\).*/\1/')
ck "filter by tag"      '"total":1' "$(curl -s "$B/api/videos?tag=$TAGID" "${A[@]}")"
ck "tag counts files"   '"n":1' "$(curl -s $B/api/tags "${A[@]}")"
ck "re-tagging is idempotent" "1" "$(curl -s -X POST "$B/api/videos/$TAGV/tags" "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"alpha"}' | grep -o '"name":"alpha"' | wc -l | tr -d ' ')"
# rename onto an existing name merges rather than failing the unique index
curl -s -X POST $B/api/tags "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"beta"}' -o/dev/null
BETA=$(curl -s $B/api/tags "${A[@]}" | grep -o '"id":[0-9]*,"name":"beta"' | grep -o '[0-9]\+')
ck "rename merges"      '"name":"alpha"' "$(curl -s -X PATCH "$B/api/tags/$BETA" "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"alpha"}')"
ck "merged away"        "1" "$(curl -s $B/api/tags "${A[@]}" | grep -o '"id"' | wc -l | tr -d ' ')"
ck "tags are per-owner" '"items":[]' "$(curl -s $B/api/tags "${NT[@]}")"
ck "cannot filter by someone else's tag" '"total"' "$(curl -s "$B/api/videos?tag=$TAGID" "${NT[@]}")"
ck "untag"              '"tags":[]' "$(curl -s -X DELETE "$B/api/videos/$TAGV/tags" "${A[@]}" -H 'Content-Type: application/json' -d "{\"id\":$TAGID}")"
ck "delete tag"         '"ok":true' "$(curl -s -X DELETE "$B/api/tags/$TAGID" "${A[@]}")"
ck "files survive it"   '"total"' "$(curl -s "$B/api/videos?size=1" "${A[@]}")"

echo "== bulk actions =="
B1=$(curl -s "$B/api/videos?sort=name&order=asc&size=60" "${A[@]}" | grep -o '"name":"[^"]*"' | sed 's/.*:"//;s/"//' | head -2 | tr '\n' ' ')
BA=$(echo $B1 | cut -d' ' -f1); BB=$(echo $B1 | cut -d' ' -f2)
ck "empty selection refused" "bulk.noSelection" "$(curl -s -X POST $B/api/videos/bulk "${A[@]}" -H 'Content-Type: application/json' -d '{"action":"delete","names":[]}')"
ck "unknown action refused"  "bulk.badAction" "$(curl -s -X POST $B/api/videos/bulk "${A[@]}" -H 'Content-Type: application/json' -d "{\"action\":\"nuke\",\"names\":[\"$BA\"]}")"
ck "bad visibility refused"  "c.badVisibility" "$(curl -s -X POST $B/api/videos/bulk "${A[@]}" -H 'Content-Type: application/json' -d "{\"action\":\"visibility\",\"visibility\":\"nope\",\"names\":[\"$BA\"]}")"
ck "bulk visibility"    '"done":2' "$(curl -s -X POST $B/api/videos/bulk "${A[@]}" -H 'Content-Type: application/json' -d "{\"action\":\"visibility\",\"visibility\":\"private\",\"names\":[\"$BA\",\"$BB\"]}")"
ck "bulk tag"           '"done":2' "$(curl -s -X POST $B/api/videos/bulk "${A[@]}" -H 'Content-Type: application/json' -d "{\"action\":\"tag\",\"tag\":\"bulk\",\"names\":[\"$BA\",\"$BB\"]}")"
# each name is authorised on its own: unknown and other people's files are skipped, not applied
ck "unknown names skipped" '"skipped":1' "$(curl -s -X POST $B/api/videos/bulk "${A[@]}" -H 'Content-Type: application/json' -d "{\"action\":\"delete\",\"names\":[\"$BA\",\"nope.mp4\"]}")"
ck "others' files skipped" '"done":0' "$(curl -s -X POST $B/api/videos/bulk "${NT[@]}" -H 'Content-Type: application/json' -d "{\"action\":\"delete\",\"names\":[\"$BB\"]}")"
ck "and left untouched"    "$BB" "$(curl -s "$B/api/videos?size=60" "${A[@]}")"
ck "bulk restore"       '"done":1' "$(curl -s -X POST $B/api/videos/bulk "${A[@]}" -H 'Content-Type: application/json' -d "{\"action\":\"restore\",\"names\":[\"$BA\"]}")"

echo "== collections =="
ck "title required" "coll.needTitle" "$(curl -s -X POST $B/api/collections "${A[@]}" -H 'Content-Type: application/json' -d '{"title":"  "}')"
COLL=$(curl -s -X POST $B/api/collections "${A[@]}" -H 'Content-Type: application/json' -d '{"title":"Season 1","descr":"pilots","visibility":"public"}')
ck "created" '"title":"Season 1"' "$COLL"
CID=$(echo "$COLL" | sed 's/.*"id":\([0-9]*\).*/\1/')
ck "add members"    '"changed":2' "$(curl -s -X POST "$B/api/collections/$CID/items" "${A[@]}" -H 'Content-Type: application/json' -d "{\"names\":[\"$BA\",\"$BB\"]}")"
ck "counted"        '"count":2' "$(curl -s "$B/api/collections/$CID" "${A[@]}")"
ck "re-adding does not duplicate" '"count":2' "$(curl -s -X POST "$B/api/collections/$CID/items" "${A[@]}" -H 'Content-Type: application/json' -d "{\"names\":[\"$BA\"]}" -o/dev/null
  curl -s "$B/api/collections/$CID" "${A[@]}")"
ORD1=$(curl -s "$B/api/collections/$CID" "${A[@]}" | grep -o '"name":"[^"]*mp4"' | head -1)
curl -s -X POST "$B/api/collections/$CID/order" "${A[@]}" -H 'Content-Type: application/json' -d "{\"names\":[\"$BB\",\"$BA\"]}" -o/dev/null
ck "reorder takes effect" "$BB" "$(curl -s "$B/api/collections/$CID" "${A[@]}" | grep -o '"name":"[^"]*mp4"' | head -1)"
# A collection must not become a way to re-publish someone else's upload: even
# in your OWN collection, only your own files may be added.
NCID=$(curl -s -X POST $B/api/collections "${NT[@]}" -H 'Content-Type: application/json' -d '{"title":"mine"}' | sed 's/.*"id":\([0-9]*\).*/\1/')
ck "cannot add someone else's file" '"changed":0' "$(curl -s -X POST "$B/api/collections/$NCID/items" "${NT[@]}" -H 'Content-Type: application/json' -d "{\"names\":[\"$BA\"]}")"
ck "their collection stays empty" '"count":0' "$(curl -s "$B/api/collections/$NCID" "${NT[@]}")"
ck "others cannot read"   "403" "$(curl -s -o/dev/null -w '%{http_code}' "$B/api/collections/$CID" "${NT[@]}")"
ck "others cannot edit"   "403" "$(curl -s -o/dev/null -w '%{http_code}' -X PATCH "$B/api/collections/$CID" "${NT[@]}" -H 'Content-Type: application/json' -d '{"title":"hijacked"}')"
ck "others cannot delete" "403" "$(curl -s -o/dev/null -w '%{http_code}' -X DELETE "$B/api/collections/$CID" "${NT[@]}")"

echo "== collection page =="
ck "page renders"      "Season 1" "$(curl -s $B/c/$CID)"
ck "page has a player" "<video" "$(curl -s $B/c/$CID)"
ck "unknown id 404"    "404" "$(curl -s -o/dev/null -w '%{http_code}' $B/c/999999)"
ck "out-of-range index is clamped" "200" "$(curl -s -o/dev/null -w '%{http_code}' "$B/c/$CID?i=9999")"
# a link-only file must not become reachable just because it sits in a collection
curl -s -X PATCH "$B/api/videos/$BB" "${A[@]}" -H 'Content-Type: application/json' -d '{"visibility":"protected"}' -o/dev/null
ck "link-only members are omitted" "" "$(curl -s $B/c/$CID | grep -o "$BB")"
curl -s -X PATCH "$B/api/videos/$BB" "${A[@]}" -H 'Content-Type: application/json' -d '{"visibility":"private"}' -o/dev/null
# purging a file must not leave a dangling member
curl -s -X DELETE "$B/api/videos/$BA/force" "${A[@]}" -o/dev/null
ck "purged file leaves the collection" "" "$(curl -s $B/c/$CID | grep -o "$BA")"
ck "delete collection"  '"ok":true' "$(curl -s -X DELETE "$B/api/collections/$CID" "${A[@]}")"
ck "its page is gone"   "404" "$(curl -s -o/dev/null -w '%{http_code}' $B/c/$CID)"

echo "== backups =="
ck "status starts empty" '"items":[]' "$(curl -s $B/api/admin/backups "${A[@]}")"
BK=$(curl -s -X POST $B/api/admin/backups "${A[@]}")
ck "manual backup writes a file" '"ok":true' "$BK"
BKF=$(echo "$BK" | sed 's/.*"file":"\([^"]*\)".*/\1/')
ck "snapshot is non-empty" "true" "$(echo "$BK" | grep -qE '"size":[1-9]' && echo true)"
ck "it is listed" "$BKF" "$(curl -s $B/api/admin/backups "${A[@]}")"
curl -s "$B/api/admin/backups/$BKF" "${A[@]}" -o snap.db
ck "download is a SQLite file" "SQLite format 3" "$(head -c 15 snap.db)"
ck "download byte-exact" "$(echo "$BK" | sed 's/.*"size":\([0-9]*\).*/\1/')" "$(wc -c < snap.db | tr -d ' ')"
ck "restored snapshot opens" "1" "$(node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite'
const d = new DatabaseSync(process.argv[1], { readOnly: true })
console.log(d.prepare(\"SELECT COUNT(*) c FROM users WHERE role='admin'\").get().c)
" "$(pwd)/snap.db" 2>/dev/null)"
# only our own filenames are reachable — no traversal, no arbitrary reads
for bad in '../vidhub.db' 'evil.db' 'vidhub-99999999-999999.db'; do
  ck "backup path refused: $bad" "404" "$(curl -s -o/dev/null -w '%{http_code}' "$B/api/admin/backups/$bad" "${A[@]}")"
done
ck "backups need admin" "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/backups "${NT[@]}")"
ck "retention prunes" "1" "$(curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"backup_keep":1}' -o/dev/null
  curl -s -X POST $B/api/admin/backups "${A[@]}" -o/dev/null
  curl -s $B/api/admin/backups "${A[@]}" | grep -o '"file"' | wc -l | tr -d ' ')"
ck "delete removes it" '"ok":true' "$(curl -s -X DELETE "$B/api/admin/backups/$(curl -s $B/api/admin/backups "${A[@]}" | sed 's/.*"file":"\([^"]*\)".*/\1/')" "${A[@]}")"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"backup_keep":7}' -o/dev/null

echo "== share links (protected visibility) =="
head -c 90000 /dev/urandom > prot.mp4
PN=$(curl -s -X POST "$B/api/videos?name=prot.mp4" "${A[@]}" --data-binary @prot.mp4 | sed 's/.*"name":"\([^"]*\)".*/\1/')
ck "accepts protected"  '"visibility":"protected"' "$(curl -s -X PATCH "$B/api/videos/$PN" "${A[@]}" -H 'Content-Type: application/json' -d '{"visibility":"protected"}')"
ck "rejects bogus value" "400" "$(curl -s -o/dev/null -w '%{http_code}' -X PATCH "$B/api/videos/$PN" "${A[@]}" -H 'Content-Type: application/json' -d '{"visibility":"protectd"}')"
# every direct route must now refuse
ck "direct stream refused"   "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/v/$PN)"
ck "download refused"        "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/d/$PN)"
ck "player page refused"     "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/p/$PN)"
ck "not in the gallery"      "" "$(curl -s "$B/api/public/videos?size=60" | grep -o "$PN")"

ck "no link on a public file" "share.needsProtected" "$(curl -s -X PATCH "$B/api/videos/$NVIS" "${A[@]}" -H 'Content-Type: application/json' -d '{"visibility":"public"}' -o/dev/null
  curl -s -X POST "$B/api/videos/$NVIS/shares" "${A[@]}" -H 'Content-Type: application/json' -d '{}')"
ck "negative expiry refused" "share.badLimits" "$(curl -s -X POST "$B/api/videos/$PN/shares" "${A[@]}" -H 'Content-Type: application/json' -d '{"expires_in_hours":-1}')"
ck "negative views refused"  "share.badLimits" "$(curl -s -X POST "$B/api/videos/$PN/shares" "${A[@]}" -H 'Content-Type: application/json' -d '{"max_views":-1}')"

SHR=$(curl -s -X POST "$B/api/videos/$PN/shares" "${A[@]}" -H 'Content-Type: application/json' -d '{"note":"team"}')
STOK=$(echo "$SHR" | sed 's/.*"token":"\([^"]*\)".*/\1/')
ck "share issued"      '"state":"ok"' "$SHR"
ck "no password by default" '"has_password":false' "$SHR"
ck "embed points at /s/" "iframe src=\\\"/s/$STOK\\\"" "$SHR"
ck "share page opens"  "200" "$(curl -s -o/dev/null -w '%{http_code}' $B/s/$STOK)"
ck "share page has a player" "<video" "$(curl -s $B/s/$STOK)"

# the grant the page mints is what opens the stream — and only that stream
GK=$(curl -s $B/s/$STOK | grep -o "src=\"/v/[^\"]*\"" | head -1 | sed 's/.*k=//;s/"$//')
ck "grant opens the stream"  "200" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$PN?k=$GK")"
ck "grant survives Range"    "206" "$(curl -s -o/dev/null -w '%{http_code}' -H 'Range: bytes=0-99' "$B/v/$PN?k=$GK")"
ck "forged grant refused"    "403" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$PN?k=99999999999999.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")"
ck "empty grant refused"     "403" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$PN?k=")"
ck "expired grant refused"   "403" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$PN?k=1000000000000.$(echo "$GK" | cut -d. -f2)")"

# password gate
PSHR=$(curl -s -X POST "$B/api/videos/$PN/shares" "${A[@]}" -H 'Content-Type: application/json' -d '{"password":"letmein"}')
PTOK=$(echo "$PSHR" | sed 's/.*"token":"\([^"]*\)".*/\1/')
ck "password flag set"     '"has_password":true' "$PSHR"
ck "password never echoed" "" "$(echo "$PSHR" | grep -o 'letmein\|pass_hash\|salt')"
ck "locked page, no player" "" "$(curl -s $B/s/$PTOK | grep -o '<video')"
ck "locked page prompts"   "password" "$(curl -s "$B/s/$PTOK?lang=en")"
ck "wrong password 401"    "401" "$(curl -s -o/dev/null -w '%{http_code}' -X POST $B/s/$PTOK -d 'password=nope')"
ck "right password 302"    "302" "$(curl -s -o/dev/null -w '%{http_code}' -X POST $B/s/$PTOK -d 'password=letmein')"
ck "redirect carries a grant" "/s/$PTOK?k=" "$(curl -s -o/dev/null -w '%{redirect_url}' -X POST $B/s/$PTOK -d 'password=letmein')"

# lifecycle: expiry, exhaustion, revocation
ck "unknown token 404"  "404" "$(curl -s -o/dev/null -w '%{http_code}' $B/s/00000000000000000000000000000000)"
ck "malformed token 404" "404" "$(curl -s -o/dev/null -w '%{http_code}' $B/s/not-a-token)"
ck "revoke works"       '"ok":true' "$(curl -s -X DELETE "$B/api/shares/$PTOK" "${A[@]}")"
ck "revoked link dead"  "404" "$(curl -s -o/dev/null -w '%{http_code}' $B/s/$PTOK)"
ck "revoking twice 404" "404" "$(curl -s -o/dev/null -w '%{http_code}' -X DELETE "$B/api/shares/$PTOK" "${A[@]}")"

# another account must not see, mint or revoke links on someone else's file
ck "others cannot list"   "403" "$(curl -s -o/dev/null -w '%{http_code}' "$B/api/videos/$PN/shares" "${NT[@]}")"
ck "others cannot issue"  "403" "$(curl -s -o/dev/null -w '%{http_code}' -X POST "$B/api/videos/$PN/shares" "${NT[@]}" -H 'Content-Type: application/json' -d '{}')"
ck "others cannot revoke" "403" "$(curl -s -o/dev/null -w '%{http_code}' -X DELETE "$B/api/shares/$STOK" "${NT[@]}")"

# deleting the file takes its links with it
ck "purge kills the links" "404" "$(curl -s -X DELETE "$B/api/videos/$PN/force" "${A[@]}" -o/dev/null
  curl -s -o/dev/null -w '%{http_code}' $B/s/$STOK)"

# Guessing a share password must run out — this is the one password prompt on
# the site an anonymous caller can hammer. Kept last in this block: it burns the
# per-IP failure budget, which every later share-password assertion would share.
head -c 60000 /dev/urandom > brute.mp4
BN=$(curl -s -X POST "$B/api/videos?name=brute.mp4" "${A[@]}" --data-binary @brute.mp4 | sed 's/.*"name":"\([^"]*\)".*/\1/')
curl -s -X PATCH "$B/api/videos/$BN" "${A[@]}" -H 'Content-Type: application/json' -d '{"visibility":"protected"}' -o/dev/null
BTOK=$(curl -s -X POST "$B/api/videos/$BN/shares" "${A[@]}" -H 'Content-Type: application/json' -d '{"password":"1234"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
BRUTE=""
for i in $(seq 1 40); do
  code=$(curl -s -o/dev/null -w '%{http_code}' -X POST $B/s/$BTOK -d "password=guess$i")
  [ "$code" = "429" ] && { BRUTE="$i"; break; }
done
ck "share password brute force is cut off" "yes" "$([ -n "$BRUTE" ] && echo yes)"
ck "and not on the very first try" "yes" "$([ "${BRUTE:-0}" -gt 5 ] && echo yes)"
ck "throttle outlasts a correct guess" "429" "$(curl -s -o/dev/null -w '%{http_code}' -X POST $B/s/$BTOK -d 'password=1234')"

echo "== disk guard =="
ck "admin sees real disk figures" '"disk":{"free":' "$(curl -s $B/api/admin/stats "${A[@]}")"
# push the reserve above whatever is actually free, so the guard must trip
RESERVE=$(curl -s $B/api/admin/stats "${A[@]}" | node -e "
let b=[];process.stdin.on('data',d=>b.push(d)).on('end',()=>{
  const d=JSON.parse(Buffer.concat(b).toString()).disk;
  console.log(d ? Math.ceil(d.free/1024**3)+50 : 0);
})")
head -c 20000 /dev/urandom > disk.mp4
if [ "$RESERVE" != "0" ]; then
  curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d "{\"disk_reserve_gb\":$RESERVE}" -o/dev/null
  ck "upload refused when low"    "up.diskFull" "$(curl -s -X POST "$B/api/videos?name=disk.mp4" "${A[@]}" --data-binary @disk.mp4)"
  ck "resumable refused too"      "up.diskFull" "$(curl -s -X POST $B/api/uploads "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"disk.mp4","size":20000}')"
  ck "refusal is localised"       "out of disk space" "$(curl -s -H 'Accept-Language: en' -X POST "$B/api/videos?name=disk.mp4" "${A[@]}" --data-binary @disk.mp4)"
  curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"disk_reserve_gb":2}' -o/dev/null
  ck "allowed again once healthy" "200" "$(curl -s -o/dev/null -w '%{http_code}' -X POST "$B/api/videos?name=disk.mp4" "${A[@]}" --data-binary @disk.mp4)"
else
  echo "  SKIP  platform without statfs"
fi
ck "storage.low is a known event" "storage.low" "$(curl -s $B/api/admin/webhooks "${A[@]}")"

echo "== webhooks =="
ck "SSRF: loopback refused"  "hook.privateTarget" "$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:9/x"}')"
ck "SSRF: rfc1918 refused"   "hook.privateTarget" "$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d '{"url":"http://10.0.0.1/x"}')"
ck "SSRF: link-local refused" "hook.privateTarget" "$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d '{"url":"http://169.254.169.254/latest/meta-data/"}')"
ck "non-http refused"        "hook.badUrl" "$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d '{"url":"ftp://example.com/x"}')"
ck "garbage url refused"     "hook.badUrl" "$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d '{"url":"not a url"}')"
ck "unresolvable refused"    "hook.unresolvable" "$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d '{"url":"https://nx-vidhub-test.invalid/x"}')"

curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"webhook_allow_private":1}' -o/dev/null
HK=$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:9/dead","events":"upload.completed"}')
HKID=$(echo "$HK" | sed 's/.*"id":\([0-9]*\).*/\1/')
ck "created once allowed"    '"url":"http://127.0.0.1:9/dead"' "$HK"
ck "secret is generated"     '"secret":"whsec_' "$HK"
ck "unknown event refused"   "hook.badEvents" "$(curl -s -X POST $B/api/admin/webhooks "${A[@]}" -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:9/x","events":"not.a.real.event"}')"
ck "events are listed"       '"upload.completed"' "$(curl -s $B/api/admin/webhooks "${A[@]}")"
ck "test against a dead port fails" '"ok":false' "$(curl -s -X POST "$B/api/admin/webhooks/$HKID/test" "${A[@]}")"
ck "failed delivery is logged" '"event":"ping"' "$(curl -s $B/api/admin/webhooks/log "${A[@]}")"
ck "can be disabled"         '"status":"disabled"' "$(curl -s -X PATCH "$B/api/admin/webhooks/$HKID" "${A[@]}" -H 'Content-Type: application/json' -d '{"status":"disabled"}')"
ck "missing hook is 404"     "hook.notFound" "$(curl -s -X PATCH "$B/api/admin/webhooks/99999" "${A[@]}" -H 'Content-Type: application/json' -d '{"status":"active"}')"
ck "uploader cannot manage"  "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/webhooks "${NT[@]}")"
ck "deleted"                 '{"ok":true}' "$(curl -s -X DELETE "$B/api/admin/webhooks/$HKID" "${A[@]}")"
ck "gone from the list"      "" "$(curl -s $B/api/admin/webhooks "${A[@]}" | grep -o '127.0.0.1:9/dead')"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"webhook_allow_private":0}' -o/dev/null

echo "== API key scopes =="
mkkey() { curl -s -X POST $B/api/me/keys "${A[@]}" -H 'Content-Type: application/json' -d "$1" | sed 's/.*"key":"\([^"]*\)".*/\1/'; }
KRO=$(mkkey '{"name":"ro","scopes":["read"]}')
KUP=$(mkkey '{"name":"up","scopes":["upload"]}')
KFULL=$(mkkey '{"name":"full","scopes":["read","upload","manage"]}')
head -c 9000 /dev/urandom > k.mp4
ck "read key can list"        "200" "$(curl -s -o/dev/null -w '%{http_code}' "$B/api/videos" -H "Authorization: Bearer $KRO")"
ck "read key cannot upload"   "403" "$(curl -s -o/dev/null -w '%{http_code}' -X POST "$B/api/videos?name=k.mp4" -H "Authorization: Bearer $KRO" --data-binary @k.mp4)"
ck "upload key can upload"    "200" "$(curl -s -o/dev/null -w '%{http_code}' -X POST "$B/api/videos?name=k.mp4" -H "Authorization: Bearer $KUP" --data-binary @k.mp4)"
ck "upload key cannot list"   "403" "$(curl -s -o/dev/null -w '%{http_code}' "$B/api/videos" -H "Authorization: Bearer $KUP")"
ck "scope error is explicit"  "key.scopeMissing" "$(curl -s "$B/api/videos" -H "Authorization: Bearer $KUP")"
ck "no key reaches admin"     "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/settings -H "Authorization: Bearer $KFULL")"
ck "no key mints keys"        "403" "$(curl -s -o/dev/null -w '%{http_code}' -X POST $B/api/me/keys -H "Authorization: Bearer $KFULL" -H 'Content-Type: application/json' -d '{"scopes":["manage"]}')"
ck "no key lists keys"        "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/me/keys -H "Authorization: Bearer $KFULL")"
ck "no key changes password"  "403" "$(curl -s -o/dev/null -w '%{http_code}' -X POST $B/api/me/password -H "Authorization: Bearer $KFULL" -H 'Content-Type: application/json' -d '{"old":"x","password":"yyyyyy"}')"
ck "scopes must be non-empty" "key.noScopes" "$(curl -s -X POST $B/api/me/keys "${A[@]}" -H 'Content-Type: application/json' -d '{"scopes":[]}')"
ck "revoke works"             "401" "$(curl -s -X PATCH $B/api/me/keys/$KRO "${A[@]}" -H 'Content-Type: application/json' -d '{"status":"disabled"}' -o/dev/null; curl -s -o/dev/null -w '%{http_code}' $B/api/me -H "Authorization: Bearer $KRO")"
ck "re-enable works"          "200" "$(curl -s -X PATCH $B/api/me/keys/$KRO "${A[@]}" -H 'Content-Type: application/json' -d '{"status":"active"}' -o/dev/null; curl -s -o/dev/null -w '%{http_code}' $B/api/me -H "Authorization: Bearer $KRO")"
ck "listing reports scopes"   '"scopes":"read"' "$(curl -s $B/api/me/keys "${A[@]}")"

echo "== sessions =="
ck "login returns a token"    "64" "$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/' | tr -d '\n' | wc -c)"
RT=$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PW\",\"remember\":true}" | sed 's/.*"token":"\([^"]*\)".*/\1/')
ck "remember-me session works" "200" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/me -H "Authorization: Bearer $RT")"

echo "== resumable uploads =="
head -c 3000000 /dev/urandom > big.bin
mv big.bin big.mp4
TOTAL=$(node -e "console.log(require('fs').statSync('big.mp4').size)")
CREATE=$(curl -s -X POST $B/api/uploads "${A[@]}" -H 'Content-Type: application/json' -d "{\"name\":\"big.mp4\",\"size\":$TOTAL}")
UPID=$(echo "$CREATE" | sed 's/.*"id":"\([^"]*\)".*/\1/')
ck "session created"          '"offset":0' "$CREATE"
ck "session reports chunk size" '"chunk_size"' "$CREATE"
node -e "
const fs=require('fs'); const b=fs.readFileSync('big.mp4');
fs.writeFileSync('p1.bin', b.subarray(0, 1000000));
fs.writeFileSync('p2.bin', b.subarray(1000000));
"
ck "first chunk accepted"     '"offset":1000000' "$(curl -s -X PATCH "$B/api/uploads/$UPID?offset=0" "${A[@]}" --data-binary @p1.bin)"
ck "progress is queryable"    '"offset":1000000' "$(curl -s "$B/api/uploads/$UPID" "${A[@]}")"
ck "wrong offset refused"     "offset mismatch" "$(curl -s -X PATCH "$B/api/uploads/$UPID?offset=42" "${A[@]}" --data-binary @p2.bin)"
ck "mismatch reveals truth"   '"offset":1000000' "$(curl -s -X PATCH "$B/api/uploads/$UPID?offset=42" "${A[@]}" --data-binary @p2.bin)"
ck "early finish refused"     "incomplete" "$(curl -s -X POST "$B/api/uploads/$UPID/finish" "${A[@]}")"
ck "resume from real offset"  "\"offset\":$TOTAL" "$(curl -s -X PATCH "$B/api/uploads/$UPID?offset=1000000" "${A[@]}" --data-binary @p2.bin)"
FIN=$(curl -s -X POST "$B/api/uploads/$UPID/finish" "${A[@]}")
ck "finish succeeds"          '"orig":"big.mp4"' "$FIN"
NRES=$(echo "$FIN" | sed 's/.*"name":"\([^"]*\)".*/\1/')
ck "assembled bytes intact"   "OK" "$(node -e "
const { execFileSync } = require('child_process');
const crypto = require('crypto'), fs = require('fs');
const local = crypto.createHash('sha256').update(fs.readFileSync('big.mp4')).digest('hex');
console.log(process.argv[1].startsWith(local.slice(0,16)) ? 'OK' : 'HASH MISMATCH ' + local.slice(0,16) + ' vs ' + process.argv[1]);
" "$NRES")"
ck "session is gone after finish" "404" "$(curl -s -o/dev/null -w '%{http_code}' "$B/api/uploads/$UPID" "${A[@]}")"
ck "anonymous cannot create"  "401" "$(curl -s -o/dev/null -w '%{http_code}' -X POST $B/api/uploads -H 'Content-Type: application/json' -d '{"name":"a.mp4","size":10}')"
ck "bad type refused"         "up.badType" "$(curl -s -X POST $B/api/uploads "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"a.exe","size":10}')"
ck "oversize refused"         "up.tooLarge" "$(curl -s -X POST $B/api/uploads "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"a.mp4","size":999999999999}')"
OTHER=$(curl -s -X POST $B/api/uploads "${A[@]}" -H 'Content-Type: application/json' -d '{"name":"o.mp4","size":100}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
ck "another user cannot peek" "404" "$(curl -s -o/dev/null -w '%{http_code}' "$B/api/uploads/$OTHER" "${NT[@]}")"
ck "abort removes it"         "404" "$(curl -s -X DELETE "$B/api/uploads/$OTHER" "${A[@]}" -o/dev/null; curl -s -o/dev/null -w '%{http_code}' "$B/api/uploads/$OTHER" "${A[@]}")"

echo "== UTF-8 across chunk boundaries =="
# A multi-byte payload far larger than one socket chunk. Decoding each chunk
# separately corrupts every character that straddles a boundary.
node -e "
const big = '中文测试内容'.repeat(20000);
require('fs').writeFileSync('utf8.json', JSON.stringify({ terms: big }), 'utf8');
"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' --data-binary @utf8.json -o /dev/null
ck "long CJK survives the round trip" "OK" "$(node -e "
const { execFileSync } = require('child_process');
const raw = execFileSync('curl', ['-s', process.argv[1] + '/api/config/public'], { maxBuffer: 1e8, encoding: 'buffer' });
const t = JSON.parse(raw.toString('utf8')).terms || '';
const want = '中文测试内容'.repeat(20000);
console.log(t === want ? 'OK' : 'CORRUPTED len=' + t.length + ' replacements=' + (t.match(/�/g) || []).length);
" "$B")"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"terms":""}' -o /dev/null

echo "== terms page =="
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"terms":"<p>hello terms</p>"}' -o /dev/null
ck "terms exposed publicly" "hello terms" "$(curl -s $B/api/config/public)"
ck "theme key is gone"      "" "$(curl -s $B/api/config/public | grep -o '\"theme\"')"
ck "theme cannot be set"    "" "$(curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"theme":"light"}' -o /dev/null; curl -s $B/api/admin/settings "${A[@]}" | grep -o '\"theme\"')"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"terms":""}' -o /dev/null

echo "== recycle bin scoping =="
head -c 21000 /dev/urandom > bin1.mp4
head -c 22000 /dev/urandom > bin2.mp4
NB1=$(curl -s -X POST "$B/api/videos?name=bin1.mp4" "${NT[@]}" --data-binary @bin1.mp4 | sed 's/.*"name":"\([^"]*\)".*/\1/')
NB2=$(curl -s -X POST "$B/api/videos?name=bin2.mp4" "${A[@]}" --data-binary @bin2.mp4 | sed 's/.*"name":"\([^"]*\)".*/\1/')
curl -s -X DELETE "$B/api/videos/$NB1" "${NT[@]}" -o/dev/null
curl -s -X DELETE "$B/api/videos/$NB2" "${A[@]}" -o/dev/null
ck "admin bin is own by default" '"scope":"own"' "$(curl -s "$B/api/recycle" "${A[@]}")"
ck "admin bin excludes others"   "" "$(curl -s "$B/api/recycle" "${A[@]}" | grep -o 'bin1.mp4')"
ck "all=1 widens for admin"      '"scope":"site"' "$(curl -s "$B/api/recycle?all=1" "${A[@]}")"
ck "all=1 shows other users"     "bin1.mp4" "$(curl -s "$B/api/recycle?all=1" "${A[@]}")"
ck "uploader sees only own"      "bin1.mp4" "$(curl -s "$B/api/recycle" "${NT[@]}")"
ck "uploader all=1 no escalation" "" "$(curl -s "$B/api/recycle?all=1" "${NT[@]}" | grep -o 'bin2.mp4')"
ck "purge needs auth"            "401" "$(curl -s -o/dev/null -w '%{http_code}' -X DELETE $B/api/recycle)"
ck "uploader purge is scoped"    '"purged":1' "$(curl -s -X DELETE "$B/api/recycle" "${NT[@]}")"
ck "admin item survived"         "bin2.mp4" "$(curl -s "$B/api/recycle?all=1" "${A[@]}")"
ck "uploader cannot purge site"  '"purged":0' "$(curl -s -X DELETE "$B/api/recycle?all=1" "${NT[@]}")"
ck "admin purge reports freed"   '"freed":22000' "$(curl -s -X DELETE "$B/api/recycle?all=1" "${A[@]}")"
ck "bin now empty"               '"total":0' "$(curl -s "$B/api/recycle?all=1" "${A[@]}")"
ck "purged row is gone"          "404" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$NB2")"

echo "== statistics scoping =="
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"stats_public":0}' -o/dev/null
ck "anonymous refused"       "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/stats)"
ck "refusal says why"        "登录" "$(curl -s -H 'Accept-Language: zh-CN' $B/api/stats)"
ck "admin gets site scope"   '"scope":"site"' "$(curl -s $B/api/stats "${A[@]}")"
ck "uploader gets own scope" '"scope":"own"' "$(curl -s $B/api/stats "${NT[@]}")"
ck "own figures are scoped"  '"total":0' "$(curl -s $B/api/stats "${NT[@]}")"
ck "admin figures are not"   "" "$(curl -s $B/api/stats "${A[@]}" | grep -o '\"total\":0,')"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"stats_public":1}' -o/dev/null
ck "opt-in reopens it"       '"scope":"site"' "$(curl -s $B/api/stats)"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"stats_public":0}' -o/dev/null

echo "== P0-1  uploaded HTML cannot execute =="
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"allow_other":1}' -o/dev/null
printf '<script>alert(1)</script>' > x.html
NH=$(curl -s -X POST "$B/api/videos?name=x.html" "${A[@]}" --data-binary @x.html | sed 's/.*"name":"\([^"]*\)".*/\1/')
H=$(curl -s -D- -o/dev/null "$B/v/$NH")
ck "served as octet-stream" "application/octet-stream" "$H"
ck "forced to download"     "attachment"               "$H"
ck "nosniff present"        "nosniff"                  "$H"
ck "sandbox CSP present"    "sandbox"                  "$H"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"allow_other":0}' -o/dev/null

echo "== P0-2  last admin cannot be locked out =="
ck "self demote blocked"  "最后一个管理员" "$(curl -s -X PATCH $B/api/admin/users/1 "${A[@]}" -H 'Content-Type: application/json' -d '{"role":"uploader"}')"
ck "self disable blocked" "最后一个管理员" "$(curl -s -X PATCH $B/api/admin/users/1 "${A[@]}" -H 'Content-Type: application/json' -d '{"status":"disabled"}')"
ck "still admin"          "200" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/settings "${A[@]}")"
# Take the id from the create response — hard-coding it broke as soon as an
# earlier block started creating users of its own.
ADMIN2_ID=$(curl -s -X POST $B/api/admin/users "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"admin2","password":"adminpass","role":"admin"}' | sed 's/.*"id":\([0-9]*\).*/\1/')
ck "with 2 admins demote ok" '{"ok":true}' "$(curl -s -X PATCH $B/api/admin/users/1 "${A[@]}" -H 'Content-Type: application/json' -d '{"role":"uploader"}')"
A2=(-H "Authorization: Bearer $(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"username":"admin2","password":"adminpass"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')")
curl -s -X PATCH $B/api/admin/users/1 "${A2[@]}" -H 'Content-Type: application/json' -d '{"role":"admin"}' -o/dev/null
curl -s -X DELETE "$B/api/admin/users/$ADMIN2_ID" "${A[@]}" -o/dev/null
ck "cleanup left one admin" "1" "$(curl -s $B/api/admin/users "${A[@]}" | grep -o '\"role\":\"admin\"' | wc -l | tr -d ' ')"

echo "== P1  public API leaks nothing sensitive =="
head -c 120000 /dev/urandom > a.mp4
NV=$(curl -s -X POST "$B/api/videos?name=a.mp4" "${A[@]}" --data-binary @a.mp4 | sed 's/.*"name":"\([^"]*\)".*/\1/')
P=$(curl -s "$B/api/public/videos")
ck "no uploader ip"      "" "$(echo "$P" | grep -o '"ip"')"
ck "no ip_region"        "" "$(echo "$P" | grep -o '"ip_region"')"
ck "no username"         "" "$(echo "$P" | grep -o '"username"')"
ck "no mod_score"        "" "$(echo "$P" | grep -o '"mod_score"')"
ck "still returns items" '"orig":"a.mp4"' "$P"
ck "owner view keeps ip" '"ip"' "$(curl -s "$B/api/videos" "${A[@]}")"

echo "== #4  settings are validated =="
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"max_size_mb":"abc","crf":9999,"check_img":77}' -o/dev/null
S=$(curl -s $B/api/admin/settings "${A[@]}")
ck "garbage number -> default" '"max_size_mb":500' "$S"
ck "crf clamped"               '"crf":35'          "$S"
ck "check_img clamped"         '"check_img":2'     "$S"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"max_size_mb":1,"crf":28,"check_img":0}' -o/dev/null
head -c 2000000 /dev/urandom > big.mp4
ck "size cap enforced + reported" "超过大小限制" "$(curl -s -X POST "$B/api/videos?name=big.mp4" "${A[@]}" --data-binary @big.mp4)"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"max_size_mb":500}' -o/dev/null

echo "== #5  banned content cannot be re-uploaded =="
curl -s -X POST "$B/api/videos/$NV/ban" "${A[@]}" -o/dev/null
ck "re-upload rejected" "已被隔离" "$(curl -s -X POST "$B/api/videos?name=a.mp4" "${A[@]}" --data-binary @a.mp4)"
ck "stream returns 451" "451" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$NV")"
curl -s -X POST "$B/api/videos/$NV/unban" "${A[@]}" -o/dev/null

echo "== #8  per-IP quota independent of the log switch =="
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"upload_logs":0,"daily_limit_ip":1}' -o/dev/null
head -c 9000 /dev/urandom > b.mp4
ck "quota still enforced" "该 IP 超过每日上传上限" "$(curl -s -X POST "$B/api/videos?name=b.mp4" "${A[@]}" --data-binary @b.mp4)"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"upload_logs":1,"daily_limit_ip":0}' -o/dev/null

echo "== #9  oversized body answers instead of hanging =="
node -e "require('fs').writeFileSync('big.json',JSON.stringify({username:'admin',password:'x'.repeat(3000000)}))"
ck "gets an HTTP response" "401" "$(curl -s -m 10 -o/dev/null -w '%{http_code}' -X POST $B/api/login -H 'Content-Type: application/json' --data-binary @big.json)"

echo "== #10  view counter is de-duplicated =="
head -c 60000 /dev/urandom > c.mp4
NC=$(curl -s -X POST "$B/api/videos?name=c.mp4" "${A[@]}" --data-binary @c.mp4 | sed 's/.*"name":"\([^"]*\)".*/\1/')
for i in $(seq 1 10); do curl -s -o/dev/null "$B/v/$NC"; done
ck "10 requests -> 1 view" '"views":1' "$(curl -s "$B/api/videos/$NC" "${A[@]}")"

echo "== #11  anti-leech closes the empty-referer hole =="
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"anti_leech":1,"leech_allow_empty":0}' -o/dev/null
ck "no referer blocked"    "403" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$NC")"
ck "own host allowed"      "200" "$(curl -s -o/dev/null -w '%{http_code}' -H "Referer: $B/p/$NC" "$B/v/$NC")"
ck "foreign host blocked"  "403" "$(curl -s -o/dev/null -w '%{http_code}' -H 'Referer: http://evil.example/' "$B/v/$NC")"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"anti_leech":0,"leech_allow_empty":1}' -o/dev/null

echo "== storage quota (previously dead setting) =="
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"storage_quota_gb":0.0001}' -o/dev/null
head -c 40000 /dev/urandom > d.mp4
ck "quota enforced" "站点存储已达上限" "$(curl -s -X POST "$B/api/videos?name=d.mp4" "${A[@]}" --data-binary @d.mp4)"
curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d '{"storage_quota_gb":0}' -o/dev/null

echo "== authorization boundaries (must still hold) =="
BOB_ID=$(curl -s -X POST $B/api/admin/users "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"bob","password":"bobpass1","role":"uploader"}' | sed 's/.*"id":\([0-9]*\).*/\1/')
BT=(-H "Authorization: Bearer $(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"username":"bob","password":"bobpass1"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')")
ck "uploader blocked from admin"    "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/settings "${BT[@]}")"
ck "uploader blocked from users"    "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/users "${BT[@]}")"
ck "all=1 gives no escalation"      '"total":0' "$(curl -s "$B/api/videos?all=1" "${BT[@]}")"
ck "cannot delete other's video"    "403" "$(curl -s -o/dev/null -w '%{http_code}' -X DELETE "$B/api/videos/$NC" "${BT[@]}")"
ck "cannot ban"                     "403" "$(curl -s -o/dev/null -w '%{http_code}' -X POST "$B/api/videos/$NC/ban" "${BT[@]}")"
ck "duplicate username rejected"    "已存在" "$(curl -s -X POST $B/api/admin/users "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"bob","password":"bobpass1"}')"
ck "short password rejected"        "至少 6 位" "$(curl -s -X POST $B/api/admin/users "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"eve","password":"1"}')"
ck "admin reset to weak pw blocked" "至少 6 位" "$(curl -s -X PATCH "$B/api/admin/users/$BOB_ID" "${A[@]}" -H 'Content-Type: application/json' -d '{"password":"1"}')"

echo "== path / header hygiene =="
ck "encoded traversal blocked" "403" "$(curl -s -o/dev/null -w '%{http_code}' --path-as-is "$B/%2e%2e%2fserver.js")"
ck "no source leak"            "" "$(curl -s --path-as-is "$B/%2e%2e/%2e%2e/server.js" | grep -o 'createServer')"
ck "bad percent-encoding" "400" "$(curl -s -o/dev/null -w '%{http_code}' --path-as-is "$B/%zz")"
ck "SPA has X-Frame-Options" "SAMEORIGIN" "$(curl -s -D- -o/dev/null $B/)"
ck "player is embeddable"    "" "$(curl -s -D- -o/dev/null "$B/p/$NC" | grep -i 'x-frame-options')"
ck "range request works"   "206" "$(curl -s -o/dev/null -w '%{http_code}' -r 0-99 "$B/v/$NC")"
ck "bad range -> 416"      "416" "$(curl -s -o/dev/null -w '%{http_code}' -H 'Range: bytes=99999999-' "$B/v/$NC")"

echo
echo "================  $pass passed, $fail failed  ================"
[ "$fail" -eq 0 ]
