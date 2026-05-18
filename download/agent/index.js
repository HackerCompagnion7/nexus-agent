/**
 * ═══════════════════════════════════════════════════════════════
 *  NEXUS — Autonomous Agent Entry Point
 *  State machine, agent loop, CLI interface, and web server
 *  for mobile access. Zero external dependencies.
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

    // Core components (initialized in start())
    this.llm = null;
    this.tools = null;
    this.executor = null;
    this.memory = null;
    this.coordinator = null;
    this.systemPrompt = '';

    // Conversation tracking
    this.conversationHistory = [];
    this.maxConversationLength = 50; // messages before auto-summarization

    // Event handlers
    this.eventHandlers = {
      onStateChange: options.onStateChange || (() => {}),
      onToken: options.onToken || (() => {}),
      onToolResult: options.onToolResult || (() => {}),
      onMessage: options.onMessage || (() => {}),
      onError: options.onError || (() => {})
    };

    // Consolidation interval (dream cycle)
    this.consolidationInterval = null;
    this.consolidationFrequency = options.consolidationFrequency || 5 * 60 * 1000; // 5 min
  }

  // ─── Initialize all subsystems ───────────────────────────
  async start() {
    try {
      this._setState(AGENT_STATE.INITIALIZING);

      // 1. Initialize LLM client
      if (!this.apiKey) {
        throw new Error(
          'NVIDIA_API_KEY not set.\n' +
          'Get a free key at: https://build.nvidia.com/\n' +
          'Then run: export NVIDIA_API_KEY="your-key-here"'
        );
      }
      this.llm = new LLMClient(this.apiKey, {
        maxTokens: 4096,
        temperature: 0.7
      });

      // 2. Initialize tool system
      this.tools = new ToolRegistry();
      this.executor = new ToolExecutor({
        sandboxDir: this.workingDir,
        defaultTimeout: 30000
      });

      // Connect memory_query tool to actual memory
      this._connectMemoryTool();

      // 3. Initialize memory
      this.memory = new MemorySystem(path.join(this.dataDir, 'memory'));
      this.memory.initialize();

      // 4. Initialize coordinator
      this.coordinator = new Coordinator(this.llm, (name, params, opts) =>
        this.executor.execute(name, params, opts), {
        maxWorkers: 2,
        systemPrompt: '' // Set after system prompt load
      });

      // 5. Load and configure system prompt
      this.systemPrompt = this._buildSystemPrompt();

      // Update coordinator's system prompt
      this.coordinator.systemPrompt = this.systemPrompt;

      // 6. Start consolidation cycle
      this.consolidationInterval = setInterval(() => {
        this._runConsolidation();
      }, this.consolidationFrequency);

      // 7. Load user preferences
      const prefs = this.memory.storage.getPreferences();
      if (prefs.instructions.length > 0) {
        console.log(`[Nexus] Loaded ${prefs.instructions.length} user preferences`);
      }

      this._setState(AGENT_STATE.IDLE);
      console.log('[Nexus] Agent initialized and ready.');
      console.log(`[Nexus] Model: ${CONFIG.model}`);
      console.log(`[Nexus] Working dir: ${this.workingDir}`);
      console.log(`[Nexus] Memory: ${this.memory.getStats().totalFacts} facts loaded`);

    } catch (error) {
      this._setState(AGENT_STATE.ERROR);
      this.eventHandlers.onError(error);
      throw error;
    }
  }

  // ─── Process a user message ──────────────────────────────
  async processMessage(userMessage) {
    this._setState(AGENT_STATE.THINKING);

    try {
      // Add to conversation
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
        timestamp: Date.now()
      });

      // Check for meta-commands
      const metaResult = this._handleMetaCommand(userMessage);
      if (metaResult) {
        this._setState(AGENT_STATE.IDLE);
        return metaResult;
      }

      // Build messages with memory context
      const messages = this._buildMessages();

      // Execute agent loop
      this._setState(AGENT_STATE.EXECUTING);

      const result = await this.llm.agentLoop(
        messages,
        this.tools.getToolDefinitions(),
        (name, params, opts) => this.executor.execute(name, params, opts),
        {
          maxIterations: 15,
          stream: true,
          onToken: (token) => this.eventHandlers.onToken(token),
          onToolResult: (result) => {
            this.eventHandlers.onToolResult(result);
          },
          onSummarizationNeeded: async (history, tokens) => {
            console.log(`[Nexus] Context window at ${tokens} tokens, triggering auto-summarization`);
            this._autoSummarize();
          }
        }
      );

      // Add assistant response to history
      this.conversationHistory.push({
        role: 'assistant',
        content: result.content,
        timestamp: Date.now()
      });

      // Extract and store facts from this exchange
      this.memory.extractAndStore(userMessage, result.content);

      // Auto-summarize if conversation is getting long
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

  // ─── Submit a task to the coordinator ────────────────────
  async submitTask(description) {
    const task = await this.coordinator.submit(description);
    const result = await this.coordinator.execute(task, this.tools.getToolDefinitions());
    return result;
  }

  // ─── Build messages array with context ───────────────────
  _buildMessages() {
    const messages = [];

    // System prompt with current memory context
    const memoryContext = this.memory.formatContextForPrompt(
      this.conversationHistory[this.conversationHistory.length - 1]?.content || ''
    );

    const systemContent = this.systemPrompt
      .replace('{{MEMORY_CONTEXT}}', memoryContext || 'No relevant memories found.')
      .replace('{{WORKING_DIR}}', this.workingDir)
      .replace('{{PLATFORM}}', `${os.type()} ${os.arch()}`)
      .replace('{{SESSION_START}}', this.sessionStart);

    messages.push({ role: 'system', content: systemContent });

    // Add conversation history (with sliding window)
    const maxHistoryMessages = 20;
    const historySlice = this.conversationHistory.slice(-maxHistoryMessages);

    for (const msg of historySlice) {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }

    return messages;
  }

  // ─── Build system prompt ─────────────────────────────────
  _buildSystemPrompt() {
    const promptPath = path.join(__dirname, 'system.md');
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8');
    }
    // Fallback system prompt
    return `You are NEXUS, an autonomous AI agent. Execute tasks using the available tools. Follow the plan-execute-verify-report protocol. {{MEMORY_CONTEXT}} Working dir: {{WORKING_DIR}} Platform: {{PLATFORM}} Session: {{SESSION_START}}`;
  }

  // ─── Handle meta-commands ────────────────────────────────
  _handleMetaCommand(message) {
    const cmd = message.trim().toLowerCase();

    if (cmd === '/status' || cmd === '/stats') {
      const stats = this.getStats();
      return `**NEXUS Status**\n` +
        `- State: ${stats.state}\n` +
        `- Model: ${stats.model}\n` +
        `- Memory: ${stats.memory.totalFacts} facts, ${stats.memory.totalSummaries} summaries\n` +
        `- Conversation: ${stats.conversationLength} messages\n` +
        `- API Requests: ${stats.apiRequests}\n` +
        `- Working Dir: ${stats.workingDir}`;
    }

    if (cmd === '/memory') {
      const memStats = this.memory.getStats();
      return `**Memory System**\n` +
        `- Facts: ${memStats.totalFacts}\n` +
        `- Summaries: ${memStats.totalSummaries}\n` +
        `- Active Context: ${memStats.activeContext}\n` +
        `- User Instructions: ${memStats.userInstructions}\n` +
        `- Types: ${JSON.stringify(memStats.memoryTypes)}`;
    }

    if (cmd === '/consolidate') {
      this._runConsolidation();
      return 'Memory consolidation triggered.';
    }

    if (cmd === '/clear') {
      this.conversationHistory = [];
      return 'Conversation history cleared.';
    }

    if (cmd === '/help') {
      return `**NEXUS Commands**\n` +
        `/status  — Show agent status\n` +
        `/memory  — Show memory stats\n` +
        `/consolidate — Run memory consolidation\n` +
        `/clear   — Clear conversation history\n` +
        `/help    — Show this help\n` +
        `/exit    — Exit the agent\n\n` +
        `Or just type your task and I'll execute it.`;
    }

    if (cmd === '/exit' || cmd === '/quit') {
      this.shutdown();
      return 'Goodbye.';
    }

    // Not a meta-command
    return null;
  }

  // ─── Auto-summarize conversation ─────────────────────────
  _autoSummarize() {
    if (this.conversationHistory.length < 6) return;

    const topic = this.conversationHistory
      .filter(m => m.role === 'user')
      .map(m => m.content.slice(0, 50))
      .join(', ');

    this.memory.addSummary(this.conversationHistory, topic);

    // Keep only the most recent messages
    const keepCount = Math.floor(this.maxConversationLength / 2);
    this.conversationHistory = this.conversationHistory.slice(-keepCount);

    console.log('[Nexus] Auto-summarized conversation, history trimmed');
  }

  // ─── Run consolidation cycle ─────────────────────────────
  _runConsolidation() {
    try {
      this.memory.consolidate();
    } catch (error) {
      console.error('[Nexus] Consolidation error:', error.message);
    }
  }

  // ─── Connect memory tool to memory system ────────────────
  _connectMemoryTool() {
    const originalHandler = BUILT_IN_TOOLS.memory_query.handler;
    BUILT_IN_TOOLS.memory_query.handler = async (params) => {
      if (!this.memory) return originalHandler(params);
      const results = this.memory.query(params.query, params.type, params.limit);
      return JSON.stringify(results, null, 2);
    };

    // Add memory_store tool
    this.tools && this.tools.register({
      name: 'memory_store',
      description: 'Store a fact or piece of information in persistent memory for future reference.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact or information to store' },
          type: { type: 'string', enum: ['fact', 'instruction', 'context'], default: 'fact' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], default: 'medium' }
        },
        required: ['content']
      },
      handler: async (params) => {
        const priorityMap = { critical: 0, high: 1, medium: 2, low: 3 };
        this.memory.storeFact({
          content: params.content,
          type: params.type || 'fact',
          priority: priorityMap[params.priority] || 2,
          source: 'agent_stored'
        });
        return `Stored: "${params.content.slice(0, 50)}..."`;
      }
    });
  }

  // ─── State management ────────────────────────────────────
  _setState(newState) {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) {
      this.eventHandlers.onStateChange(newState, oldState);
    }
  }

  // ─── Get comprehensive stats ─────────────────────────────
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

  // ─── Graceful shutdown ───────────────────────────────────
  async shutdown() {
    this._setState(AGENT_STATE.SHUTTING_DOWN);
    console.log('[Nexus] Shutting down...');

    if (this.consolidationInterval) {
      clearInterval(this.consolidationInterval);
    }

    // Final consolidation
    if (this.memory) {
      this._runConsolidation();
    }

    // Save conversation summary
    if (this.conversationHistory.length > 0) {
      this.memory?.addSummary(this.conversationHistory, 'session-end');
    }

    this.coordinator?.stop();
    console.log('[Nexus] Shutdown complete.');
  }
}

// ═══════════════════════════════════════════════════════════════
//  CLI INTERFACE — Interactive terminal mode
// ═══════════════════════════════════════════════════════════════

async function startCLI() {
  console.log(`
╔═══════════════════════════════════════════╗
║                                           ║
║   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗    ║
║   ████╗  ██║██╔════╝╚██╗██╔╝╚██╗ ██╔╝    ║
║   ██╔██╗ ██║█████╗   ╚███╔╝  ╚████╔╝     ║
║   ██║╚██╗██║██╔══╝   ██╔██╗   ╚██╔╝      ║
║   ██║ ╚████║███████╗██╔╝ ██╗   ██║       ║
║   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝   ╚═╝       ║
║                                           ║
║   Autonomous Agent v1.0                   ║
║   Mistral Small · NVIDIA API              ║
║                                           ║
╚═══════════════════════════════════════════╝
  `);

  const agent = new NexusAgent({
    dataDir: path.join(__dirname, 'data'),
    workingDir: process.cwd(),
    onStateChange: (newState, oldState) => {
      if (newState === AGENT_STATE.THINKING) process.stdout.write('\n🧠 ');
      if (newState === AGENT_STATE.EXECUTING) process.stdout.write('⚙️ ');
      if (newState === AGENT_STATE.IDLE) process.stdout.write('\n');
    },
    onToken: (token) => {
      process.stdout.write(token);
    },
    onToolResult: (result) => {
      const icon = result.success ? '✓' : '✗';
      console.log(`  ${icon} ${result.name} (${result.executionTime}ms)`);
    },
    onError: (error) => {
      console.error(`\n❌ Error: ${error.message}`);
    }
  });

  try {
    await agent.start();
  } catch (error) {
    console.error(`\nFatal: ${error.message}`);
    process.exit(1);
  }

  console.log('\nType your task or /help for commands.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ' nexus> '
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    try {
      const response = await agent.processMessage(input);
      if (agent.state !== AGENT_STATE.THINKING && agent.state !== AGENT_STATE.EXECUTING) {
        // Response was already streamed or is a meta-command
        if (!input.startsWith('/')) {
          console.log(); // Add spacing after streamed response
        }
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await agent.shutdown();
    process.exit(0);
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', async () => {
    console.log('\n');
    await agent.shutdown();
    process.exit(0);
  });
}

// ═══════════════════════════════════════════════════════════════
//  WEB SERVER — Mobile interface
// ═══════════════════════════════════════════════════════════════

async function startWebServer(agent, port = 8080) {
  const htmlPath = path.join(__dirname, 'web', 'index.html');

  const server = http.createServer(async (req, res) => {
    // Serve the SPA
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
      return;
    }

    // API: Send message
    if (req.url === '/api/chat' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { message } = JSON.parse(body);
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked'
          });

          const response = await agent.processMessage(message);
          res.end(response);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    // API: Status
    if (req.url === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agent.getStats()));
      return;
    }

    // API: Memory query
    if (req.url.startsWith('/api/memory') && req.method === 'GET') {
      const url = new URL(req.url, `http://localhost:${port}`);
      const query = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || 'all';
      const results = agent.memory.query(query, type, 10);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
      return;
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Nexus] Web interface: http://localhost:${port}`);
  });

  return server;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN — Entry point
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'cli';

  if (mode === '--web' || mode === '-w') {
    // Web server mode
    const port = parseInt(args[1]) || 8080;
    const agent = new NexusAgent({
      dataDir: path.join(__dirname, 'data'),
      workingDir: process.cwd()
    });
    await agent.start();
    await startWebServer(agent, port);
  } else if (mode === '--help' || mode === '-h') {
    console.log(`
NEXUS — Autonomous Agent

Usage:
  node index.js          Start CLI mode (default)
  node index.js --web    Start web server mode (port 8080)
  node index.js --web 3000  Start web server on custom port
  node index.js --help   Show this help

Environment:
  NVIDIA_API_KEY   Required. Get free key at https://build.nvidia.com/

Commands (in CLI):
  /status     Show agent status
  /memory     Show memory stats
  /consolidate  Run memory consolidation
  /clear      Clear conversation history
  /help       Show help
  /exit       Exit
    `);
  } else {
    // CLI mode
    await startCLI();
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { NexusAgent, AGENT_STATE, startCLI, startWebServer };
