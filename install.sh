#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  JARVIS — Termux Installation Script v4.0
#  Zero-dependency setup for Android/Termux
#  Includes: Node.js, Whisper.cpp STT, Piper TTS, Spanish male voice, Android control
# ═══════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                                           ║${NC}"
echo -e "${CYAN}║   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗    ║${NC}"
echo -e "${CYAN}║   ████╗  ██║██╔════╝╚██╗██╔╝╚██╗ ██╔╝    ║${NC}"
echo -e "${CYAN}║   ██╔██╗ ██║█████╗   ╚███╔╝  ╚████╔╝     ║${NC}"
echo -e "${CYAN}║   ██║╚██╗██║██╔══╝   ██╔██╗   ╚██╔╝      ║${NC}"
echo -e "${CYAN}║   ██║ ╚████║███████╗██╔╝ ██╗   ██║       ║${NC}"
echo -e "${CYAN}║   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝   ╚═╝       ║${NC}"
echo -e "${CYAN}║                                           ║${NC}"
echo -e "${CYAN}║   Autonomous Voice Agent v4.0             ║${NC}"
echo -e "${CYAN}║   Whisper STT · Piper TTS · Android Ctrl  ║${NC}"
echo -e "${CYAN}║                                           ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${NC}"
echo ""

# ─── Check if running in Termux ─────────────────────────────
IS_TERMUX=false
if [ -d "/data/data/com.termux" ] || [ -n "$TERMUX_VERSION" ]; then
    IS_TERMUX=true
    echo -e "${YELLOW}[INFO]${NC} Detected Termux environment"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Step 1: Update packages ────────────────────────────────
echo -e "${BOLD}[1/10]${NC} Updating packages..."
if [ "$IS_TERMUX" = true ]; then
    pkg update -y 2>/dev/null || apt update -y
else
    sudo apt update -y 2>/dev/null || true
fi
echo -e "${GREEN}✓${NC} Packages updated"

# ─── Step 2: Install Node.js ────────────────────────────────
echo -e "${BOLD}[2/10]${NC} Installing Node.js..."
if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v)
    echo -e "${GREEN}✓${NC} Node.js already installed: ${NODE_VERSION}"
else
    if [ "$IS_TERMUX" = true ]; then
        pkg install nodejs -y 2>/dev/null || apt install nodejs -y
    else
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null || true
        sudo apt install -y nodejs 2>/dev/null || true
    fi

    if command -v node &>/dev/null; then
        echo -e "${GREEN}✓${NC} Node.js installed: $(node -v)"
    else
        echo -e "${RED}✗${NC} Failed to install Node.js. Please install it manually."
        exit 1
    fi
fi

# ─── Step 3: Verify Node.js version ─────────────────────────
NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}✗${NC} Node.js 18+ required (current: $(node -v))"
    echo -e "  Upgrade: ${CYAN}pkg install nodejs-lts${NC} (Termux)"
    exit 1
fi

# ─── Step 4: Create project structure ───────────────────────
echo -e "${BOLD}[3/10]${NC} Setting up project..."

mkdir -p "$SCRIPT_DIR/data/memory"
mkdir -p "$SCRIPT_DIR/data/tts-cache"
mkdir -p "$SCRIPT_DIR/models/piper"
mkdir -p "$SCRIPT_DIR/models/whisper"
mkdir -p "$SCRIPT_DIR/bin/piper"
mkdir -p "$SCRIPT_DIR/bin/whisper"

echo -e "${GREEN}✓${NC} Project structure ready"

# ─── Step 5: Install build dependencies ─────────────────────
echo -e "${BOLD}[4/10]${NC} Installing build dependencies..."

if [ "$IS_TERMUX" = true ]; then
    pkg install cmake git ffmpeg sox -y 2>/dev/null || true
else
    sudo apt install -y cmake git ffmpeg sox libsox-dev 2>/dev/null || true
fi

if command -v ffmpeg &>/dev/null; then
    echo -e "${GREEN}✓${NC} ffmpeg available"
else
    echo -e "${YELLOW}⚠${NC} ffmpeg not found (needed for audio conversion). Install: ${CYAN}pkg install ffmpeg${NC}"
