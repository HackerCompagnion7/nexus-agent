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
const { PiperTTS, VOICES, DEFAULT_VOICE_MAP } = require('./tts');

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
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
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
    this.apiKey = options.apiKey || process.env.MISTRAL_API_KEY;
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
      return { success: false, error: 'Key too short — must be a valid Mistral API key' };
    }

    // Validate against API
    const validation = await validateApiKey(trimmed);

    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Save to .env and memory
    this.apiKey = trimmed;
    EnvManager.save('MISTRAL_API_KEY', trimmed);

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
        EnvManager.save('MISTRAL_API_KEY', '');
        this._setState(AGENT_STATE.NEEDS_API_KEY);
        this.eventHandlers.onNeedsApiKey('API key rejected (403). Enter a new key:');
        return 'API key rejected. Please enter a new Mistral API key:';
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
    const trimmed = message.trim();
    const cmd = trimmed.toLowerCase();
    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();

    // ─── File management commands ─────────────────────────
    if (command === '/ls') {
      const target = parts.slice(1).join(' ') || '.';
      const dirPath = path.resolve(this.workingDir, target);
      try {
        if (!fs.existsSync(dirPath)) return `${C.bred}Directory not found: ${target}${C.reset}`;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        if (entries.length === 0) return `${C.dim}Empty directory${C.reset}`;
        return entries.map(e => {
          const icon = e.isDirectory() ? `${C.bcyan}\uD83D\uDCC1${C.reset}` : `${C.dim}\uD83D\uDCC4${C.reset}`;
          const stat = fs.statSync(path.join(dirPath, e.name));
          const size = e.isFile() ? ` ${C.dim}${formatFileSize(stat.size)}${C.reset}` : '';
          return `  ${icon} ${e.name}${size}`;
        }).join('\n');
      } catch (e) { return `${C.bred}Error: ${e.message}${C.reset}`; }
    }

    if (command === '/cd') {
      const target = parts.slice(1).join(' ');
      if (!target) return `${C.cyan}Current: ${this.workingDir}${C.reset}`;
      const newPath = path.resolve(this.workingDir, target);
      if (!fs.existsSync(newPath) || !fs.statSync(newPath).isDirectory()) {
        return `${C.bred}Not a directory: ${target}${C.reset}`;
      }
      this.workingDir = newPath;
      this.executor.sandboxDir = newPath;
      return `${C.bgreen}Changed to: ${newPath}${C.reset}`;
    }

    if (command === '/cat') {
      const target = parts.slice(1).join(' ');
      if (!target) return `${C.byellow}Usage: /cat <file>${C.reset}`;
      const filePath = path.resolve(this.workingDir, target);
      try {
        if (!fs.existsSync(filePath)) return `${C.bred}File not found: ${target}${C.reset}`;
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > 5000) return content.slice(0, 5000) + `\n${C.dim}... [truncated, ${content.length} chars total]${C.reset}`;
        return content;
      } catch (e) { return `${C.bred}Error: ${e.message}${C.reset}`; }
    }

    if (command === '/rm') {
      const target = parts.slice(1).join(' ');
      if (!target) return `${C.byellow}Usage: /rm <path>${C.reset}`;
      const filePath = path.resolve(this.workingDir, target);
      try {
        if (!fs.existsSync(filePath)) return `${C.bred}Not found: ${target}${C.reset}`;
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          fs.rmdirSync(filePath);
          return `${C.bgreen}Removed empty directory: ${target}${C.reset}`;
        }
        fs.unlinkSync(filePath);
        return `${C.bgreen}Deleted: ${target}${C.reset}`;
      } catch (e) { return `${C.bred}Error: ${e.message}${C.reset}`; }
    }

    if (command === '/mv') {
      const src = parts[1], dst = parts[2];
      if (!src || !dst) return `${C.byellow}Usage: /mv <source> <destination>${C.reset}`;
      const srcPath = path.resolve(this.workingDir, src);
      const dstPath = path.resolve(this.workingDir, dst);
      try {
        if (!fs.existsSync(srcPath)) return `${C.bred}Source not found: ${src}${C.reset}`;
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.renameSync(srcPath, dstPath);
        return `${C.bgreen}Moved: ${src} -> ${dst}${C.reset}`;
      } catch (e) { return `${C.bred}Error: ${e.message}${C.reset}`; }
    }

    if (command === '/find') {
      const pattern = parts.slice(1).join(' ');
      if (!pattern) return `${C.byellow}Usage: /find <pattern>${C.reset}`;
      try {
        const results = [];
        function searchDir(dir, depth) {
          if (depth > 6 || results.length >= 30) return;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (results.length >= 30) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) { searchDir(fullPath, depth + 1); }
            else if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
              const stat = fs.statSync(fullPath);
              results.push(`  ${C.cyan}${path.relative(this.workingDir, fullPath)}${C.reset} ${C.dim}${formatFileSize(stat.size)}${C.reset}`);
            }
          }
        }
        searchDir.call(this, this.workingDir, 0);
        return results.length > 0 ? results.join('\n') : `${C.dim}No files matching "${pattern}"${C.reset}`;
      } catch (e) { return `${C.bred}Error: ${e.message}${C.reset}`; }
    }

    if (command === '/space') {
      try {
        const entries = fs.readdirSync(this.workingDir, { withFileTypes: true });
        let totalSize = 0;
        const items = [];
        for (const entry of entries) {
          const fullPath = path.join(this.workingDir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            if (entry.isFile()) {
              totalSize += stat.size;
              items.push({ name: entry.name, size: stat.size, type: 'file' });
            } else if (entry.isDirectory()) {
              const dirSize = getDirSize(fullPath);
              totalSize += dirSize;
              items.push({ name: entry.name, size: dirSize, type: 'dir' });
            }
          } catch {}
        }
        items.sort((a, b) => b.size - a.size);
        const lines = [
          `${C.bmagenta}${C.bold}Disk Usage: ${this.workingDir}${C.reset}`,
          `${C.cyan}Total:${C.reset} ${formatFileSize(totalSize)}`,
          '',
        ];
        for (const item of items.slice(0, 20)) {
          const icon = item.type === 'dir' ? `${C.bcyan}\uD83D\uDCC1${C.reset}` : `${C.dim}\uD83D\uDCC4${C.reset}`;
          const pct = totalSize > 0 ? ((item.size / totalSize) * 100).toFixed(1) : 0;
          lines.push(`  ${icon} ${item.name}  ${C.dim}${formatFileSize(item.size)} (${pct}%)${C.reset}`);
        }
        return lines.join('\n');
      } catch (e) { return `${C.bred}Error: ${e.message}${C.reset}`; }
    }

    if (command === '/organize') {
      const target = parts.slice(1).join(' ') || '.';
      const dirPath = path.resolve(this.workingDir, target);
      try {
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          return `${C.bred}Not a directory: ${target}${C.reset}`;
        }
        const entries = fs.readdirSync(dirPath, { withFileTypes: true }).filter(e => e.isFile());
        if (entries.length === 0) return `${C.dim}No files to organize${C.reset}`;

        const categories = {
          'Imagenes': ['.jpg','.jpeg','.png','.gif','.bmp','.webp','.svg','.ico'],
          'Videos': ['.mp4','.avi','.mkv','.mov','.wmv','.flv','.webm'],
          'Musica': ['.mp3','.wav','.flac','.aac','.ogg','.m4a','.wma'],
          'Documentos': ['.pdf','.doc','.docx','.txt','.rtf','.odt','.xls','.xlsx','.ppt','.pptx','.csv'],
          'Codigo': ['.js','.ts','.py','.java','.c','.cpp','.h','.rb','.go','.rs','.html','.css','.json','.xml','.yml','.yaml','.sh','.bash'],
          'Archivos': ['.zip','.rar','.7z','.tar','.gz','.bz2','.xz'],
          'APKs': ['.apk','.aab'],
          'Otros': []
        };

        let moved = 0;
        for (const entry of entries) {
          const ext = path.extname(entry.name).toLowerCase();
          let category = 'Otros';
          for (const [cat, exts] of Object.entries(categories)) {
            if (exts.includes(ext)) { category = cat; break; }
          }
          const catDir = path.join(dirPath, category);
          fs.mkdirSync(catDir, { recursive: true });
          const srcPath = path.join(dirPath, entry.name);
          const dstPath = path.join(catDir, entry.name);
          if (!fs.existsSync(dstPath)) {
            fs.renameSync(srcPath, dstPath);
            moved++;
          }
        }
        return `${C.bgreen}Organized ${moved} files into categories${C.reset}`;
      } catch (e) { return `${C.bred}Error: ${e.message}${C.reset}`; }
    }

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
      return `${C.byellow}Enter your new Mistral API key:${C.reset}`;
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
        `${C.bmagenta}${C.bold}JARVIS Commands${C.reset}`,
        '',
        `${C.bcyan}General:${C.reset}`,
        `${C.bcyan}/status${C.reset}      Agent status`,
        `${C.bcyan}/apikey${C.reset}      Change API key`,
        `${C.bcyan}/memory${C.reset}      Memory stats`,
        `${C.bcyan}/consolidate${C.reset}  Run memory consolidation`,
        `${C.bcyan}/clear${C.reset}       Clear conversation history`,
        `${C.bcyan}/help${C.reset}        Show this help`,
        `${C.bcyan}/exit${C.reset}        Exit the agent`,
        '',
        `${C.bcyan}File Management:${C.reset}`,
        `${C.bcyan}/ls${C.reset} [path]   List directory contents`,
        `${C.bcyan}/cd${C.reset} [path]   Change working directory`,
        `${C.bcyan}/cat${C.reset} [file]  Read file contents`,
        `${C.bcyan}/write${C.reset} [f]    Write to file (prompts for content)`,
        `${C.bcyan}/rm${C.reset} [path]   Delete file or empty dir`,
        `${C.bcyan}/mv${C.reset} [s] [d]  Move/rename file`,
        `${C.bcyan}/find${C.reset} [pat]  Search for pattern in files`,
        `${C.bcyan}/space${C.reset}       Show disk usage`,
        `${C.bcyan}/organize${C.reset} [d] Organize directory by file type`,
        '',
        `${C.dim}Or type your task in natural language.${C.reset}`,
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

