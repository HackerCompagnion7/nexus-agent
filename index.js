/**
 * ═══════════════════════════════════════════════════════════════
 *  NEXUS — Autonomous Agent Entry Point
 *  State machine, agent loop, Termux CLI + web server.
 *  Zero external dependencies.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const http = require('http');

const { LLMClient, TokenEstimator, CONFIG } = require('./llm');
const { ToolRegistry, ToolExecutor, BUILT_IN_TOOLS } = require('./tools');
const { MemorySystem } = require('./memory');
const { Coordinator, TASK_STATE } = require('./coordinator');

// ─── ANSI Colors (Termux compatible) ──────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  // Foreground
  black:   '\x1b[30m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  // Bright
  bred:    '\x1b[91m',
  bgreen:  '\x1b[92m',
  byellow: '\x1b[93m',
  bblue:   '\x1b[94m',
  bmagenta:'\x1b[95m',
  bcyan:   '\x1b[96m',
  bwhite:  '\x1b[97m',
  // Background
  bgBlue:  '\x1b[44m',
  bgMagenta:'\x1b[45m',
  bgBlack: '\x1b[40m',
  // Special
  clear:   '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

// ─── Terminal Utilities ────────────────────────────────────────
const Term = {
  isTermux: !!process.env.TERMUX_VERSION || fs.existsSync('/data/data/com.termux'),
  width: process.stdout.columns || 80,
  height: process.stdout.rows || 24,

  supportsColor() {
    return process.env.TERM !== 'dumb' && process.stdout.isTTY;
  },

  wrap(text, maxWidth) {
    maxWidth = maxWidth || (this.width - 4);
    if (maxWidth < 20) maxWidth = 20;
    const words = text.replace(/\x1b\[[0-9;]*m/g, '').split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length > maxWidth) {
        if (line) lines.push(line);
        line = word;
      } else {
        line = line ? line + ' ' + word : word;
      }
    }
    if (line) lines.push(line);
    return lines.join('\n');
  },

  progressBar(current, total, width = 20) {
    const ratio = Math.min(current / total, 1);
    const filled = Math.round(ratio * width);
    const empty = width - filled;
    const bar = C.bmagenta + '\u2588'.repeat(filled) + C.dim + '\u2591'.repeat(empty) + C.reset;
    return `[${bar}] ${Math.round(ratio * 100)}%`;
  },

  divider(char = '\u2500', color = C.dim) {
    return color + char.repeat(Math.min(this.width - 2, 60)) + C.reset;
  }
};

// ─── Agent States ─────────────────────────────────────────────
const AGENT_STATE = {
  INITIALIZING: 'initializing',
  IDLE: 'idle',
  THINKING: 'thinking',
  EXECUTING: 'executing',
  WAITING_INPUT: 'waiting_input',
  ERROR: 'error',
  SHUTTING_DOWN: 'shutting_down'
};

// ─── Nexus Agent ──────────────────────────────────────────────
class NexusAgent {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.NVIDIA_API_KEY;
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this.workingDir = options.workingDir || process.cwd();
    this.state = AGENT_STATE.INITIALIZING;
    this.sessionStart = new Date().toISOString();

    this.llm = null;
    this.tools = null;
    this.executor = null;
    this.memory = null;
    this.coordinator = null;
    this.systemPrompt = '';

    this.conversationHistory = [];
    this.maxConversationLength = 50;

    this.eventHandlers = {
      onStateChange: options.onStateChange || (() => {}),
      onToken: options.onToken || (() => {}),
      onToolResult: options.onToolResult || (() => {}),
      onToolStart: options.onToolStart || (() => {}),
      onMessage: options.onMessage || (() => {}),
      onError: options.onError || (() => {})
    };

    this.consolidationInterval = null;
    this.consolidationFrequency = options.consolidationFrequency || 5 * 60 * 1000;
  }

  async start() {
    try {
      this._setState(AGENT_STATE.INITIALIZING);

      if (!this.apiKey) {
        throw new Error(
          'NVIDIA_API_KEY not set.\n' +
          'Get a free key at: https://build.nvidia.com/\n' +
          'Then run: export NVIDIA_API_KEY="your-key-here"'
        );
      }

      this.llm = new LLMClient(this.apiKey, { maxTokens: 4096, temperature: 0.7 });

      this.tools = new ToolRegistry();
      this.executor = new ToolExecutor({ sandboxDir: this.workingDir, defaultTimeout: 30000 });

      this._connectMemoryTool();

      this.memory = new MemorySystem(path.join(this.dataDir, 'memory'));
      this.memory.initialize();

      this.coordinator = new Coordinator(this.llm, (name, params, opts) =>
        this.executor.execute(name, params, opts), {
        maxWorkers: 2,
        systemPrompt: ''
      });

      this.systemPrompt = this._buildSystemPrompt();
      this.coordinator.systemPrompt = this.systemPrompt;

      this.consolidationInterval = setInterval(() => {
        this._runConsolidation();
      }, this.consolidationFrequency);

      const prefs = this.memory.storage.getPreferences();
      if (prefs.instructions.length > 0) {
        this.eventHandlers.onMessage(`Loaded ${prefs.instructions.length} user preferences`);
      }

      this._setState(AGENT_STATE.IDLE);
      return true;

    } catch (error) {
      this._setState(AGENT_STATE.ERROR);
      this.eventHandlers.onError(error);
      throw error;
    }
  }

  async processMessage(userMessage) {
    this._setState(AGENT_STATE.THINKING);

    try {
      this.conversationHistory.push({ role: 'user', content: userMessage, timestamp: Date.now() });

      const metaResult = this._handleMetaCommand(userMessage);
      if (metaResult) {
        this._setState(AGENT_STATE.IDLE);
        return metaResult;
      }

      const messages = this._buildMessages();
      this._setState(AGENT_STATE.EXECUTING);

      const result = await this.llm.agentLoop(
        messages,
        this.tools.getToolDefinitions(),
        (name, params, opts) => this.executor.execute(name, params, opts),
        {
          maxIterations: 15,
          stream: true,
          onToken: (token) => this.eventHandlers.onToken(token),
          onToolResult: (result) => this.eventHandlers.onToolResult(result),
          onSummarizationNeeded: async (history, tokens) => {
            this._autoSummarize();
          }
        }
      );

      this.conversationHistory.push({ role: 'assistant', content: result.content, timestamp: Date.now() });
      this.memory.extractAndStore(userMessage, result.content);

      if (this.conversationHistory.length > this.maxConversationLength) {
        this._autoSummarize();
      }

      this._setState(AGENT_STATE.IDLE);
      this.eventHandlers.onMessage(result.content);
      return result.content;

    } catch (error) {
      this._setState(AGENT_STATE.ERROR);
      this.eventHandlers.onError(error);
      return `Error: ${error.message}`;
    }
  }

  async submitTask(description) {
    const task = await this.coordinator.submit(description);
    return await this.coordinator.execute(task, this.tools.getToolDefinitions());
  }

  _buildMessages() {
    const messages = [];
    const memoryContext = this.memory.formatContextForPrompt(
      this.conversationHistory[this.conversationHistory.length - 1]?.content || ''
    );

    const systemContent = this.systemPrompt
      .replace('{{MEMORY_CONTEXT}}', memoryContext || 'No relevant memories found.')
      .replace('{{WORKING_DIR}}', this.workingDir)
      .replace('{{PLATFORM}}', `${os.type()} ${os.arch()}`)
      .replace('{{SESSION_START}}', this.sessionStart);

    messages.push({ role: 'system', content: systemContent });

    const maxHistoryMessages = 20;
    const historySlice = this.conversationHistory.slice(-maxHistoryMessages);

    for (const msg of historySlice) {
      messages.push({ role: msg.role, content: msg.content });
    }

    return messages;
  }

  _buildSystemPrompt() {
    const promptPath = path.join(__dirname, 'system.md');
    if (fs.existsSync(promptPath)) return fs.readFileSync(promptPath, 'utf-8');
    return `You are NEXUS, an autonomous AI agent. Execute tasks using available tools. {{MEMORY_CONTEXT}} Working dir: {{WORKING_DIR}} Platform: {{PLATFORM}} Session: {{SESSION_START}}`;
  }

  _handleMetaCommand(message) {
    const cmd = message.trim().toLowerCase();

    if (cmd === '/status' || cmd === '/stats') {
      const s = this.getStats();
      return [
        `${C.bmagenta}${C.bold}NEXUS Status${C.reset}`,
        `${C.cyan}State:${C.reset}     ${this._stateLabel(s.state)}`,
        `${C.cyan}Model:${C.reset}     ${s.model}`,
        `${C.cyan}Memory:${C.reset}    ${s.memory.totalFacts} facts, ${s.memory.totalSummaries} summaries`,
        `${C.cyan}Messages:${C.reset}  ${s.conversationLength}`,
        `${C.cyan}API Calls:${C.reset} ${s.apiRequests}`,
        `${C.cyan}Work Dir:${C.reset}  ${s.workingDir}`,
      ].join('\n');
    }

    if (cmd === '/memory') {
      const m = this.memory.getStats();
      return [
        `${C.bmagenta}${C.bold}Memory System${C.reset}`,
        `${C.cyan}Facts:${C.reset}      ${m.totalFacts}`,
        `${C.cyan}Summaries:${C.reset}  ${m.totalSummaries}`,
        `${C.cyan}Context:${C.reset}    ${m.activeContext} active, ${m.archivedContext} archived`,
        `${C.cyan}Instructions:${C.reset} ${m.userInstructions}`,
      ].join('\n');
    }

    if (cmd === '/consolidate') {
      this._runConsolidation();
      return `${C.bgreen}Memory consolidation triggered.${C.reset}`;
    }

    if (cmd === '/clear') {
      this.conversationHistory = [];
      return `${C.bgreen}Conversation history cleared.${C.reset}`;
    }

    if (cmd === '/help') {
      return [
        `${C.bmagenta}${C.bold}NEXUS Commands${C.reset}`,
        `${C.bcyan}/status${C.reset}     Show agent status`,
        `${C.bcyan}/memory${C.reset}     Show memory stats`,
        `${C.bcyan}/consolidate${C.reset} Run memory consolidation`,
        `${C.bcyan}/clear${C.reset}      Clear conversation history`,
        `${C.bcyan}/help${C.reset}       Show this help`,
        `${C.bcyan}/exit${C.reset}       Exit the agent`,
        '',
        `${C.dim}Or type your task and I'll execute it.${C.reset}`,
      ].join('\n');
    }

    if (cmd === '/exit' || cmd === '/quit') {
      this.shutdown();
      return 'exit';
    }

    return null;
  }

  _stateLabel(state) {
    const labels = {
      initializing: `${C.byellow}\u25CB initializing${C.reset}`,
      idle:         `${C.bgreen}\u25CF idle${C.reset}`,
      thinking:     `${C.bcyan}\u25CC thinking${C.reset}`,
      executing:    `${C.bmagenta}\u25CE executing${C.reset}`,
      error:        `${C.bred}\u25CF error${C.reset}`,
      shutting_down:`${C.dim}\u25CB shutting down${C.reset}`,
    };
    return labels[state] || state;
  }

  _autoSummarize() {
    if (this.conversationHistory.length < 6) return;
    const topic = this.conversationHistory.filter(m => m.role === 'user').map(m => m.content.slice(0, 50)).join(', ');
    this.memory.addSummary(this.conversationHistory, topic);
    const keepCount = Math.floor(this.maxConversationLength / 2);
    this.conversationHistory = this.conversationHistory.slice(-keepCount);
  }

  _runConsolidation() {
    try { this.memory.consolidate(); } catch (e) { /* silent */ }
  }

  _connectMemoryTool() {
    BUILT_IN_TOOLS.memory_query.handler = async (params) => {
      if (!this.memory) return '[]';
      return JSON.stringify(this.memory.query(params.query, params.type, params.limit), null, 2);
    };
  }

  _setState(newState) {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) this.eventHandlers.onStateChange(newState, oldState);
  }

  getStats() {
    return {
      state: this.state,
      model: CONFIG.model,
      conversationLength: this.conversationHistory.length,
      apiRequests: this.llm?.getStats()?.totalRequests || 0,
      workingDir: this.workingDir,
      memory: this.memory?.getStats() || {},
      coordinator: this.coordinator?.getStats() || {},
      uptime: Date.now() - new Date(this.sessionStart).getTime()
    };
  }

  async shutdown() {
    this._setState(AGENT_STATE.SHUTTING_DOWN);
    if (this.consolidationInterval) clearInterval(this.consolidationInterval);
    if (this.memory) this._runConsolidation();
    if (this.conversationHistory.length > 0) this.memory?.addSummary(this.conversationHistory, 'session-end');
    this.coordinator?.stop();
  }
}