fi

if command -v sox &>/dev/null; then
    echo -e "${GREEN}✓${NC} sox available"
else
    echo -e "${YELLOW}⚠${NC} sox not found (fallback audio converter). Install: ${CYAN}pkg install sox${NC}"
fi

echo -e "${GREEN}✓${NC} Build dependencies ready"

# ─── Step 6: Compile whisper.cpp ────────────────────────────
echo -e "${BOLD}[5/10]${NC} Installing Whisper.cpp STT..."

WHISPER_DIR="$SCRIPT_DIR/bin/whisper"
WHISPER_BIN="$WHISPER_DIR/main"
WHISPER_MODEL_DIR="$SCRIPT_DIR/models/whisper"

if [ -f "$WHISPER_BIN" ]; then
    echo -e "${GREEN}✓${NC} Whisper binary already compiled"
else
    echo -e "${DIM}  Compiling whisper.cpp from source...${NC}"
    WHISPER_BUILD_DIR="/tmp/whisper-cpp-build"

    rm -rf "$WHISPER_BUILD_DIR" 2>/dev/null || true
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$WHISPER_BUILD_DIR" 2>/dev/null || {
        echo -e "${YELLOW}⚠${NC} Git clone failed. Trying manual compilation..."
    }

    if [ -d "$WHISPER_BUILD_DIR" ]; then
        cd "$WHISPER_BUILD_DIR"

        # Build whisper.cpp
        mkdir -p build && cd build
        cmake .. -DCMAKE_BUILD_TYPE=Release -DWHISPER_NO_AVX=ON 2>/dev/null || cmake .. -DCMAKE_BUILD_TYPE=Release 2>/dev/null || {
            echo -e "${YELLOW}⚠${NC} CMake configuration failed"
        }

        if [ -f "Makefile" ] || [ -f "build.ninja" ]; then
            cmake --build . --config Release -j$(nproc 2>/dev/null || echo 2) 2>/dev/null || make -j$(nproc 2>/dev/null || echo 2) 2>/dev/null || {
                echo -e "${YELLOW}⚠${NC} Compilation failed"
            }
        fi

        # Copy binary if compiled
        if [ -f "bin/main" ] || [ -f "main" ]; then
            cp bin/main "$WHISPER_BIN" 2>/dev/null || cp main "$WHISPER_BIN" 2>/dev/null || true
            chmod +x "$WHISPER_BIN" 2>/dev/null || true
            echo -e "${GREEN}✓${NC} Whisper.cpp compiled and installed"
        else
            # Try the Makefile approach as fallback
            cd "$WHISPER_BUILD_DIR"
            make main -j$(nproc 2>/dev/null || echo 2) 2>/dev/null && {
                cp main "$WHISPER_BIN" 2>/dev/null || true
                chmod +x "$WHISPER_BIN" 2>/dev/null || true
                echo -e "${GREEN}✓${NC} Whisper.cpp compiled (make) and installed"
            } || {
                echo -e "${YELLOW}⚠${NC} Whisper compilation failed. You can compile manually:"
                echo -e "  ${CYAN}git clone https://github.com/ggerganov/whisper.cpp${NC}"
                echo -e "  ${CYAN}cd whisper.cpp && make main${NC}"
                echo -e "  ${CYAN}cp main $WHISPER_BIN${NC}"
            }
        fi

        cd "$SCRIPT_DIR"
    else
        echo -e "${YELLOW}⚠${NC} Could not clone whisper.cpp. Install manually:"
        echo -e "  ${CYAN}git clone https://github.com/ggerganov/whisper.cpp${NC}"
        echo -e "  ${CYAN}cd whisper.cpp && make main${NC}"
        echo -e "  ${CYAN}cp main $WHISPER_BIN${NC}"
    fi

    # Clean up build dir
    rm -rf "$WHISPER_BUILD_DIR" 2>/dev/null || true
fi

# ─── Step 7: Download Whisper models ────────────────────────
echo -e "${BOLD}[6/10]${NC} Downloading Whisper STT models..."

# Tiny multilingual model (75MB) — best for Termux (fastest)
TINY_MODEL="ggml-tiny.bin"
TINY_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"

