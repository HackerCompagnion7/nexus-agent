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

// ─── Load .env file (zero-dependency) ────────────────────────
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
})();

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
  black:   '\x1b[30m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bred:    '\x1b[91m',
  bgreen:  '\x1b[92m',
  byellow: '\x1b[93m',
  bblue:   '\x1b[94m',
  bmagenta:'\x1b[95m',
  bcyan:   '\x1b[96m',
  bwhite:  '\x1b[97m',
  bgBlue:  '\x1b[44m',
  bgMagenta:'\x1b[45m',
  bgBlack: '\x1b[40m',
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

  divider(char = '\u2500', color = C.dim) {
    return color + char.repeat(Math.min(this.width - 2, 60)) + C.reset;
  }
};

// ─── .env Manager ─────────────────────────────────────────────
const EnvManager = {
  envPath: path.join(__dirname, '.env'),

  save(key, value) {
    let content = '';
    if (fs.existsSync(this.envPath)) {
      content = fs.readFileSync(this.envPath, 'utf-8');
    }

    const lines = content.split('\n');
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const existingKey = trimmed.slice(0, eqIdx).trim();
      if (existingKey === key) {
        lines[i] = `${key}=${value}`;
        found = true;
        break;
      }
    }

    if (!found) {
      lines.push(`${key}=${value}`);
    }

    fs.writeFileSync(this.envPath, lines.join('\n') + '\n');
    process.env[key] = value;
  },

  get(key) {
    return process.env[key] || null;
  }
};

// ─── API Key Validator ────────────────────────────────────────
async function validateApiKey(apiKey) {
  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: CONFIG.model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        temperature: 0.1
      })
    });

    if (response.ok) {
      return { valid: true };
    }

    const body = await response.text();
    if (response.status === 403) {
      return { valid: false, error: 'Authorization failed — key is invalid or expired' };
    }
    if (response.status === 429) {
      // Rate limited but key IS valid
      return { valid: true };
    }
    if (response.status === 401) {
      return { valid: false, error: 'Unauthorized — check your API key format' };
    }
    return { valid: false, error: `HTTP ${response.status}: ${body.slice(0, 100)}` };
  } catch (error) {
    // Network error — can't validate, but let it through
    return { valid: true, warning: 'Could not validate key (network error)' };
  }
}

