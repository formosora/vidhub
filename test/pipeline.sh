#!/usr/bin/env bash
#
# vidhub ffmpeg pipeline test — the half that test/smoke.sh cannot cover.
# Generates its own media with ffmpeg, then checks the real transcode/watermark/
# scale/thumbnail/moderation paths end to end.
#
# Requires ffmpeg + ffprobe on PATH, and a server started on a THROWAWAY dir:
#
#   DATA_DIR=/tmp/vh-pipe PORT=8097 ADMIN_PASSWORD=TestPass123 node server/server.js &
#   BASE=http://localhost:8097 DATA_DIR=/tmp/vh-pipe bash test/pipeline.sh
#
set -u
B=${BASE:-http://localhost:8097}
PW=${ADMIN_PASSWORD:-TestPass123}
DD=${DATA_DIR:?set DATA_DIR to the data directory used by the server}
M=$(mktemp -d)
pass=0; fail=0
ck() { if [[ "$3" == *"$2"* ]]; then echo "  PASS  $1"; pass=$((pass+1))
       else echo "  FAIL  $1"; echo "        want ~ '$2'"; echo "        got    '$3'"; fail=$((fail+1)); fi }

command -v ffmpeg >/dev/null || { echo "ffmpeg not on PATH — skipping"; exit 0; }

echo "generating test media in $M …"
ffmpeg -v error -y -f lavfi -i testsrc=size=640x360:rate=25:duration=6 \
       -f lavfi -i sine=frequency=440:duration=6 \
       -c:v libx264 -pix_fmt yuv420p -c:a aac "$M/clip.mkv"
ffmpeg -v error -y -f lavfi -i testsrc=size=640x360:rate=25:duration=4 -c:v libx264 -pix_fmt yuv420p "$M/wm.mkv"
ffmpeg -v error -y -f lavfi -i testsrc=size=1280x720:rate=25:duration=3 -c:v libx264 -pix_fmt yuv420p "$M/big.mkv"
ffmpeg -v error -y -f lavfi -i testsrc=size=160x90:rate=25:duration=2   -c:v libx264 -pix_fmt yuv420p "$M/tiny.mp4"
ffmpeg -v error -y -f lavfi -i testsrc=size=800x600:duration=1 -frames:v 1 "$M/photo.jpg"
ffmpeg -v error -y -f lavfi -i color=c=0xD9A97E:size=320x240:duration=3 -c:v libx264 -pix_fmt yuv420p "$M/skin.mp4"

T=$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' \
     -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/')
A=(-H "Authorization: Bearer $T")
set_conf() { curl -s -X PUT $B/api/admin/settings "${A[@]}" -H 'Content-Type: application/json' -d "$1" -o/dev/null; }
wait_done() {
  for i in $(seq 1 90); do
    s=$(curl -s "$B/api/videos/$1" "${A[@]}" | sed 's/.*"status":"\([^"]*\)".*/\1/')
    [ "$s" != "processing" ] && { echo "$s"; return; }
    sleep 1
  done; echo "TIMEOUT"
}
upload() { curl -s -X POST "$B/api/videos?name=$1" "${A[@]}" --data-binary @"$M/$1"; }
diskfile() { # diskfile <public name>
  node -e "
const {DatabaseSync}=require('node:sqlite');const fs=require('fs'),path=require('path');
const db=new DatabaseSync(process.argv[1]+'/vidhub.db');
const r=db.prepare('SELECT stored FROM videos WHERE name=?').get(process.argv[2]);
const base=path.join(process.argv[1],'videos');
for(const d of fs.readdirSync(base)){const p=path.join(base,d,r.stored);if(fs.existsSync(p)){console.log(p);break}}
" "$DD" "$1"
}

echo
echo "== ffmpeg wiring =="
ck "server sees ffmpeg" '"ffmpeg":true' "$(curl -s $B/api/admin/check "${A[@]}")"

echo
echo "== transcode keeps the public URL stable (mkv -> mp4) =="
set_conf '{"process_enabled":1,"convert_to":"mp4","thumbnail":1,"check_img":0,"watermark":0,"max_width":0,"image_compress":0}'
R=$(upload clip.mkv)
N=$(echo "$R" | sed 's/.*"name":"\([^"]*\)".*/\1/')
URL=$(echo "$R" | sed 's/.*"url":"\([^"]*\)".*/\1/')
ck "url handed out is .mkv" ".mkv" "$URL"
ck "pipeline succeeded" "ok" "$(wait_done "$N")"
H=$(curl -s -D- -o/dev/null "$B$URL")
ck "original .mkv url still 200" "200 OK"   "$H"
ck "now served as mp4"           "video/mp4" "$H"
ck "no failed jobs" "" "$(curl -s $B/api/admin/jobs "${A[@]}" | grep -o '"status":"failed"')"
V=$(curl -s "$B/api/videos/$N" "${A[@]}")
ck "probed width"     '"width":640'  "$V"
ck "probed duration"  '"duration":6' "$V"
ck "thumbnail served" "image/jpeg" "$(curl -s -D- -o/dev/null "$B/t/$N")"
ck "range seek works" "206" "$(curl -s -o/dev/null -w '%{http_code}' -r 1000-2000 "$B$URL")"
F=$(diskfile "$N")
ck "container is mp4" "mp4"  "$(ffprobe -v error -show_entries format=format_name -of csv=p=0 "$F")"
ck "video codec h264" "h264" "$(ffprobe -v error -select_streams v -show_entries stream=codec_name -of csv=p=0 "$F")"
ck "audio kept"       "aac"  "$(ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "$F")"