if [ -f "$WHISPER_MODEL_DIR/$TINY_MODEL" ]; then
    echo -e "${GREEN}✓${NC} Whisper tiny model already installed"
else
    echo -e "${DIM}  Downloading ${TINY_MODEL} (~75MB, multilingual)...${NC}"
    DL_OK=false

    if command -v wget &>/dev/null; then
        wget -q "$TINY_MODEL_URL" -O "$WHISPER_MODEL_DIR/$TINY_MODEL" 2>/dev/null && DL_OK=true
    elif command -v curl &>/dev/null; then
        curl -sL "$TINY_MODEL_URL" -o "$WHISPER_MODEL_DIR/$TINY_MODEL" 2>/dev/null && DL_OK=true
    fi

    if [ "$DL_OK" = true ] && [ -f "$WHISPER_MODEL_DIR/$TINY_MODEL" ]; then
        MODEL_SIZE=$(stat -c%s "$WHISPER_MODEL_DIR/$TINY_MODEL" 2>/dev/null || stat -f%z "$WHISPER_MODEL_DIR/$TINY_MODEL" 2>/dev/null || echo "?")
        echo -e "${GREEN}✓${NC} Whisper tiny model downloaded (${MODEL_SIZE} bytes)"
    else
        echo -e "${YELLOW}⚠${NC} Model download failed. Download manually:"
        echo -e "  ${CYAN}$TINY_MODEL_URL${NC}"
        echo -e "  Save to: ${WHISPER_MODEL_DIR}/"
    fi
fi

# Base model (142MB, optional — better quality)
BASE_MODEL="ggml-base.bin"
BASE_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"

if [ -f "$WHISPER_MODEL_DIR/$BASE_MODEL" ]; then
    echo -e "${GREEN}✓${NC} Whisper base model already installed"
else
    echo -e "${DIM}  Skipping base model (optional, ~142MB). Install with:${NC}"
    echo -e "  ${DIM}wget $BASE_MODEL_URL -O $WHISPER_MODEL_DIR/$BASE_MODEL${NC}"
fi

# ─── Step 8: Install Piper TTS ──────────────────────────────
echo -e "${BOLD}[7/10]${NC} Installing Piper TTS..."

PIPER_DIR="$SCRIPT_DIR/bin/piper"
PIPER_BIN="$PIPER_DIR/piper"
PIPER_MODEL_DIR="$SCRIPT_DIR/models/piper"

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    PIPER_ARCH="aarch64"
elif [ "$ARCH" = "x86_64" ]; then
    PIPER_ARCH="x86_64"
else
    PIPER_ARCH="aarch64"  # Default for Termux/Android
    echo -e "${YELLOW}⚠${NC} Unknown arch $ARCH, defaulting to aarch64"
fi

PIPER_VERSION="2023.11.14-2"

if [ -f "$PIPER_BIN" ]; then
    echo -e "${GREEN}✓${NC} Piper binary already installed"
else
    echo -e "${DIM}  Downloading Piper for ${PIPER_ARCH}...${NC}"
    PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PIPER_ARCH}.tar.gz"
    PIPER_TMP="/tmp/piper-jarvis.tar.gz"

    if command -v wget &>/dev/null; then
        wget -q "$PIPER_URL" -O "$PIPER_TMP" 2>/dev/null && echo -e "${DIM}  Download complete${NC}" || {
            echo -e "${YELLOW}⚠${NC} Download failed. You can install manually:"
            echo -e "  ${CYAN}wget $PIPER_URL -O /tmp/piper.tar.gz${NC}"
            echo -e "  ${CYAN}tar xzf /tmp/piper.tar.gz -C $PIPER_DIR --strip-components=1${NC}"
        }
    elif command -v curl &>/dev/null; then
        curl -sL "$PIPER_URL" -o "$PIPER_TMP" 2>/dev/null && echo -e "${DIM}  Download complete${NC}" || {
            echo -e "${YELLOW}⚠${NC} Download failed. You can install manually."
        }
    else
        echo -e "${YELLOW}⚠${NC} No wget/curl found. Install Piper manually from:"
        echo -e "  ${CYAN}$PIPER_URL${NC}"
    fi

    if [ -f "$PIPER_TMP" ]; then
        tar xzf "$PIPER_TMP" -C "$PIPER_DIR" --strip-components=1 2>/dev/null
        rm -f "$PIPER_TMP"
        chmod +x "$PIPER_BIN" 2>/dev/null
        echo -e "${GREEN}✓${NC} Piper installed: $PIPER_BIN"
    else
        echo -e "${YELLOW}⚠${NC} Piper download skipped"
    fi
