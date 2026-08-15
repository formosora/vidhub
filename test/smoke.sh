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
curl -s -X POST $B/api/admin/users "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"admin2","password":"adminpass","role":"admin"}' -o/dev/null
ck "with 2 admins demote ok" '{"ok":true}' "$(curl -s -X PATCH $B/api/admin/users/1 "${A[@]}" -H 'Content-Type: application/json' -d '{"role":"uploader"}')"
A2=(-H "Authorization: Bearer $(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"username":"admin2","password":"adminpass"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')")
curl -s -X PATCH $B/api/admin/users/1 "${A2[@]}" -H 'Content-Type: application/json' -d '{"role":"admin"}' -o/dev/null
curl -s -X DELETE $B/api/admin/users/2 "${A[@]}" -o/dev/null

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
curl -s -X POST $B/api/admin/users "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"bob","password":"bobpass1","role":"uploader"}' -o/dev/null
BT=(-H "Authorization: Bearer $(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"username":"bob","password":"bobpass1"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')")
ck "uploader blocked from admin"    "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/settings "${BT[@]}")"
ck "uploader blocked from users"    "403" "$(curl -s -o/dev/null -w '%{http_code}' $B/api/admin/users "${BT[@]}")"
ck "all=1 gives no escalation"      '"total":0' "$(curl -s "$B/api/videos?all=1" "${BT[@]}")"
ck "cannot delete other's video"    "403" "$(curl -s -o/dev/null -w '%{http_code}' -X DELETE "$B/api/videos/$NC" "${BT[@]}")"
ck "cannot ban"                     "403" "$(curl -s -o/dev/null -w '%{http_code}' -X POST "$B/api/videos/$NC/ban" "${BT[@]}")"
ck "duplicate username rejected"    "已存在" "$(curl -s -X POST $B/api/admin/users "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"bob","password":"bobpass1"}')"
ck "short password rejected"        "至少 6 位" "$(curl -s -X POST $B/api/admin/users "${A[@]}" -H 'Content-Type: application/json' -d '{"username":"eve","password":"1"}')"
ck "admin reset to weak pw blocked" "至少 6 位" "$(curl -s -X PATCH $B/api/admin/users/3 "${A[@]}" -H 'Content-Type: application/json' -d '{"password":"1"}')"

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