echo
echo "== re-upload of the same bytes after ext rewrite (PK collision regression) =="
ck "dedupes, no 500" '"dedup":true' "$(upload clip.mkv)"

echo
echo "== text watermark is really burned in =="
set_conf '{"watermark":1,"water_text":"vidhub","water_size":24,"water_position":9}'
NW=$(upload wm.mkv | sed 's/.*"name":"\([^"]*\)".*/\1/')
ck "watermarked clip ok" "ok" "$(wait_done "$NW")"
FW=$(diskfile "$NW")
ffmpeg -v error -y -ss 1 -i "$FW"       -frames:v 1 -vf "crop=200:60:in_w-210:in_h-70" "$M/c_wm.png"
ffmpeg -v error -y -ss 1 -i "$M/wm.mkv" -frames:v 1 -vf "crop=200:60:in_w-210:in_h-70" "$M/c_orig.png"
ck "corner pixels changed" "YES" "$(node -e "
const {execFileSync}=require('child_process');
const px=f=>execFileSync('ffmpeg',['-v','error','-i',f,'-f','rawvideo','-pix_fmt','gray','-'],{maxBuffer:1e8});
const a=px(process.argv[1]), b=px(process.argv[2]);
let d=0; for(let i=0;i<Math.min(a.length,b.length);i++) if(Math.abs(a[i]-b[i])>12) d++;
console.log(d>200?'YES':'NO('+d+')')
" "$M/c_wm.png" "$M/c_orig.png")"
set_conf '{"watermark":0}'

echo
echo "== max_width downscale (unquoted min() used to break the filtergraph) =="
set_conf '{"max_width":320,"max_height":0}'
NB=$(upload big.mkv | sed 's/.*"name":"\([^"]*\)".*/\1/')
ck "1280x720 processed" "ok" "$(wait_done "$NB")"
VB=$(curl -s "$B/api/videos/$NB" "${A[@]}")
ck "downscaled to 320 wide" '"width":320'  "$VB"
ck "aspect kept (180)"      '"height":180' "$VB"
ck "file on disk is 320 wide" "320" "$(ffprobe -v error -select_streams v -show_entries stream=width -of csv=p=0 "$(diskfile "$NB")")"
set_conf '{"max_width":0}'

echo
echo "== min-resolution gate =="
set_conf '{"min_width":320,"min_height":240}'
ck "160x90 rejected"    "低于最低限制" "$(upload tiny.mp4)"
ck "no orphan row left" "" "$(curl -s "$B/api/videos?all=1&size=100" "${A[@]}" | grep -o 'tiny.mp4')"
set_conf '{"min_width":0,"min_height":0}'

echo
echo "== image pipeline =="
set_conf '{"allow_images":1,"image_compress":1,"image_quality":70,"max_width":400}'
NI=$(upload photo.jpg | sed 's/.*"name":"\([^"]*\)".*/\1/')
ck "image processed"     "ok" "$(wait_done "$NI")"
ck "image served inline" "image/jpeg" "$(curl -s -D- -o/dev/null "$B/v/$NI")"
ck "downscaled to 400"   '"width":400' "$(curl -s "$B/api/videos/$NI" "${A[@]}")"
set_conf '{"image_compress":0,"max_width":0}'

echo
echo "== local skin-tone moderation =="
set_conf '{"check_img":1,"check_img_value":40,"check_action":"ban","convert_to":""}'
NS=$(upload skin.mp4 | sed 's/.*"name":"\([^"]*\)".*/\1/')
SS=$(wait_done "$NS")
ck "flagged and quarantined"    "banned" "$SS"
ck "quarantined stream 451"     "451" "$(curl -s -o/dev/null -w '%{http_code}' "$B/v/$NS")"
ck "benign clip left published" '"status":"ok"' "$(curl -s "$B/api/videos/$N" "${A[@]}")"
set_conf '{"check_img":0}'

rm -rf "$M"
echo
echo "================  $pass passed, $fail failed  ================"
[ "$fail" -eq 0 ]
