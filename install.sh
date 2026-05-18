#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  JARVIS — Termux Installation Script
#  Zero-dependency setup for Android/Termux
#  Includes: Node.js, Piper TTS, Spanish male voice
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
echo -e "${CYAN}║   Autonomous Voice Agent v2.0             ║${NC}"
echo -e "${CYAN}║   Piper TTS · Male Voice · Termux         ║${NC}"
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
echo -e "${BOLD}[1/7]${NC} Updating packages..."
if [ "$IS_TERMUX" = true ]; then
    pkg update -y 2>/dev/null || apt update -y
else
    sudo apt update -y 2>/dev/null || true
fi
echo -e "${GREEN}✓${NC} Packages updated"

# ─── Step 2: Install Node.js ────────────────────────────────
echo -e "${BOLD}[2/7]${NC} Installing Node.js..."
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
echo -e "${BOLD}[3/7]${NC} Setting up project..."

mkdir -p "$SCRIPT_DIR/data/memory"
mkdir -p "$SCRIPT_DIR/data/tts-cache"
mkdir -p "$SCRIPT_DIR/models/piper"
mkdir -p "$SCRIPT_DIR/bin/piper"

echo -e "${GREEN}✓${NC} Project structure ready"

# ─── Step 5: Install Piper TTS ──────────────────────────────
echo -e "${BOLD}[4/7]${NC} Installing Piper TTS..."

PIPER_DIR="$SCRIPT_DIR/bin/piper"
PIPER_BIN="$PIPER_DIR/piper"
MODEL_DIR="$SCRIPT_DIR/models/piper"

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

# ─── Step 6: Download voice models ──────────────────────────
echo -e "${BOLD}[5/7]${NC} Downloading voice models (Spanish male)..."

# Spanish male voice — Carlos (high quality)
ES_MODEL="es_ES-carlfm-high"
ES_MODEL_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/carlfm/high/es_ES-carlfm-high.onnx"
ES_CONFIG_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/carlfm/high/es_ES-carlfm-high.onnx.json"

if [ -f "$MODEL_DIR/${ES_MODEL}.onnx" ]; then
    echo -e "${GREEN}✓${NC} Spanish voice already installed: ${ES_MODEL}"
else
    echo -e "${DIM}  Downloading ${ES_MODEL}...${NC}"
    DL_OK=true

    if command -v wget &>/dev/null; then
        wget -q "$ES_MODEL_URL" -O "$MODEL_DIR/${ES_MODEL}.onnx" 2>/dev/null || DL_OK=false
        wget -q "$ES_CONFIG_URL" -O "$MODEL_DIR/${ES_MODEL}.onnx.json" 2>/dev/null || DL_OK=false
    elif command -v curl &>/dev/null; then
        curl -sL "$ES_MODEL_URL" -o "$MODEL_DIR/${ES_MODEL}.onnx" 2>/dev/null || DL_OK=false
        curl -sL "$ES_CONFIG_URL" -o "$MODEL_DIR/${ES_MODEL}.onnx.json" 2>/dev/null || DL_OK=false
    else
        DL_OK=false
    fi

    if [ "$DL_OK" = true ] && [ -f "$MODEL_DIR/${ES_MODEL}.onnx" ]; then
        echo -e "${GREEN}✓${NC} Spanish male voice installed: Carlos (${ES_MODEL})"
    else
        echo -e "${YELLOW}⚠${NC} Voice download failed. Install manually:"
        echo -e "  ${CYAN}$ES_MODEL_URL${NC}"
        echo -e "  ${CYAN}$ES_CONFIG_URL${NC}"
        echo -e "  Save to: ${MODEL_DIR}/"
    fi
fi

# English male voice — Danny (optional)
EN_MODEL="en_US-danny-medium"
EN_MODEL_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/danny-medium/en_US-danny-medium.onnx"
EN_CONFIG_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/danny-medium/en_US-danny-medium.onnx.json"

if [ -f "$MODEL_DIR/${EN_MODEL}.onnx" ]; then
    echo -e "${GREEN}✓${NC} English voice already installed: ${EN_MODEL}"