fi

# ─── Step 9: Download voice models ──────────────────────────
echo -e "${BOLD}[8/10]${NC} Downloading voice models (Spanish male)..."

# Spanish male voice — Carlos (high quality)
ES_MODEL="es_ES-carlfm-high"
ES_MODEL_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/carlfm/high/es_ES-carlfm-high.onnx"
ES_CONFIG_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/carlfm/high/es_ES-carlfm-high.onnx.json"

if [ -f "$PIPER_MODEL_DIR/${ES_MODEL}.onnx" ]; then
    echo -e "${GREEN}✓${NC} Spanish voice already installed: ${ES_MODEL}"
else
    echo -e "${DIM}  Downloading ${ES_MODEL}...${NC}"
    DL_OK=true

    if command -v wget &>/dev/null; then
        wget -q "$ES_MODEL_URL" -O "$PIPER_MODEL_DIR/${ES_MODEL}.onnx" 2>/dev/null || DL_OK=false
        wget -q "$ES_CONFIG_URL" -O "$PIPER_MODEL_DIR/${ES_MODEL}.onnx.json" 2>/dev/null || DL_OK=false
    elif command -v curl &>/dev/null; then
        curl -sL "$ES_MODEL_URL" -o "$PIPER_MODEL_DIR/${ES_MODEL}.onnx" 2>/dev/null || DL_OK=false
        curl -sL "$ES_CONFIG_URL" -o "$PIPER_MODEL_DIR/${ES_MODEL}.onnx.json" 2>/dev/null || DL_OK=false
    else
        DL_OK=false
    fi

    if [ "$DL_OK" = true ] && [ -f "$PIPER_MODEL_DIR/${ES_MODEL}.onnx" ]; then
        echo -e "${GREEN}✓${NC} Spanish male voice installed: Carlos (${ES_MODEL})"
    else
        echo -e "${YELLOW}⚠${NC} Voice download failed. Install manually:"
        echo -e "  ${CYAN}$ES_MODEL_URL${NC}"
        echo -e "  ${CYAN}$ES_CONFIG_URL${NC}"
        echo -e "  Save to: ${PIPER_MODEL_DIR}/"
    fi
fi

# English male voice — Danny (optional)
EN_MODEL="en_US-danny-medium"
EN_MODEL_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/danny-medium/en_US-danny-medium.onnx"
EN_CONFIG_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/danny-medium/en_US-danny-medium.onnx.json"

if [ -f "$PIPER_MODEL_DIR/${EN_MODEL}.onnx" ]; then
    echo -e "${GREEN}✓${NC} English voice already installed: ${EN_MODEL}"
else
    echo -e "${DIM}  Downloading ${EN_MODEL} (English, optional)...${NC}"
    if command -v wget &>/dev/null; then
        wget -q "$EN_MODEL_URL" -O "$PIPER_MODEL_DIR/${EN_MODEL}.onnx" 2>/dev/null || true
        wget -q "$EN_CONFIG_URL" -O "$PIPER_MODEL_DIR/${EN_MODEL}.onnx.json" 2>/dev/null || true
    elif command -v curl &>/dev/null; then
        curl -sL "$EN_MODEL_URL" -o "$PIPER_MODEL_DIR/${EN_MODEL}.onnx" 2>/dev/null || true
        curl -sL "$EN_CONFIG_URL" -o "$PIPER_MODEL_DIR/${EN_MODEL}.onnx.json" 2>/dev/null || true
    fi

    if [ -f "$PIPER_MODEL_DIR/${EN_MODEL}.onnx" ]; then
        echo -e "${GREEN}✓${NC} English male voice installed: Danny (${EN_MODEL})"
    else
        echo -e "${DIM}  English voice skipped (optional)${NC}"
    fi
