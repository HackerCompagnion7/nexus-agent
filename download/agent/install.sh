#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  NEXUS — Termux Installation Script
#  Zero-dependency setup for Android/Termux
# ═══════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
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
echo -e "${CYAN}║   Autonomous Agent · Termux Setup         ║${NC}"
echo -e "${CYAN}║                                           ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${NC}"
echo ""

# ─── Check if running in Termux ─────────────────────────────
IS_TERMUX=false
if [ -d "/data/data/com.termux" ] || [ -n "$TERMUX_VERSION" ]; then
    IS_TERMUX=true
    echo -e "${YELLOW}[INFO]${NC} Detected Termux environment"
fi

# ─── Step 1: Update packages ────────────────────────────────
echo -e "${BOLD}[1/5]${NC} Updating packages..."
if [ "$IS_TERMUX" = true ]; then
    pkg update -y 2>/dev/null || apt update -y
else
    sudo apt update -y 2>/dev/null || true
fi
echo -e "${GREEN}✓${NC} Packages updated"

# ─── Step 2: Install Node.js ────────────────────────────────
echo -e "${BOLD}[2/5]${NC} Installing Node.js..."
if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v)
    echo -e "${GREEN}✓${NC} Node.js already installed: ${NODE_VERSION}"
else
    if [ "$IS_TERMUX" = true ]; then
        pkg install nodejs -y 2>/dev/null || apt install nodejs -y
    else
        # Install Node.js 20.x LTS
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
echo -e "${BOLD}[3/5]${NC} Setting up project..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Create data directories
mkdir -p "$SCRIPT_DIR/data/memory"

echo -e "${GREEN}✓${NC} Project structure ready"

# ─── Step 5: Configure API Key ──────────────────────────────
echo -e "${BOLD}[4/5]${NC} API Key configuration..."
echo ""
echo -e "  Get your Mistral API key at:"
echo -e "  ${CYAN}https://console.mistral.ai/${NC}"
echo ""

if [ -n "$MISTRAL_API_KEY" ]; then
    echo -e "${GREEN}✓${NC} MISTRAL_API_KEY already set in environment"
else
    echo -n "  Enter your Mistral API key (or press Enter to set later): "
    read -r API_KEY_INPUT

    if [ -n "$API_KEY_INPUT" ]; then
        # Add to shell profile
        SHELL_RC="$HOME/.bashrc"
        if [ "$IS_TERMUX" = true ]; then
            SHELL_RC="$HOME/.bashrc"
        fi

        echo "" >> "$SHELL_RC"
        echo "# NEXUS Agent" >> "$SHELL_RC"
        echo "export MISTRAL_API_KEY=\"$API_KEY_INPUT\"" >> "$SHELL_RC"
        export MISTRAL_API_KEY="$API_KEY_INPUT"

        echo -e "${GREEN}✓${NC} API key saved to $SHELL_RC"
    else
        echo -e "${YELLOW}⚠${NC} No API key set. Set it with:"
        echo -e "  ${CYAN}export MISTRAL_API_KEY=\"your-key-here\"${NC}"
    fi
fi

# ─── Step 6: Final verification ─────────────────────────────
echo ""
echo -e "${BOLD}[5/5]${NC} Verification..."

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

if [ ! -f "$SCRIPT_DIR/llm.js" ]; then
    echo -e "${RED}✗${NC} llm.js not found"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓${NC} llm.js found"
fi

if [ -z "$MISTRAL_API_KEY" ]; then
    echo -e "${YELLOW}⚠${NC} API key not set (required for first run)"
fi

echo ""
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Setup complete!${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo -e "  Start CLI mode:"
    echo -e "  ${CYAN}cd $SCRIPT_DIR && node index.js${NC}"
    echo ""
    echo -e "  Start web mode (mobile interface):"
    echo -e "  ${CYAN}cd $SCRIPT_DIR && node index.js --web${NC}"
    echo ""
    echo -e "  Then open http://localhost:8080 on your phone"
    echo ""
else
    echo -e "${RED}Setup completed with $ERRORS error(s). Fix them and try again.${NC}"
    exit 1
fi