else
    echo -e "${DIM}  Downloading ${EN_MODEL} (English, optional)...${NC}"
    if command -v wget &>/dev/null; then
        wget -q "$EN_MODEL_URL" -O "$MODEL_DIR/${EN_MODEL}.onnx" 2>/dev/null || true
        wget -q "$EN_CONFIG_URL" -O "$MODEL_DIR/${EN_MODEL}.onnx.json" 2>/dev/null || true
    elif command -v curl &>/dev/null; then
        curl -sL "$EN_MODEL_URL" -o "$MODEL_DIR/${EN_MODEL}.onnx" 2>/dev/null || true
        curl -sL "$EN_CONFIG_URL" -o "$MODEL_DIR/${EN_MODEL}.onnx.json" 2>/dev/null || true
    fi

    if [ -f "$MODEL_DIR/${EN_MODEL}.onnx" ]; then
        echo -e "${GREEN}✓${NC} English male voice installed: Danny (${EN_MODEL})"
    else
        echo -e "${DIM}  English voice skipped (optional)${NC}"
    fi
fi

# ─── Step 7: Install Termux TTS (fallback) ──────────────────
if [ "$IS_TERMUX" = true ]; then
    echo -e "${BOLD}[6/7]${NC} Installing Termux TTS (fallback)..."
    pkg install termux-api -y 2>/dev/null || true
    if command -v termux-tts-speak &>/dev/null; then
        echo -e "${GREEN}✓${NC} termux-tts-speak available"
    else
        echo -e "${YELLOW}⚠${NC} termux-tts-speak not found. Install: ${CYAN}pkg install termux-api${NC}"
    fi
else
    echo -e "${BOLD}[6/7]${NC} Skipping Termux TTS (not Termux)"
fi

# ─── Step 8: Configure API Key ──────────────────────────────
echo -e "${BOLD}[7/7]${NC} API Key configuration..."
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

if [ ! -f "$SCRIPT_DIR/tts.js" ]; then
    echo -e "${RED}✗${NC} tts.js not found"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓${NC} tts.js (Piper TTS module) found"
fi

if [ -f "$PIPER_BIN" ]; then
    echo -e "${GREEN}✓${NC} Piper TTS binary: $PIPER_BIN"
else
    echo -e "${YELLOW}⚠${NC} Piper binary not found (TTS will use browser fallback)"
fi

if [ -f "$MODEL_DIR/${ES_MODEL}.onnx" ]; then
    MODEL_SIZE=$(stat -c%s "$MODEL_DIR/${ES_MODEL}.onnx" 2>/dev/null || stat -f%z "$MODEL_DIR/${ES_MODEL}.onnx" 2>/dev/null || echo "?")
    echo -e "${GREEN}✓${NC} Spanish male voice: ${ES_MODEL} (${MODEL_SIZE} bytes)"
else
    echo -e "${YELLOW}⚠${NC} Spanish voice not found (download from HuggingFace)"
fi

if [ -z "$MISTRAL_API_KEY" ]; then
    echo -e "${YELLOW}⚠${NC} API key not set (required for first run)"
fi

echo ""
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}  JARVIS Setup Complete!${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${CYAN}CLI mode (text commands):${NC}"
    echo -e "  ${BOLD}cd $SCRIPT_DIR && node index.js${NC}"
    echo ""
    echo -e "  ${CYAN}Web mode (voice interface):${NC}"
    echo -e "  ${BOLD}cd $SCRIPT_DIR && node index.js --web${NC}"
    echo ""
    echo -e "  Then open ${CYAN}http://localhost:8080${NC} on your phone"
    echo ""
    echo -e "  ${DIM}Voice: es_ES-carlfm-high (Spanish male, Piper TTS)${NC}"
    echo -e "  ${DIM}Fallback: Browser SpeechSynthesis if Piper unavailable${NC}"
    echo ""
else
    echo -e "${RED}Setup completed with $ERRORS error(s). Fix them and try again.${NC}"
    exit 1
fi