// ─── File Size Utilities ──────────────────────────────────────
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getDirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) {
          size += fs.statSync(fullPath).size;
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          size += getDirSize(fullPath);
        }
      } catch {}
    }
  } catch {}
  return size;
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

${C.bmagenta}${C.bold}  ╦ ╦╔═╗╔╗ ╔═╗╦ ╦╔═╗╦  ╦  ${C.reset}
${C.bmagenta}${C.bold}  ║║║║╣ ╠╩╗╚═╗╠═╣║╣ ║  ║  ${C.reset}
${C.bmagenta}${C.bold}  ╚╩╝╚═╝╚═╝╚═╝╩ ╩╚═╝╩═╝╩═╝${C.reset}

${C.dim}  Autonomous Voice Agent v2.0${C.reset}
${C.cyan}  Mistral Small \u00B7 api.mistral.ai \u00B7 ${env}${C.reset}

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
    process.stdout.write(`${C.byellow}Get your Mistral API key:${C.reset}\n`);
    process.stdout.write(`${C.cyan}  https://console.mistral.ai/${C.reset}\n`);
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
  const htmlPath = path.join(__dirname, 'web', 'index.html');
  const webDir = path.join(__dirname, 'web');

  // ─── Initialize TTS Engine ──────────────────────────────────
  const tts = new PiperTTS({ baseDir: __dirname });
  if (tts.isAvailable()) {
    console.log(`[JARVIS] TTS: Piper ready — ${tts.defaultVoice}`);
  } else {
    console.log('[JARVIS] TTS: Piper not found (falling back to browser SpeechSynthesis)');
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers
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

    // ─── Static Files (web/) ──────────────────────────────────
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
      return;
    }

    // Serve manifest.json, sw.js from web/
    if (req.url === '/manifest.json' || req.url === '/sw.js') {
      const filePath = path.join(webDir, req.url);
      if (fs.existsSync(filePath)) {
        const contentType = req.url.endsWith('.json') ? 'application/json' : 'application/javascript';
        res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8`, ...corsHeaders });
        res.end(fs.readFileSync(filePath, 'utf-8'));
        return;
      }
    }

    // ─── Chat API ─────────────────────────────────────────────
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

    // ─── TTS API — Server-side Piper voice synthesis ──────────
    if (req.url === '/api/tts' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { text, voice, lang } = JSON.parse(body);
          if (!text || !text.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: 'No text provided' }));
            return;
          }

          if (!tts.isAvailable()) {
            res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: 'TTS not available — Piper not installed', fallback: true }));
            return;
          }

          const wavBuffer = await tts.synthesize(text, { voice, lang });
          res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': wavBuffer.length,
            'Cache-Control': 'no-cache',
            ...corsHeaders
          });
          res.end(wavBuffer);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ error: error.message, fallback: true }));
        }
      });
      return;
    }

    // ─── TTS Voices List ──────────────────────────────────────
    if (req.url === '/api/tts/voices' && req.method === 'GET') {
      const voices = tts.isAvailable() ? tts.getAvailableVoices() : [];
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ available: tts.isAvailable(), voices }));
      return;
    }

    // ─── API Key ──────────────────────────────────────────────
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

    // ─── Status ───────────────────────────────────────────────
    if (req.url === '/api/status' && req.method === 'GET') {
      const stats = agent.getStats();
      stats.tts = tts.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(stats));
      return;
    }

    // ─── Memory Query ─────────────────────────────────────────
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
    console.log(`[JARVIS] Web: http://localhost:${port}`);
    if (tts.isAvailable()) {
      console.log(`[JARVIS] TTS: ${tts.defaultVoice} (Piper)`);
    } else {
      console.log('[JARVIS] TTS: Browser fallback (run install.sh for Piper)');
    }
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
${C.bmagenta}${C.bold}JARVIS${C.reset} \u2014 Autonomous Voice Agent

${C.cyan}Usage:${C.reset}
  node index.js            ${C.dim}Start CLI mode (default)${C.reset}
  node index.js --web      ${C.dim}Start web server (port 8080)${C.reset}
  node index.js --web 3000 ${C.dim}Web server on custom port${C.reset}
  node index.js --help     ${C.dim}Show this help${C.reset}

${C.cyan}Environment:${C.reset}
  MISTRAL_API_KEY  ${C.dim}Required. Get at https://console.mistral.ai/${C.reset}

${C.cyan}CLI Commands:${C.reset}
  /status      ${C.dim}Agent status${C.reset}
  /ls [path]   ${C.dim}List directory${C.reset}
  /cd [path]   ${C.dim}Change directory${C.reset}
  /cat [file]  ${C.dim}Read file${C.reset}
  /rm [path]   ${C.dim}Delete file${C.reset}
  /mv [s] [d]  ${C.dim}Move/rename file${C.reset}
  /find [pat]  ${C.dim}Search files${C.reset}
  /space       ${C.dim}Disk usage${C.reset}
  /organize    ${C.dim}Organize by type${C.reset}
  /apikey      ${C.dim}Change API key${C.reset}
  /memory      ${C.dim}Memory stats${C.reset}
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