fi

# ─── Install Termux TTS (fallback) ─────────────────────────
if [ "$IS_TERMUX" = true ]; then
    echo -e "${BOLD}[9/10]${NC} Installing Termux:API (Android device control)..."
    pkg install termux-api -y 2>/dev/null || true
    if command -v termux-tts-speak &>/dev/null; then
        echo -e "${GREEN}✓${NC} termux-tts-speak available"
    else
        echo -e "${YELLOW}⚠${NC} termux-tts-speak not found. Install: ${CYAN}pkg install termux-api${NC}"
    fi

    # Install Termux:API for Android device control
    echo -e "${DIM}  Installing Termux:API for device control...${NC}"
    pkg install termux-api -y 2>/dev/null || true

    # Verify key Termux:API commands
    TERMUX_API_OK=false
    for cmd in termux-battery-status termux-notification termux-flash termux-wifi-connectioninfo; do
        if command -v "$cmd" &>/dev/null; then
            TERMUX_API_OK=true
            break
        fi
    done

    if [ "$TERMUX_API_OK" = true ]; then
        echo -e "${GREEN}✓${NC} Termux:API commands available (battery, flash, notify, wifi, etc.)"
    else
        echo -e "${YELLOW}⚠${NC} Termux:API not fully installed. Android device control may not work."
        echo -e "  Install: ${CYAN}pkg install termux-api${NC}"
        echo -e "  Also install Termux:API app from F-Droid: ${CYAN}https://f-droid.org/packages/com.termux.api/${NC}"
    fi
else
    echo -e "${BOLD}[9/11]${NC} Skipping Termux tools (not Termux)"
fi

# ─── Step 10: Configure API Key ─────────────────────────────
echo -e "${BOLD}[10/10]${NC} API Key configuration..."
echo ""
echo -e "  Get your Mistral API key at:"
echo -e "  ${CYAN}https://console.mistral.ai/${NC}"
echo ""

if [ -n "$MISTRAL_API_KEY" ]; then
    echo -e "${GREEN}✓${NC} MISTRAL_API_KEY already set in environment"
    # Save to .env if not there
    if [ ! -f "$SCRIPT_DIR/.env" ] || ! grep -q "MISTRAL_API_KEY" "$SCRIPT_DIR/.env" 2>/dev/null; then
        echo "MISTRAL_API_KEY=$MISTRAL_API_KEY" >> "$SCRIPT_DIR/.env"
    fi
else
    echo -n "  Enter your Mistral API key (or press Enter to set later): "
    read -r API_KEY_INPUT

    if [ -n "$API_KEY_INPUT" ]; then
        # Save to .env
        echo "MISTRAL_API_KEY=$API_KEY_INPUT" > "$SCRIPT_DIR/.env"
        export MISTRAL_API_KEY="$API_KEY_INPUT"

        # Add to shell profile
        SHELL_RC="$HOME/.bashrc"
        if ! grep -q "MISTRAL_API_KEY" "$SHELL_RC" 2>/dev/null; then
            echo "" >> "$SHELL_RC"
            echo "# JARVIS Agent" >> "$SHELL_RC"
            echo "export MISTRAL_API_KEY=\"$API_KEY_INPUT\"" >> "$SHELL_RC"
        fi

        echo -e "${GREEN}✓${NC} API key saved to .env and $SHELL_RC"
    else
        echo -e "${YELLOW}⚠${NC} No API key set. Set it with:"
        echo -e "  ${CYAN}export MISTRAL_API_KEY=\"your-key-here\"${NC}"
        echo -e "  Or enter it in the web interface on first launch"
    fi
fi

# ─── Final verification ─────────────────────────────────────
echo ""
echo -e "${BOLD}Verification:${NC}"

ERRORS=0

if ! command -v node &>/dev/null; then
    echo -e "${RED}✗${NC} Node.js not found"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓${NC} Node.js $(node -v)"
fi

