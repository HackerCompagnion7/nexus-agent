# JARVIS — Autonomous Voice AI Agent

Voice-driven autonomous agent powered by **Mistral Small** via Mistral API. Built for **Termux/Android** with zero external dependencies.

## Two Modes

| Mode | How | Interface |
|------|-----|-----------|
| **CLI** | `node index.js` | Escribe comandos y tareas en Termux |
| **Web** | `node index.js --web` | Solo voz — orbe, escuchar, hablar |

## Quick Start

```bash
# 1. Install
bash install.sh

# 2. Set API key (get at https://console.mistral.ai/)
export MISTRAL_API_KEY="your-key"

# 3. Run CLI (escribir comandos)
node index.js

# 4. Run Web (solo voz)
node index.js --web
```

## Architecture

| Module | Description |
|--------|-------------|
| `llm.js` | API shim — streaming, retry, rate limiting, tool call parsing |
| `tools.js` | 12 built-in tools — files, shell, web, code eval |
| `memory.js` | Persistent memory — fact extraction, auto-consolidation |
| `coordinator.js` | Multi-agent — task decomposition, parallel execution |
| `index.js` | State machine — CLI, web server, agent loop |
| `system.md` | System prompt — autonomous agent protocol |
| `web/index.html` | Voice-only PWA — orbe, speech recognition, TTS |

## CLI Commands

| Command | Description |
|---------|-------------|
| `/status` | Show agent status |
| `/apikey` | Change API key |
| `/memory` | Show memory stats |
| `/consolidate` | Run memory consolidation |
| `/clear` | Clear conversation history |
| `/help` | Show help |
| `/exit` | Exit |

## Tools

`file_read` · `file_write` · `file_list` · `file_search` · `file_delete` · `file_move` · `shell_exec` · `web_fetch` · `web_search` · `system_info` · `code_eval` · `memory_query`

## Requirements

- Node.js 18+ (zero npm dependencies)
- Mistral API key (https://console.mistral.ai/)

## License

MIT
