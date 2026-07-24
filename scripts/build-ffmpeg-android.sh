#!/usr/bin/env bash
#
# Cross-compile a static ffmpeg (with libx264) for Android and install it into
# the app's jniLibs as `libffmpeg.so`, where Android extracts it to
# nativeLibraryDir (see `useLegacyPackaging` in gen/android/app/build.gradle.kts)
# as a real, executable file the Rust relay spawns for live-TV transcoding.
#
# Requirements:
#   - Android NDK (set ANDROID_NDK_HOME, e.g. $ANDROID_HOME/ndk/<version>)
#   - pkg-config on PATH (brew install pkg-config)
#   - ffmpeg + x264 sources (downloaded automatically to a temp build dir)
#
# Notes:
#   - Built WITHOUT ffmpeg assembly (--disable-asm). Some CPUs/emulators over-
#     report ARM extensions via HWCAP and SIGILL on ffmpeg's SIMD; portable C is
#     correct everywhere. x264 keeps its own asm for the (expensive) H.264 encode.
#   - No TLS backend, so ffmpeg fetches http:// live sources only (typical for
#     IPTV). Add --enable-mbedtls (+ a cross-built mbedTLS) for https live.
#
# Usage: ANDROID_NDK_HOME=... scripts/build-ffmpeg-android.sh [abi]
#   abi defaults to arm64-v8a (maps to aarch64-linux-android).
set -euo pipefail

ABI="${1:-arm64-v8a}"
case "$ABI" in
  arm64-v8a)   TRIPLE=aarch64-linux-android;  FFARCH=aarch64; FFCPU=armv8-a ;;
  armeabi-v7a) TRIPLE=armv7a-linux-androideabi; FFARCH=arm;   FFCPU=armv7-a ;;
  x86_64)      TRIPLE=x86_64-linux-android;    FFARCH=x86_64; FFCPU=x86-64  ;;
  *) echo "Unsupported ABI: $ABI"; exit 1 ;;
esac
API=24
FFMPEG_VERSION=6.1.1

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to your NDK path}"
command -v pkg-config >/dev/null || { echo "pkg-config not found (brew install pkg-config)"; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
JNILIBS="$REPO/src-tauri/gen/android/app/src/main/jniLibs/$ABI"
BUILD="${FFMPEG_BUILD_DIR:-$(mktemp -d)/ffbuild}"
PREFIX="$BUILD/out"
mkdir -p "$BUILD" "$PREFIX" "$JNILIBS"

HOSTTAG="$(ls "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" | head -1)"
TC="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$HOSTTAG"
BIN="$TC/bin"; SYSROOT="$TC/sysroot"
export CC="$BIN/${TRIPLE}${API}-clang" CXX="$BIN/${TRIPLE}${API}-clang++"
export AR="$BIN/llvm-ar" NM="$BIN/llvm-nm" RANLIB="$BIN/llvm-ranlib" STRIP="$BIN/llvm-strip"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"

# --- fetch sources ---------------------------------------------------------
cd "$BUILD"
[ -d x264 ] || git clone --depth 1 https://code.videolan.org/videolan/x264.git x264
[ -d ffmpeg ] || { curl -fsSL -o ff.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"; tar xf ff.tar.xz; mv "ffmpeg-${FFMPEG_VERSION}" ffmpeg; }

# --- x264 (static, no asm) -------------------------------------------------
cd "$BUILD/x264"
make distclean >/dev/null 2>&1 || true
./configure --prefix="$PREFIX" --host="$TRIPLE" --sysroot="$SYSROOT" \
  --enable-static --enable-pic --disable-cli --disable-opencl --disable-asm \
  --cross-prefix="$BIN/llvm-" --extra-cflags="-fPIC"
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
make install

# --- ffmpeg (static, +libx264, no asm, PIE binary) -------------------------
cd "$BUILD/ffmpeg"
make distclean >/dev/null 2>&1 || true
./configure \
  --prefix="$PREFIX" --target-os=android --arch="$FFARCH" --cpu="$FFCPU" \
  --enable-cross-compile --cc="$CC" --cxx="$CXX" \
  --ar="$AR" --nm="$NM" --ranlib="$RANLIB" --strip="$STRIP" --sysroot="$SYSROOT" \
  --pkg-config=pkg-config --pkg-config-flags="--static" \
  --extra-cflags="-I$PREFIX/include -O2 -fPIC -DANDROID" \
  --extra-ldflags="-L$PREFIX/lib -pie" --extra-libs="-lm" \
  --enable-gpl --enable-version3 --enable-libx264 \
  --enable-static --disable-shared --enable-small --enable-pic --disable-asm \
  --disable-doc --disable-htmlpages --disable-manpages --disable-txtpages \
  --disable-debug --disable-ffplay --disable-ffprobe --disable-symver
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

"$STRIP" "$BUILD/ffmpeg/ffmpeg" -o "$JNILIBS/libffmpeg.so"
ls -lh "$JNILIBS/libffmpeg.so"
echo "Installed ffmpeg for $ABI -> $JNILIBS/libffmpeg.so"
