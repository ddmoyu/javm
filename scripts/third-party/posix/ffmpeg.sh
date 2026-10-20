#!/usr/bin/env bash
set -euo pipefail
source_dir="$1"
build_dir="$2"
decoder_file="$3"
mkdir -p "$build_dir"
cd "$build_dir"
video_decoders=$(tr -d '\r' < "$decoder_file" | paste -sd, -)
args=()
if [[ "$(uname -s)" == Darwin ]]; then
  args+=("--extra-cflags=-Os -mmacosx-version-min=13.0" --extra-ldflags=-mmacosx-version-min=13.0)
else
  args+=(--extra-cflags=-Os)
fi
"$source_dir/configure" "${args[@]}" \
  --disable-autodetect --disable-debug --disable-doc --disable-network \
  --disable-hwaccels --disable-swresample --disable-avdevice --disable-ffplay \
  --disable-programs --enable-ffmpeg --disable-ffprobe --enable-small \
  --disable-shared --enable-static --disable-everything \
  --enable-avcodec --enable-avformat --enable-avutil --enable-swscale --enable-avfilter \
  --enable-protocol=file,pipe,crypto --enable-demuxers --enable-parsers \
  --enable-decoder="$video_decoders,aac,aac_fixed,ac3,eac3,mp3,flac,vorbis,dca,alac" \
  --enable-muxer=image2,image2pipe,mp4 --enable-encoder=mjpeg \
  --enable-filter=buffer,buffersink,format,fps,scale,select \
  --enable-bsf=aac_adtstoasc,av1_frame_merge,av1_frame_split,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,mjpeg2jpeg,mpeg4_unpack_bframes,vc1_asftorcv,vp9_superframe,vp9_superframe_split
make -j4 ffmpeg
