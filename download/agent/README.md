# NEXUS — Autonomous AI Agent

Autonomous agent powered by **Mistral Small** via NVIDIA API. Built for **Termux/Android** with zero external dependencies.

## Quick Start

```bash
# 1. Install
bash install.sh

# 2. Set API key (free at https://build.nvidia.com/)
export NVIDIA_API_KEY="nvapi-your-key"

# 3. Run CLI
node index.js

# 4. Run Web (mobile interface)
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
| `web/index.html` | Mobile PWA — dark theme, touch-optimized |

## CLI Commands

| Command | Description |
|---------|-------------|
| `/status` | Show agent status |
| `/memory` | Show memory stats |
| `/consolidate` | Run memory consolidation |
| `/clear` | Clear conversation history |
| `/help` | Show help |
| `/exit` | Exit |

## Tools

`file_read` · `file_write` · `file_list` · `file_search` · `file_delete` · `file_move` · `shell_exec` · `web_fetch` · `web_search` · `system_info` · `code_eval` · `memory_query`

## Requirements

- Node.js 18+ (zero npm dependencies)
- NVIDIA API key (free)

## License

MIT