if [ ! -f "$SCRIPT_DIR/index.js" ]; then
    echo -e "${RED}✗${NC} index.js not found"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓${NC} index.js found"
fi

if [ ! -f "$SCRIPT_DIR/stt.js" ]; then
    echo -e "${RED}✗${NC} stt.js not found"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓${NC} stt.js (Whisper STT module) found"
fi

if [ ! -f "$SCRIPT_DIR/tts.js" ]; then
    echo -e "${RED}✗${NC} tts.js not found"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓${NC} tts.js (Piper TTS module) found"
fi

if [ -f "$WHISPER_BIN" ]; then
    echo -e "${GREEN}✓${NC} Whisper STT binary: $WHISPER_BIN"
else
    echo -e "${YELLOW}⚠${NC} Whisper binary not found (STT will use browser SpeechRecognition fallback)"
fi

if [ -f "$WHISPER_MODEL_DIR/$TINY_MODEL" ]; then
    WSIZE=$(stat -c%s "$WHISPER_MODEL_DIR/$TINY_MODEL" 2>/dev/null || stat -f%z "$WHISPER_MODEL_DIR/$TINY_MODEL" 2>/dev/null || echo "?")
    echo -e "${GREEN}✓${NC} Whisper tiny model: ${TINY_MODEL} (${WSIZE} bytes)"
else
    echo -e "${YELLOW}⚠${NC} Whisper model not found (STT will use browser fallback)"
fi

if [ -f "$PIPER_BIN" ]; then
    echo -e "${GREEN}✓${NC} Piper TTS binary: $PIPER_BIN"
else
    echo -e "${YELLOW}⚠${NC} Piper binary not found (TTS will use browser fallback)"
fi

if [ -f "$PIPER_MODEL_DIR/${ES_MODEL}.onnx" ]; then
    PSIZE=$(stat -c%s "$PIPER_MODEL_DIR/${ES_MODEL}.onnx" 2>/dev/null || stat -f%z "$PIPER_MODEL_DIR/${ES_MODEL}.onnx" 2>/dev/null || echo "?")
    echo -e "${GREEN}✓${NC} Spanish male voice: ${ES_MODEL} (${PSIZE} bytes)"
else
    echo -e "${YELLOW}⚠${NC} Spanish voice not found (download from HuggingFace)"
fi

if command -v ffmpeg &>/dev/null; then
    echo -e "${GREEN}✓${NC} ffmpeg available (audio conversion)"
else
    echo -e "${YELLOW}⚠${NC} ffmpeg not found (needed for server-side STT audio conversion)"
fi

if [ -z "$MISTRAL_API_KEY" ]; then
    echo -e "${YELLOW}⚠${NC} API key not set (required for first run)"
fi

echo ""
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}  JARVIS v4.0 Setup Complete!${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${CYAN}STT: Whisper.cpp (ggml-tiny, multilingual)${NC}"
    echo -e "  ${CYAN}TTS: Piper (es_ES-carlfm-high, Spanish male)${NC}"
    echo -e "  ${CYAN}LLM: Mistral Small (api.mistral.ai)${NC}"
    if [ "$IS_TERMUX" = true ]; then
    echo -e "  ${CYAN}Android: Device control (apps, battery, flash, wifi, sms, calls, etc.)${NC}"
    fi
    echo ""
    echo -e "  ${BOLD}CLI mode (text commands):${NC}"
    echo -e "  ${BOLD}cd $SCRIPT_DIR && node index.js${NC}"
    echo ""
    echo -e "  ${BOLD}Web mode (voice interface):${NC}"
    echo -e "  ${BOLD}cd $SCRIPT_DIR && node index.js --web${NC}"
    echo ""
    echo -e "  Then open ${CYAN}http://localhost:8080${NC} on your phone"
    echo ""
    echo -e "  ${DIM}Pipeline: Voice → Whisper STT → Mistral → Piper TTS → Audio${NC}"
    echo -e "  ${DIM}Fallback: Browser SpeechRecognition/SpeechSynthesis if local models unavailable${NC}"
    echo ""
else
    echo -e "${RED}Setup completed with $ERRORS error(s). Fix them and try again.${NC}"
    exit 1
fi
