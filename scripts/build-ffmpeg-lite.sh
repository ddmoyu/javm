#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cygpath -u "$1")
reference_dir=$(cygpath -u "$2")
build_dir=$(cygpath -u "$3")
make_tool=$(cygpath -u "$4")
nasm_dir=$(dirname "$(cygpath -u "$5")")
# MSVC's link.exe must precede Git's POSIX link. MSYS must translate source paths.
export PATH="$(dirname "$(command -v cl.exe)"):$nasm_dir:$PATH"
unset MSYS2_ARG_CONV_EXCL MSYS_NO_PATHCONV
mkdir -p "$build_dir"
cd "$build_dir"
video_decoders=$(tr -d '\r' < "$reference_dir/build-info/video-decoders.txt" | paste -sd, -)
"$source_dir/configure" --toolchain=msvc --arch=x86_64 --target-os=win32 \
  --disable-autodetect --disable-debug --disable-doc --disable-network \
  --disable-hwaccels --disable-swresample --disable-avdevice --disable-ffplay \
  --disable-programs --enable-ffmpeg --disable-ffprobe --enable-small \
  --disable-shared --enable-static --disable-everything \
  --enable-avcodec --enable-avformat --enable-avutil --enable-swscale --enable-avfilter \
  --enable-protocol=file,pipe --enable-demuxers --enable-parsers \
  --enable-decoder="$video_decoders,aac,aac_fixed,ac3,eac3,mp3,flac,vorbis,dca,alac" \
  --enable-muxer=image2,image2pipe,mp4 --enable-encoder=mjpeg \
  --enable-filter=buffer,buffersink,format,fps,scale,select \
  --enable-bsf=aac_adtstoasc,av1_frame_merge,av1_frame_split,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,mjpeg2jpeg,mpeg4_unpack_bframes,vc1_asftorcv,vp9_superframe,vp9_superframe_split \
  --extra-cflags=-Os
"$make_tool" -r -j8 ffmpeg.exe
