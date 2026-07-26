#!/usr/bin/env bash
# Stitches the raw clips into the submission video.
#
# Captions are burned in because the container has no audio hardware, so this
# film is silent by construction. If you record a voiceover, rebuild with
# CAPTIONS=0 to get a clean visual base.
#
# All text is passed to ffmpeg via textfile= rather than text=, because drawtext
# treats colons and apostrophes in an inline string as syntax.
set -euo pipefail

cd "$(dirname "$0")/.."

RAW=media/raw
WORK=media/work
OUT=media/sealed-check-demo.mp4
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
FONTB=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
CAPTIONS="${CAPTIONS:-1}"

rm -rf "$WORK"; mkdir -p "$WORK/txt"

# Name the file after a hash of its content: txt() is called via $(...), which
# runs in a subshell, so a shared counter would never increment in the parent
# and every line would overwrite the same path.
txt() {  # txt <content> -> echoes path
  local path
  path="$WORK/txt/$(printf '%s' "$1" | md5sum | cut -c1-12).txt"
  printf '%s' "$1" > "$path"
  echo "$path"
}

# A title card: dark background, headline, two supporting lines.
card() {   # card <out> <seconds> <headline> <line1> <line2>
  local out=$1 secs=$2
  local fh fa fb
  fh=$(txt "$3"); fa=$(txt "$4"); fb=$(txt "$5")
  ffmpeg -v error -y -f lavfi -i "color=c=0x0d1117:s=1280x720:d=$secs:r=25" \
    -vf "drawtext=fontfile=$FONTB:textfile=$fh:fontcolor=0x58a6ff:fontsize=30:x=(w-tw)/2:y=205,\
drawtext=fontfile=$FONT:textfile=$fa:fontcolor=0xe6edf3:fontsize=33:x=(w-tw)/2:y=308,\
drawtext=fontfile=$FONT:textfile=$fb:fontcolor=0xe6edf3:fontsize=33:x=(w-tw)/2:y=362" \
    -c:v libx264 -pix_fmt yuv420p -r 25 "$out"
}

# A recorded clip, optionally with a caption strip along the bottom.
#
# <hold> freezes the final frame for that many extra seconds, so a verdict or an
# attestation panel stays on screen long enough to read. Cheaper and steadier
# than re-recording with longer waits.
clip() {   # clip <out> <src> <caption> [hold-seconds]
  local out=$1 src=$2 cap=$3 hold=${4:-0} fc pad=""
  [ "$hold" != "0" ] && pad=",tpad=stop_mode=clone:stop_duration=$hold"
  if [ "$CAPTIONS" = "1" ] && [ -n "$cap" ]; then
    fc=$(txt "$cap")
    # Letterbox rather than overlay: shrink the page into the top 632px and put
    # the caption in the black band below it, so a caption can never sit on top
    # of the attestation panel or the verdict.
    ffmpeg -v error -y -i "$RAW/$src" \
      -vf "scale=1124:632,pad=1280:720:(ow-iw)/2:0:color=0x0d1117,\
drawbox=y=632:w=iw:h=88:color=0x000000:t=fill,\
drawtext=fontfile=$FONT:textfile=$fc:fontcolor=white:fontsize=25:x=(w-tw)/2:y=663$pad" \
      -c:v libx264 -pix_fmt yuv420p -r 25 -an "$out"
  else
    ffmpeg -v error -y -i "$RAW/$src" -vf "scale=1280:720$pad" \
      -c:v libx264 -pix_fmt yuv420p -r 25 -an "$out"
  fi
}

echo "building segments…"

card "$WORK/00.mp4" 11 "sealed-check" \
  "To check if a transaction is a scam," \
  "you send it to a scanner first."

card "$WORK/01.mp4" 9 "the problem" \
  "Now someone else knows your trade" \
  "before the chain does."

clip "$WORK/02.mp4" 01-honeypot.webm \
  "A honeypot, caught live. DANGER, because the sell simulation reverted." 3

card "$WORK/03.mp4" 10 "why that matters" \
  "We did not read the token name, or its source." \
  "We tried to sell it, and it refused."

clip "$WORK/04.mp4" 02-safe.webm \
  "A clean trade. The operator never saw the intent." 4

clip "$WORK/05.mp4" 05-verify.webm \
  "Signature recovered and checked against the on-chain TEE signer." 3

card "$WORK/06.mp4" 10 "the invariant" \
  "Attacker-controlled bytes never reach" \
  "the model context."

clip "$WORK/07.mp4" 03-invariant.webm \
  "The model sees only typed numbers we produced by execution." 2

clip "$WORK/08.mp4" 04-tests.webm \
  "A token named to hijack the prompt yields byte-identical facts." 3

card "$WORK/09.mp4" 14 "the honest limitation" \
  "The enclave proves this model produced this verdict." \
  "It does not prove the verdict is correct."

printf "file '%s'\n" "$WORK"/0*.mp4 | sed "s|$WORK|.|" > "$WORK/list.txt"
ffmpeg -v error -y -f concat -safe 0 -i "$WORK/list.txt" -c copy "$WORK/silent.mp4"

# Mux in a silent stereo AAC track. The film has no narration, but a video with
# no audio stream at all is rejected or mangled by several upload pipelines, so
# it needs a track even when there is nothing to hear. Video is stream-copied,
# so this pass costs nothing in quality.
ffmpeg -v error -y -i "$WORK/silent.mp4" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -c:v copy -c:a aac -b:a 128k -shortest -movflags +faststart "$OUT"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
SIZE=$(du -h "$OUT" | cut -f1)
STREAMS=$(ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "$OUT" | tr '\n' ' ')
echo "wrote $OUT  (${DUR}s, $SIZE, streams: $STREAMS)"
if awk "BEGIN{exit !($DUR < 120)}"; then
  echo "WARNING: under the 2 minute minimum" >&2
fi