// ─── Agent States ─────────────────────────────────────────────
const AGENT_STATE = {
  INITIALIZING: 'initializing',
  IDLE: 'idle',
  THINKING: 'thinking',
  EXECUTING: 'executing',
  WAITING_INPUT: 'waiting_input',
  NEEDS_API_KEY: 'needs_api_key',
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
      onError: options.onError || (() => {}),
      onNeedsApiKey: options.onNeedsApiKey || (() => {}),
    };

    this.consolidationInterval = null;
    this.consolidationFrequency = options.consolidationFrequency || 5 * 60 * 1000;
  }

  async start() {
    try {
      this._setState(AGENT_STATE.INITIALIZING);

      // ─── API Key Check ────────────────────────────────────
      if (!this.apiKey) {
        this._setState(AGENT_STATE.NEEDS_API_KEY);
        this.eventHandlers.onNeedsApiKey('No API key found');
        return false;
      }

      // ─── Validate API Key ─────────────────────────────────
      this.eventHandlers.onStateChange('validating', AGENT_STATE.INITIALIZING);
      const validation = await validateApiKey(this.apiKey);

      if (!validation.valid) {
        this._setState(AGENT_STATE.NEEDS_API_KEY);
        this.eventHandlers.onNeedsApiKey(validation.error);
        return false;
      }

      // ─── Initialize LLM ───────────────────────────────────
      this.llm = new LLMClient(this.apiKey, { maxTokens: 4096, temperature: 0.7 });

      // ─── Initialize Tools ─────────────────────────────────
      this.tools = new ToolRegistry();
      this.executor = new ToolExecutor({ sandboxDir: this.workingDir, defaultTimeout: 30000 });
      this._connectMemoryTool();

      // ─── Initialize Memory ────────────────────────────────
      this.memory = new MemorySystem(path.join(this.dataDir, 'memory'));
      this.memory.initialize();

      // ─── Initialize Coordinator ───────────────────────────
      this.coordinator = new Coordinator(this.llm, (name, params, opts) =>
        this.executor.execute(name, params, opts), {
        maxWorkers: 2,
        systemPrompt: ''
      });

      this.systemPrompt = this._buildSystemPrompt();
      this.coordinator.systemPrompt = this.systemPrompt;

      // ─── Start Dream Cycle ────────────────────────────────
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

  // ─── Set new API key and restart ────────────────────────
  async setApiKey(newKey) {
    const trimmed = newKey.trim();

    // Basic format check
    if (!trimmed || trimmed.length < 10) {
      return { success: false, error: 'Key too short — must be a valid NVIDIA API key' };
    }

    // Validate against API
    const validation = await validateApiKey(trimmed);

    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Save to .env and memory
    this.apiKey = trimmed;
    EnvManager.save('NVIDIA_API_KEY', trimmed);

    // Now fully initialize
    return await this.start();
  }

  async processMessage(userMessage) {
    // If we need an API key, handle that first
    if (this.state === AGENT_STATE.NEEDS_API_KEY) {
      const result = await this.setApiKey(userMessage);
      if (result === false || result?.success === false) {
        this.eventHandlers.onError(new Error(result?.error || 'Invalid API key'));
        return result?.error || 'Invalid API key. Try again.';
      }
      this.eventHandlers.onMessage('API key validated and saved. Agent is ready.');
      return 'API key validated and saved. Agent is ready.';
    }

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
          onSummarizationNeeded: async () => { this._autoSummarize(); }
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
      // If we get 403 during execution, key became invalid
      if (error.message && error.message.includes('403')) {
        this.apiKey = null;
        EnvManager.save('NVIDIA_API_KEY', '');
        this._setState(AGENT_STATE.NEEDS_API_KEY);
        this.eventHandlers.onNeedsApiKey('API key rejected (403). Enter a new key:');
        return 'API key rejected. Please enter a new NVIDIA API key:';
      }

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
        `${C.cyan}API Key:${C.reset}   ${this.apiKey ? C.bgreen + '\u2713 saved' : C.bred + '\u2717 missing'}${C.reset}`,
      ].join('\n');
    }

    if (cmd === '/apikey') {
      this._setState(AGENT_STATE.NEEDS_API_KEY);
      return `${C.byellow}Enter your new NVIDIA API key:${C.reset}`;
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
        `${C.bcyan}/apikey${C.reset}     Change API key`,
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
      initializing:   `${C.byellow}\u25CB initializing${C.reset}`,
      idle:           `${C.bgreen}\u25CF idle${C.reset}`,
      thinking:       `${C.bcyan}\u25CC thinking${C.reset}`,
      executing:      `${C.bmagenta}\u25CE executing${C.reset}`,
      needs_api_key:  `${C.bred}\u25CF needs API key${C.reset}`,
      error:          `${C.bred}\u25CF error${C.reset}`,
      shutting_down:  `${C.dim}\u25CB shutting down${C.reset}`,
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

${C.dim}  JARVIS v2.0 — Voice + OCR + Persistence${C.reset}
${C.cyan}  Mistral Small 4 \u00B7 NVIDIA API \u00B7 ${env}${C.reset}

${C.dim}${'\u2500'.repeat(Math.min(W - 2, 50))}${C.reset}
`);

  // ─── Create Agent ────────────────────────────────────────
  let isStreaming = false;

  const agent = new NexusAgent({
    dataDir: path.join(__dirname, 'data'),
    workingDir: process.cwd(),
    onStateChange: (newState, oldState) => {
      if (newState === AGENT_STATE.THINKING) {
        process.stdout.write(`\n${C.bcyan}\u25CC Thinking...${C.reset}\n`);
      }
      if (newState === AGENT_STATE.EXECUTING) {
        process.stdout.write(`${C.bmagenta}\u25CE Executing${C.reset}\n`);
      }
      if (newState === AGENT_STATE.NEEDS_API_KEY) {
        process.stdout.write(`\n${C.bred}\u25CF API Key Required${C.reset}\n`);
      }
      if (newState === 'validating') {
        process.stdout.write(`${C.dim}  Validating API key...${C.reset}\r`);
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
    onToolResult: (result) => {
      const icon = result.success ? `${C.bgreen}\u2713${C.reset}` : `${C.bred}\u2717${C.reset}`;
      const time = result.executionTime > 1000
        ? `${(result.executionTime / 1000).toFixed(1)}s`
        : `${result.executionTime}ms`;
      process.stdout.write(`  ${icon} ${C.cyan}${result.name}${C.reset} ${C.dim}${time}${C.reset}\n`);
    },
    onError: (error) => {
      process.stdout.write(`\n${C.bred}\u2717 ${error.message}${C.reset}\n`);
    },
    onMessage: (msg) => {
      if (!isStreaming) {
        process.stdout.write(`${msg}\n`);
      }
    },
    onNeedsApiKey: (reason) => {
      process.stdout.write(`${C.byellow}${reason}${C.reset}\n`);
    }
  });

  // ─── Initialize ──────────────────────────────────────────
  const started = await agent.start();

  if (started) {
    const memStats = agent.memory.getStats();
    process.stdout.write(`${C.bgreen}\u2713${C.reset} Ready  `);
    process.stdout.write(`${C.dim}| ${C.cyan}${memStats.totalFacts}${C.reset} facts  `);
    process.stdout.write(`${C.dim}| ${C.cyan}${CONFIG.model.split('/').pop()}${C.reset}\n`);
    process.stdout.write(`${C.dim}${'\u2500'.repeat(Math.min(W - 2, 50))}${C.reset}\n`);
  } else {
    // Needs API key — show instructions
    process.stdout.write(`\n${C.dim}${'\u2500'.repeat(Math.min(W - 2, 50))}${C.reset}\n`);
    process.stdout.write(`${C.byellow}Get a free NVIDIA API key:${C.reset}\n`);
    process.stdout.write(`${C.cyan}  https://build.nvidia.com/${C.reset}\n`);
    process.stdout.write(`${C.byellow}Then paste it below:${C.reset}\n\n`);
  }

  // ─── REPL ────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: agent.state === AGENT_STATE.NEEDS_API_KEY
      ? `${C.byellow}api-key>${C.reset} `
      : `${C.bmagenta}\u25B8${C.reset} `,
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

      // Update prompt based on state
      if (agent.state === AGENT_STATE.NEEDS_API_KEY) {
        rl.setPrompt(`${C.byellow}api-key>${C.reset} `);
      } else {
        rl.setPrompt(`${C.bmagenta}\u25B8${C.reset} `);
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

  process.stdout.on('resize', () => {
    Term.width = process.stdout.columns || 80;
    Term.height = process.stdout.rows || 24;
  });
}

// ═══════════════════════════════════════════════════════════════
//  WEB SERVER — Mobile interface
// ═══════════════════════════════════════════════════════════════

async function startWebServer(agent, port = 8080) {
  const webDir = path.join(__dirname, 'web');
  const htmlPath = path.join(webDir, 'index.html');

  const server = http.createServer(async (req, res) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Serve web assets
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
      return;
    }

    // Service Worker
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...corsHeaders });
      res.end(fs.readFileSync(path.join(webDir, 'sw.js'), 'utf-8'));
      return;
    }

    // Manifest
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
      res.end(fs.readFileSync(path.join(webDir, 'manifest.json'), 'utf-8'));
      return;
    }

    if (req.url === '/api/chat' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { message } = JSON.parse(body);
          const response = await agent.processMessage(message);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
          res.end(response);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    // New: Set API key from web
    if (req.url === '/api/apikey' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { apikey } = JSON.parse(body);
          const result = await agent.setApiKey(apikey);
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ success: !!result || result?.success, error: result?.error || null }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      return;
    }

    if (req.url === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(agent.getStats()));
      return;
    }

    if (req.url.startsWith('/api/memory') && req.method === 'GET') {
      const url = new URL(req.url, `http://localhost:${port}`);
      const query = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || 'all';
      const results = agent.memory?.query(query, type, 10) || [];
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
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
  /apikey      ${C.dim}Change API key${C.reset}
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

module.exports = { NexusAgent, AGENT_STATE, startCLI, startWebServer, C, Term, EnvManager };