// ═══════════════════════════════════════════════════════════════
//  TERMUX CLI — Native terminal experience
// ═══════════════════════════════════════════════════════════════

async function startCLI() {
  const W = Term.width;
  const env = Term.isTermux ? 'Termux/Android' : `${os.type()}/${os.arch()}`;

  // ─── Banner ──────────────────────────────────────────────
  console.log(`
${C.dim}${'\u2500'.repeat(Math.min(W - 2, 50))}${C.reset}

${C.bmagenta}${C.bold}  _   _  _   _  ___  ___  ___  ___  ___ ${C.reset}
${C.bmagenta}${C.bold} | \\ | || \\ | || __)/ __|| __|| _ \\/ __|${C.reset}
${C.bmagenta}${C.bold} |  \\| ||  \\| || _| \\__ \\| _| |   /\\__ \\${C.reset}
${C.bmagenta}${C.bold} |_|\\_||_|\\_|||___||___/|___||_|_\\|___/${C.reset}

${C.dim}  Autonomous Agent v1.0${C.reset}
${C.cyan}  Mistral Small 4 \u00B7 NVIDIA API \u00B7 ${env}${C.reset}

${C.dim}${'\u2500'.repeat(Math.min(W - 2, 50))}${C.reset}
`);

  // ─── Create Agent ────────────────────────────────────────
  let currentLine = '';
  let toolCount = 0;
  let isStreaming = false;

  const agent = new NexusAgent({
    dataDir: path.join(__dirname, 'data'),
    workingDir: process.cwd(),
    onStateChange: (newState, oldState) => {
      if (newState === AGENT_STATE.THINKING) {
        process.stdout.write(`\n${C.bcyan}\u25CC Thinking...${C.reset}\n`);
      }
      if (newState === AGENT_STATE.EXECUTING) {
        toolCount = 0;
        process.stdout.write(`${C.bmagenta}\u25CE Executing${C.reset}\n`);
      }
      if (newState === AGENT_STATE.IDLE && isStreaming) {
        process.stdout.write('\n');
        isStreaming = false;
      }
    },
    onToken: (token) => {
      if (!isStreaming) {
        isStreaming = true;
        process.stdout.write(`${C.bwhite}`);
      }
      process.stdout.write(token);
    },
    onToolStart: (toolName) => {
      toolCount++;
      process.stdout.write(`${C.dim}  \u2192 ${C.cyan}${toolName}${C.dim}...${C.reset}\r`);
    },
    onToolResult: (result) => {
      const icon = result.success ? `${C.bgreen}\u2713${C.reset}` : `${C.bred}\u2717${C.reset}`;
      const time = result.executionTime > 1000
        ? `${(result.executionTime / 1000).toFixed(1)}s`
        : `${result.executionTime}ms`;
      process.stdout.write(`  ${icon} ${C.cyan}${result.name}${C.reset} ${C.dim}${time}${C.reset}  \n`);
    },
    onError: (error) => {
      process.stdout.write(`\n${C.bred}\u2717 ${error.message}${C.reset}\n`);
    },
    onMessage: (msg) => {
      if (!isStreaming) {
        // Non-streamed message (meta-command result)
        process.stdout.write(`${msg}\n`);
      }
    }
  });

  // ─── Initialize ──────────────────────────────────────────
  try {
    process.stdout.write(`${C.dim}  Initializing...${C.reset}\r`);

    await agent.start();

    const memStats = agent.memory.getStats();
    process.stdout.write(`${C.bgreen}\u2713${C.reset} Ready  `);
    process.stdout.write(`${C.dim}| ${C.cyan}${memStats.totalFacts}${C.reset} facts  `);
    process.stdout.write(`${C.dim}| ${C.cyan}${CONFIG.model.split('/').pop()}${C.reset}\n`);
    process.stdout.write(`${C.dim}${'\u2500'.repeat(Math.min(W - 2, 50))}${C.reset}\n`);

  } catch (error) {
    process.stdout.write(`\n${C.bred}\u2717 ${error.message}${C.reset}\n\n`);
    process.exit(1);
  }

  // ─── REPL ────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bmagenta}\u25B8${C.reset} `,
    historySize: 100,
    removeHistoryDuplicates: true
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    try {
      const response = await agent.processMessage(input);

      if (response === 'exit') {
        process.stdout.write(`${C.dim}Goodbye.${C.reset}\n`);
        process.exit(0);
      }
    } catch (error) {
      process.stdout.write(`${C.bred}Error: ${error.message}${C.reset}\n`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await agent.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    process.stdout.write(`\n${C.dim}Shutting down...${C.reset}\n`);
    await agent.shutdown();
    process.exit(0);
  });

  // Handle terminal resize
  process.stdout.on('resize', () => {
    Term.width = process.stdout.columns || 80;
    Term.height = process.stdout.rows || 24;
  });
}

// ═══════════════════════════════════════════════════════════════
//  WEB SERVER — Mobile interface
// ═══════════════════════════════════════════════════════════════

async function startWebServer(agent, port = 8080) {
  const htmlPath = path.join(__dirname, 'web', 'index.html');

  const server = http.createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
      return;
    }

    if (req.url === '/api/chat' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { message } = JSON.parse(body);
          const response = await agent.processMessage(message);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(response);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    if (req.url === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agent.getStats()));
      return;
    }

    if (req.url.startsWith('/api/memory') && req.method === 'GET') {
      const url = new URL(req.url, `http://localhost:${port}`);
      const query = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || 'all';
      const results = agent.memory.query(query, type, 10);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Nexus] Web: http://localhost:${port}`);
  });

  return server;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'cli';

  if (mode === '--web' || mode === '-w') {
    const port = parseInt(args[1]) || 8080;
    const agent = new NexusAgent({
      dataDir: path.join(__dirname, 'data'),
      workingDir: process.cwd()
    });
    await agent.start();
    await startWebServer(agent, port);
  } else if (mode === '--help' || mode === '-h') {
    console.log(`
${C.bmagenta}${C.bold}NEXUS${C.reset} \u2014 Autonomous Agent

${C.cyan}Usage:${C.reset}
  node index.js            ${C.dim}Start CLI mode (default)${C.reset}
  node index.js --web      ${C.dim}Start web server (port 8080)${C.reset}
  node index.js --web 3000 ${C.dim}Web server on custom port${C.reset}
  node index.js --help     ${C.dim}Show this help${C.reset}

${C.cyan}Environment:${C.reset}
  NVIDIA_API_KEY  ${C.dim}Required. Free at https://build.nvidia.com/${C.reset}

${C.cyan}CLI Commands:${C.reset}
  /status      ${C.dim}Agent status${C.reset}
  /memory      ${C.dim}Memory stats${C.reset}
  /consolidate ${C.dim}Run consolidation${C.reset}
  /clear       ${C.dim}Clear history${C.reset}
  /help        ${C.dim}Show help${C.reset}
  /exit        ${C.dim}Exit${C.reset}
`);
  } else {
    await startCLI();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`${C.bred}Fatal: ${err.message}${C.reset}`);
    process.exit(1);
  });
}

module.exports = { NexusAgent, AGENT_STATE, startCLI, startWebServer, C, Term };
