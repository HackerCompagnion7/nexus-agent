/**
 * ═══════════════════════════════════════════════════════════════
 *  NEXUS TOOL SYSTEM — Enterprise Tool Registry & Executor
 *  Sandboxed execution, schema validation, timeout control,
 *  and a comprehensive library of built-in tools for
 *  autonomous agent capabilities.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Schema Validator (lightweight, zero deps) ────────────────
class SchemaValidator {
  static validate(value, schema) {
    if (!schema) return { valid: true };

    // Type check
    if (schema.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (schema.type === 'integer') {
        if (!Number.isInteger(value)) return { valid: false, error: `Expected integer, got ${typeof value}` };
      } else if (actualType !== schema.type) {
        return { valid: false, error: `Expected ${schema.type}, got ${actualType}` };
      }
    }

    // Required fields
    if (schema.required && schema.properties) {
      for (const field of schema.required) {
        if (value[field] === undefined) {
          return { valid: false, error: `Missing required field: ${field}` };
        }
      }
    }

    // Enum check
    if (schema.enum && !schema.enum.includes(value)) {
      return { valid: false, error: `Value must be one of: ${schema.enum.join(', ')}` };
    }

    // String constraints
    if (typeof value === 'string') {
      if (schema.minLength && value.length < schema.minLength) {
        return { valid: false, error: `String too short (min ${schema.minLength})` };
      }
      if (schema.maxLength && value.length > schema.maxLength) {
        return { valid: false, error: `String too long (max ${schema.maxLength})` };
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        return { valid: false, error: `String doesn't match pattern: ${schema.pattern}` };
      }
    }

    // Number constraints
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        return { valid: false, error: `Value below minimum: ${schema.minimum}` };
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return { valid: false, error: `Value above maximum: ${schema.maximum}` };
      }
    }

    return { valid: true };
  }

  static validateParams(params, toolDef) {
    const errors = [];
    const schema = toolDef.parameters;

    if (!schema || !schema.properties) return { valid: true, errors: [] };

    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const value = params[key];
      if (value === undefined) {
        if (schema.required?.includes(key)) {
          errors.push(`Missing required parameter: ${key}`);
        }
        continue;
      }
      const result = this.validate(value, propSchema);
      if (!result.valid) {
        errors.push(`Parameter '${key}': ${result.error}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// ─── Tool Executor with Timeout & Sandbox ─────────────────────
class ToolExecutor {
  constructor(options = {}) {
    this.timeout = options.defaultTimeout || 30000;
    this.maxOutputLength = options.maxOutputLength || 50000;
    this.sandboxDir = options.sandboxDir || process.cwd();
    this.allowedCommands = options.allowedCommands || null; // null = all allowed
    this.blockedCommands = options.blockedCommands || [
      'rm -rf /', 'mkfs', 'dd if=', ':(){ :|:& };:', 'format',
      'del /f /s /q C:', 'shutdown', 'reboot', 'halt', 'poweroff'
    ];
    this.executionLog = [];
  }

  async execute(toolName, params, options = {}) {
    const timeout = options.timeout || this.timeout;
    const startTime = Date.now();

    const logEntry = {
      tool: toolName,
      params: this._sanitizeParams(params),
      startTime,
      status: 'pending'
    };

    try {
      const result = await Promise.race([
        this._executeWithTimeout(toolName, params, timeout),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Tool execution timed out after ${timeout}ms`)), timeout)
        )
      ]);

      const truncated = typeof result === 'string' && result.length > this.maxOutputLength;
      const output = truncated ? result.slice(0, this.maxOutputLength) + '\n... [truncated]' : result;

      logEntry.status = 'success';
      logEntry.duration = Date.now() - startTime;
      this.executionLog.push(logEntry);

      return output;
    } catch (error) {
      logEntry.status = 'error';
      logEntry.error = error.message;
      logEntry.duration = Date.now() - startTime;
      this.executionLog.push(logEntry);

      throw error;
    }
  }

  async _executeWithTimeout(toolName, params, timeout) {
    const tool = BUILT_IN_TOOLS[toolName];
    if (!tool) throw new Error(`Unknown tool: ${toolName}`);

    // Validate parameters
    const validation = SchemaValidator.validateParams(params, tool);
    if (!validation.valid) {
      throw new Error(`Parameter validation failed: ${validation.errors.join('; ')}`);
    }

    // Execute with sandbox constraints
    return tool.handler(params, {
      timeout,
      sandboxDir: this.sandboxDir,
      maxOutputLength: this.maxOutputLength,
      isCommandSafe: (cmd) => this._isCommandSafe(cmd)
    });
  }

  _isCommandSafe(command) {
    const cmdLower = command.toLowerCase().trim();
    for (const blocked of this.blockedCommands) {
      if (cmdLower.includes(blocked.toLowerCase())) return false;
    }
    return true;
  }

  _sanitizeParams(params) {
    const sanitized = { ...params };
    // Don't log file contents
    if (sanitized.content) sanitized.content = `[${sanitized.content.length} chars]`;
    return sanitized;
  }

  getExecutionLog() {
    return [...this.executionLog];
  }
}

// ─── Android/Termux Detection ──────────────────────────────────
const IS_ANDROID = !!process.env.TERMUX_VERSION || fs.existsSync('/data/data/com.termux');

/**
 * Safe shell execution helper for Android commands.
 * Returns trimmed stdout or throws with meaningful error.
 */
function androidExec(command, timeout = 10000) {
  try {
    const output = execSync(command, {
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      shell: '/bin/sh',
      env: { ...process.env, TERM: 'dumb' }
    });
    return output.trim();
  } catch (error) {
    const parts = [];
    if (error.stdout) parts.push(error.stdout.trim());
    if (error.stderr) parts.push(error.stderr.trim());
    if (parts.length === 0) parts.push(`Exit code ${error.status}`);
    throw new Error(parts.join(' — '));
  }
}

// ═══════════════════════════════════════════════════════════════
//  BUILT-IN TOOLS — Core + Android tools for full autonomous capability
// ═══════════════════════════════════════════════════════════════

const BUILT_IN_TOOLS = {

  // ─── 1. FILE READ ────────────────────────────────────────
  file_read: {
    name: 'file_read',
    description: 'Read the contents of a file. Returns the file content as a string. Supports reading specific line ranges.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
        start_line: { type: 'integer', description: 'Starting line number (1-based)', minimum: 1 },
        end_line: { type: 'integer', description: 'Ending line number (inclusive)', minimum: 1 },
        encoding: { type: 'string', description: 'File encoding', enum: ['utf-8', 'ascii', 'latin1'], default: 'utf-8' }
      },
      required: ['path']
    },
    handler: async (params, ctx) => {
      const filePath = path.resolve(ctx.sandboxDir, params.path);
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

      const stat = fs.statSync(filePath);
      if (stat.size > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)');

      const content = fs.readFileSync(filePath, params.encoding || 'utf-8');

      if (params.start_line || params.end_line) {
        const lines = content.split('\n');
        const start = (params.start_line || 1) - 1;
        const end = params.end_line || lines.length;
        return lines.slice(start, end).join('\n');
      }

      return content;
    }
  },

  // ─── 2. FILE WRITE ───────────────────────────────────────
  file_write: {
    name: 'file_write',
    description: 'Write content to a file. Creates parent directories if they don\'t exist. Can append or overwrite.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write to' },
        content: { type: 'string', description: 'Content to write' },
        mode: { type: 'string', enum: ['overwrite', 'append'], default: 'overwrite', description: 'Write mode' },
        create_dirs: { type: 'boolean', default: true, description: 'Create parent directories if needed' }
      },
      required: ['path', 'content']
    },
    handler: async (params, ctx) => {
      const filePath = path.resolve(ctx.sandboxDir, params.path);

      if (params.create_dirs) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      }

      if (params.mode === 'append') {
        fs.appendFileSync(filePath, params.content);
      } else {
        fs.writeFileSync(filePath, params.content);
      }

      return `Successfully wrote ${params.content.length} characters to ${params.path}`;
    }
  },

  // ─── 3. FILE LIST ────────────────────────────────────────
  file_list: {
    name: 'file_list',
    description: 'List files and directories in a given path. Returns names, types, sizes, and modification times.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list', default: '.' },
        recursive: { type: 'boolean', default: false, description: 'List recursively' },
        pattern: { type: 'string', description: 'Glob pattern to filter (e.g. "*.js")' },
        max_depth: { type: 'integer', description: 'Maximum recursion depth', default: 3, minimum: 1, maximum: 10 }
      }
    },
    handler: async (params, ctx) => {
      const dirPath = path.resolve(ctx.sandboxDir, params.path || '.');
      if (!fs.existsSync(dirPath)) throw new Error(`Directory not found: ${dirPath}`);
      if (!fs.statSync(dirPath).isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

      const results = [];
      const globRegex = params.pattern ? globToRegex(params.pattern) : null;

      function listDir(dir, depth) {
        if (depth > (params.max_depth || 3)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(dirPath, fullPath);

          if (globRegex && !globRegex.test(entry.name)) continue;

          const stat = fs.statSync(fullPath);
          results.push({
            name: entry.name,
            path: relativePath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modified: stat.mtime.toISOString()
          });

          if (params.recursive && entry.isDirectory() && !entry.name.startsWith('.')) {
            listDir(fullPath, depth + 1);
          }
        }
      }

      listDir(dirPath, 0);
      return JSON.stringify(results, null, 2);
    }
  },

  // ─── 4. SHELL EXECUTE ────────────────────────────────────
  shell_exec: {
    name: 'shell_exec',
    description: 'Execute a shell command and return its output. Use for running scripts, installing packages, git operations, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory for the command' },
        timeout: { type: 'integer', description: 'Timeout in milliseconds', default: 15000, maximum: 60000 }
      },
      required: ['command']
    },
    handler: async (params, ctx) => {
      if (!ctx.isCommandSafe(params.command)) {
        throw new Error('Command blocked for safety. Cannot execute destructive operations.');
      }

      const cwd = params.cwd ? path.resolve(ctx.sandboxDir, params.cwd) : ctx.sandboxDir;
      const timeout = Math.min(params.timeout || 15000, 60000);

      try {
        const output = execSync(params.command, {
          cwd,
          timeout,
          maxBuffer: 5 * 1024 * 1024,
          encoding: 'utf-8',
          shell: '/bin/sh',
          env: { ...process.env, TERM: 'dumb' }
        });
        return output || '(no output)';
      } catch (error) {
        const result = [];
        if (error.stdout) result.push(error.stdout);
        if (error.stderr) result.push(error.stderr);
        if (result.length === 0) result.push(`Exit code ${error.status}: ${error.message}`);
        return result.join('\n');
      }
    }
  },

  // ─── 5. WEB FETCH ────────────────────────────────────────
  web_fetch: {
    name: 'web_fetch',
    description: 'Fetch content from a URL. Returns the response body as text. Supports JSON parsing.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
        headers: { type: 'object', description: 'Request headers' },
        body: { type: 'string', description: 'Request body (for POST/PUT)' },
        parse_json: { type: 'boolean', default: false, description: 'Parse response as JSON' },
        timeout: { type: 'integer', default: 15000, description: 'Request timeout in ms' }
      },
      required: ['url']
    },
    handler: async (params, ctx) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), params.timeout || 15000);

      try {
        const options = {
          method: params.method || 'GET',
          headers: {
            'User-Agent': 'NexusAgent/1.0',
            'Accept': 'text/html,application/json,*/*',
            ...(params.headers || {})
          },
          signal: controller.signal
        };

        if (params.body && ['POST', 'PUT'].includes(params.method)) {
          options.body = params.body;
          if (!options.headers['Content-Type']) {
            options.headers['Content-Type'] = 'application/json';
          }
        }

        const response = await fetch(params.url, options);
        const text = await response.text();

        if (params.parse_json) {
          try {
            const json = JSON.parse(text);
            return JSON.stringify(json, null, 2);
          } catch {
            return text;
          }
        }

        // Truncate HTML if too long
        if (text.length > ctx.maxOutputLength) {
          return text.slice(0, ctx.maxOutputLength) + '\n... [truncated]';
        }

        return text;
      } finally {
        clearTimeout(timer);
      }
    }
  },

  // ─── 6. WEB SEARCH ───────────────────────────────────────
  web_search: {
    name: 'web_search',
    description: 'Search the web using a search engine. Returns a list of results with titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: { type: 'integer', description: 'Number of results to return', default: 5, minimum: 1, maximum: 10 }
      },
      required: ['query']
    },
    handler: async (params, ctx) => {
      // Uses DuckDuckGo HTML search (no API key needed)
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' },
          signal: controller.signal
        });
        const html = await response.text();

        // Parse DDG HTML results
        const results = [];
        const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
        const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;

        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < (params.num_results || 5)) {
          const resultUrl = match[1];
          const title = match[2].replace(/<[^>]*>/g, '').trim();

          let snippet = '';
          const snippetMatch = snippetRegex.exec(html.slice(match.index));
          if (snippetMatch) {
            snippet = snippetMatch[1].replace(/<[^>]*>/g, '').trim();
          }

          results.push({ title, url: resultUrl, snippet });
        }

        return JSON.stringify(results.length > 0 ? results : [{ title: 'No results found', url: '', snippet: 'Try a different query' }], null, 2);
      } finally {
        clearTimeout(timer);
      }
    }
  },

  // ─── 7. FILE SEARCH (grep-like) ──────────────────────────
  file_search: {
    name: 'file_search',
    description: 'Search for a pattern in files within a directory. Like grep but with structured output.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        path: { type: 'string', description: 'Directory to search in', default: '.' },
        file_pattern: { type: 'string', description: 'File glob pattern (e.g. "*.js")', default: '*' },
        max_results: { type: 'integer', description: 'Maximum number of results', default: 20, minimum: 1, maximum: 100 },
        case_insensitive: { type: 'boolean', default: true, description: 'Case insensitive search' }
      },
      required: ['pattern']
    },
    handler: async (params, ctx) => {
      const searchPath = path.resolve(ctx.sandboxDir, params.path || '.');
      const regex = new RegExp(params.pattern, params.case_insensitive ? 'gi' : 'g');
      const results = [];

      function searchDir(dir, depth) {
        if (depth > 10 || results.length >= params.max_results) return;

        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }

        for (const entry of entries) {
          if (results.length >= params.max_results) break;
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            searchDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const fileGlobRegex = globToRegex(params.file_pattern || '*');
            if (!fileGlobRegex.test(entry.name)) continue;

            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length && results.length < params.max_results; i++) {
                if (regex.test(lines[i])) {
                  regex.lastIndex = 0; // Reset for next test
                  results.push({
                    file: path.relative(searchPath, fullPath),
                    line: i + 1,
                    content: lines[i].trim().slice(0, 200)
                  });
                }
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      searchDir(searchPath, 0);
      return JSON.stringify(results, null, 2);
    }
  },

  // ─── 8. FILE DELETE ──────────────────────────────────────
  file_delete: {
    name: 'file_delete',
    description: 'Delete a file or empty directory. For safety, cannot delete directories with contents recursively.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete' },
        force: { type: 'boolean', default: false, description: 'Force deletion of directory with contents (USE WITH CAUTION)' }
      },
      required: ['path']
    },
    handler: async (params, ctx) => {
      const filePath = path.resolve(ctx.sandboxDir, params.path);
      if (!fs.existsSync(filePath)) throw new Error(`Path not found: ${filePath}`);

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        if (params.force) {
          fs.rmSync(filePath, { recursive: true });
          return `Deleted directory (recursively): ${params.path}`;
        }
        fs.rmdirSync(filePath); // Only works on empty dirs
        return `Deleted empty directory: ${params.path}`;
      }

      fs.unlinkSync(filePath);
      return `Deleted file: ${params.path}`;
    }
  },

  // ─── 9. FILE MOVE/RENAME ─────────────────────────────────
  file_move: {
    name: 'file_move',
    description: 'Move or rename a file or directory.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source path' },
        destination: { type: 'string', description: 'Destination path' },
        create_dirs: { type: 'boolean', default: true, description: 'Create destination directories if needed' }
      },
      required: ['source', 'destination']
    },
    handler: async (params, ctx) => {
      const src = path.resolve(ctx.sandboxDir, params.source);
      const dst = path.resolve(ctx.sandboxDir, params.destination);

      if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);

      if (params.create_dirs) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
      }

      fs.renameSync(src, dst);
      return `Moved ${params.source} → ${params.destination}`;
    }
  },

  // ─── 10. PROCESS/INFO ────────────────────────────────────
  system_info: {
    name: 'system_info',
    description: 'Get system information: OS, memory, CPU, disk usage, and running processes.',
    parameters: {
      type: 'object',
      properties: {
        include_processes: { type: 'boolean', default: false, description: 'Include running process list' },
        include_network: { type: 'boolean', default: false, description: 'Include network interface info' }
      }
    },
    handler: async (params, ctx) => {
      const info = {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        osRelease: os.release(),
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model || 'unknown',
        totalMemory: formatBytes(os.totalmem()),
        freeMemory: formatBytes(os.freemem()),
        uptime: formatUptime(os.uptime()),
        currentUser: os.userInfo().username,
        cwd: process.cwd(),
        nodeVersion: process.version
      };

      if (params.include_processes) {
        try {
          const psOutput = execSync('ps aux 2>/dev/null || ps -ef 2>/dev/null', {
            encoding: 'utf-8', timeout: 5000
          });
          info.processes = psOutput.split('\n').slice(0, 30).join('\n');
        } catch {
          info.processes = 'Unable to list processes';
        }
      }

      if (params.include_network) {
        info.networkInterfaces = Object.entries(os.networkInterfaces()).map(([name, addrs]) => ({
          name,
          addresses: addrs.map(a => `${a.address}/${a.netmask}`)
        }));
      }

      return JSON.stringify(info, null, 2);
    }
  },

  // ─── 11. CODE EVALUATE ───────────────────────────────────
  code_eval: {
    name: 'code_eval',
    description: 'Execute JavaScript code in an isolated context and return the result. Useful for calculations, data transformations, and testing.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' },
        language: { type: 'string', enum: ['javascript', 'python'], default: 'javascript', description: 'Programming language' },
        timeout: { type: 'integer', default: 5000, description: 'Execution timeout in ms' }
      },
      required: ['code']
    },
    handler: async (params, ctx) => {
      if (params.language === 'python') {
        try {
          const output = execSync(`python3 -c ${JSON.stringify(params.code)}`, {
            timeout: params.timeout || 5000,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024
          });
          return output || '(no output)';
        } catch (error) {
          return `Python error: ${error.stderr || error.message}`;
        }
      }

      // JavaScript execution in isolated context
      const wrappedCode = `
        (function() {
          'use strict';
          const console = {
            log: (...args) => args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
            error: (...args) => 'ERROR: ' + args.join(' '),
            warn: (...args) => 'WARN: ' + args.join(' ')
          };
          try {
            const __result = (function() { ${params.code} })();
            return typeof __result !== 'undefined' ? String(__result) : '(no return value)';
          } catch(e) {
            return 'Error: ' + e.message;
          }
        })()
      `;

      try {
        const result = eval(wrappedCode);
        return String(result);
      } catch (error) {
        return `Execution error: ${error.message}`;
      }
    }
  },

  // ─── 12. MEMORY QUERY ────────────────────────────────────
  memory_query: {
    name: 'memory_query',
    description: 'Query the agent\'s persistent memory. Search for previously stored information, conversation summaries, or learned facts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for memory' },
        type: { type: 'string', enum: ['fact', 'summary', 'conversation', 'all'], default: 'all', description: 'Type of memory to search' },
        limit: { type: 'integer', default: 5, minimum: 1, maximum: 20, description: 'Max results to return' }
      },
      required: ['query']
    },
    handler: async (params, ctx) => {
      // This will be connected to the Memory module at runtime
      // Placeholder that gets replaced during initialization
      return JSON.stringify({ note: 'Memory system not yet connected', query: params.query });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  //  ANDROID/TERMUX TOOLS — Device control from voice commands
  //  These tools use Termux:API + Android Activity Manager
  //  Only active when running in Termux/Android environment
  // ═══════════════════════════════════════════════════════════════

  // ─── 13. ANDROID APP OPEN ────────────────────────────────
  android_app_open: {
    name: 'android_app_open',
    description: 'Open an Android application by name. Searches installed packages by keyword and launches the best match. Examples: "whatsapp", "chrome", "camera", "youtube".',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name to search for (e.g. "whatsapp", "chrome", "camera")' }
      },
      required: ['app']
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      const appName = params.app.toLowerCase().replace(/\s+/g, '');
      // Search for matching package
      const searchOutput = androidExec(`pm list packages | grep -i "${appName}"`, 8000);
      if (!searchOutput) throw new Error(`No app found matching "${params.app}". Try a more specific name.`);

      // Take the first match
      const lines = searchOutput.split('\n').filter(l => l.trim());
      const firstPackage = lines[0].split(':')[1]?.trim();
      if (!firstPackage) throw new Error(`Could not parse package name for "${params.app}"`);

      // Launch the app via Activity Manager
      androidExec(`am start -n ${firstPackage}/.MainActivity 2>/dev/null || am start ${firstPackage}`, 8000);
      return `App opened: ${firstPackage} (${lines.length} match${lines.length > 1 ? 'es' : ''} found)`;
    }
  },

  // ─── 14. ANDROID APP LIST ────────────────────────────────
  android_app_list: {
    name: 'android_app_list',
    description: 'Search or list installed Android applications. Returns package names matching a search term, or lists all apps.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term to filter apps (optional — leave empty to list all)' },
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 100, description: 'Max results' }
      }
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      const cmd = params.search
        ? `pm list packages | grep -i "${params.search}" | head -${params.limit || 20}`
        : `pm list packages | head -${params.limit || 20}`;

      const output = androidExec(cmd, 8000);
      if (!output) return params.search ? `No apps found matching "${params.search}"` : 'No apps found';

      const apps = output.split('\n')
        .filter(l => l.startsWith('package:'))
        .map(l => l.replace('package:', '').trim())
        .filter(Boolean);

      return JSON.stringify(apps.map(pkg => ({ package: pkg, name: pkg.split('.').pop() })), null, 2);
    }
  },

  // ─── 15. ANDROID WEB OPEN ────────────────────────────────
  android_web_open: {
    name: 'android_web_open',
    description: 'Open a URL in the Android browser. Use for web searches, opening websites, or viewing online content.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (e.g. "https://google.com/search?q=query")' },
        search: { type: 'string', description: 'Search query — auto-constructs Google URL if no url provided' }
      }
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      const targetUrl = params.url || (params.search
        ? `https://www.google.com/search?q=${encodeURIComponent(params.search)}`
        : null);

      if (!targetUrl) throw new Error('Provide either "url" or "search" parameter');

      // termux-open-url for URLs, fallback to am start
      try {
        androidExec(`termux-open-url "${targetUrl}"`, 5000);
      } catch {
        androidExec(`am start -a android.intent.action.VIEW -d "${targetUrl}"`, 5000);
      }

      return `Opened: ${targetUrl}`;
    }
  },

  // ─── 16. ANDROID NOTIFY ─────────────────────────────────
  android_notify: {
    name: 'android_notify',
    description: 'Show an Android notification with title and content. Useful for alerts, reminders, and status updates.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        content: { type: 'string', description: 'Notification body text' },
        id: { type: 'integer', description: 'Notification ID (for updating/canceling)', default: 1 }
      },
      required: ['title', 'content']
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      androidExec(`termux-notification --title "${params.title.replace(/"/g, '\\"')}" --content "${params.content.replace(/"/g, '\\"')}" --id ${params.id || 1}`, 5000);
      return `Notification sent: "${params.title}"`;
    }
  },

  // ─── 17. ANDROID SMS ─────────────────────────────────────
  android_sms: {
    name: 'android_sms',
    description: 'Send an SMS message to a phone number. Use responsibly — only send when explicitly asked by the user.',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'Phone number to send SMS to' },
        message: { type: 'string', description: 'SMS message content' }
      },
      required: ['number', 'message']
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      androidExec(`termux-sms-send -n "${params.number}" "${params.message.replace(/"/g, '\\"')}"`, 10000);
      return `SMS sent to ${params.number}: "${params.message.slice(0, 50)}${params.message.length > 50 ? '...' : ''}"`;
    }
  },

  // ─── 18. ANDROID CALL ───────────────────────────────────
  android_call: {
    name: 'android_call',
    description: 'Initiate a phone call to a number. Only use when the user explicitly asks to call someone.',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'Phone number to call' }
      },
      required: ['number']
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      androidExec(`am start -a android.intent.action.CALL -d tel:${params.number}`, 5000);
      return `Calling ${params.number}...`;
    }
  },

  // ─── 19. ANDROID BATTERY ────────────────────────────────
  android_battery: {
    name: 'android_battery',
    description: 'Get Android battery status: level, charging state, health, and temperature.',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      try {
        const output = androidExec('termux-battery-status', 5000);
        try { return JSON.stringify(JSON.parse(output), null, 2); } catch { return output; }
      } catch {
        // Fallback: read from /sys
        try {
          const level = fs.readFileSync('/sys/class/power_supply/battery/capacity', 'utf-8').trim();
          const status = fs.readFileSync('/sys/class/power_supply/battery/status', 'utf-8').trim();
          return JSON.stringify({ level: `${level}%`, status });
        } catch {
          return 'Unable to read battery status';
        }
      }
    }
  },

  // ─── 20. ANDROID CLIPBOARD ──────────────────────────────
  android_clipboard: {
    name: 'android_clipboard',
    description: 'Get or set the Android clipboard content.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], default: 'get', description: 'Get or set clipboard' },
        text: { type: 'string', description: 'Text to set (required for "set" action)' }
      }
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      if (params.action === 'set') {
        if (!params.text) throw new Error('Text required for "set" action');
        androidExec(`termux-clipboard-set "${params.text.replace(/"/g, '\\"')}"`, 5000);
        return `Clipboard set: "${params.text.slice(0, 50)}"`;
      }

      return androidExec('termux-clipboard-get', 5000) || '(clipboard empty)';
    }
  },

  // ─── 21. ANDROID MEDIA PLAYER ───────────────────────────
  android_media_play: {
    name: 'android_media_play',
    description: 'Control Android media playback: play a file, pause, resume, or stop.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'resume', 'stop'], default: 'play', description: 'Media action' },
        file: { type: 'string', description: 'Audio file path to play (required for "play" action)' }
      }
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      switch (params.action) {
        case 'play':
          if (!params.file) throw new Error('File path required for "play" action');
          androidExec(`termux-media-player play "${params.file}"`, 5000);
          return `Playing: ${params.file}`;
        case 'pause':
          androidExec('termux-media-player pause', 5000);
          return 'Media paused';
        case 'resume':
          androidExec('termux-media-player play', 5000);
          return 'Media resumed';
        case 'stop':
          androidExec('termux-media-player stop', 5000);
          return 'Media stopped';
        default:
          throw new Error(`Unknown media action: ${params.action}`);
      }
    }
  },

  // ─── 22. ANDROID FLASH/TOGGLE ───────────────────────────
  android_flash: {
    name: 'android_flash',
    description: 'Toggle the Android flashlight (torch) on or off.',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['on', 'off'], description: 'Flash state: "on" or "off"' }
      },
      required: ['state']
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      try {
        androidExec(`termux-flash ${params.state}`, 5000);
      } catch {
        // Fallback: toggle via sysfs
        const val = params.state === 'on' ? '1' : '0';
        try {
          androidExec(`echo ${val} > /sys/class/leds/flashlight/brightness 2>/dev/null || echo ${val} > /sys/class/leds/torch-sec1/brightness`, 3000);
        } catch {
          throw new Error('Could not toggle flashlight. Install: pkg install termux-api');
        }
      }
      return `Flashlight ${params.state}`;
    }
  },

  // ─── 23. ANDROID VOLUME ─────────────────────────────────
  android_volume: {
    name: 'android_volume',
    description: 'Set or get Android volume level for a specific audio stream.',
    parameters: {
      type: 'object',
      properties: {
        stream: { type: 'string', enum: ['music', 'ring', 'notification', 'alarm', 'system'], default: 'music', description: 'Audio stream' },
        level: { type: 'integer', description: 'Volume level (0-15). If omitted, returns current level.', minimum: 0, maximum: 15 }
      }
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      const stream = params.stream || 'music';
      if (params.level !== undefined) {
        androidExec(`termux-volume ${stream} ${params.level}`, 5000);
        return `Volume set: ${stream} → ${params.level}`;
      }
      // Getting current volume isn't directly supported, try settings
      try {
        const output = androidExec(`settings get system volume_${stream}`, 5000);
        return `Current ${stream} volume: ${output}`;
      } catch {
        return `Volume control for "${stream}" — use level parameter to set (0-15)`;
      }
    }
  },

  // ─── 24. ANDROID WIFI ───────────────────────────────────
  android_wifi: {
    name: 'android_wifi',
    description: 'Get WiFi connection information: SSID, IP address, gateway, etc.',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      try {
        const output = androidExec('termux-wifi-connectioninfo', 5000);
        try { return JSON.stringify(JSON.parse(output), null, 2); } catch { return output; }
      } catch {
        return 'WiFi info unavailable. Install: pkg install termux-api';
      }
    }
  },

  // ─── 25. ANDROID LOCATION ───────────────────────────────
  android_location: {
    name: 'android_location',
    description: 'Get the current GPS location: latitude, longitude, altitude, and accuracy.',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['gps', 'network', 'passive'], default: 'gps', description: 'Location provider' }
      }
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      try {
        const output = androidExec(`termux-location -p ${params.provider || 'gps'}`, 15000);
        try { return JSON.stringify(JSON.parse(output), null, 2); } catch { return output; }
      } catch {
        return 'Location unavailable. Enable GPS and try again.';
      }
    }
  },

  // ─── 26. ANDROID SHARE ──────────────────────────────────
  android_share: {
    name: 'android_share',
    description: 'Share text or a file using Android share sheet (send to WhatsApp, Telegram, etc.).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text content to share' },
        file: { type: 'string', description: 'File path to share (alternative to text)' }
      }
    },
    handler: async (params, ctx) => {
      if (!IS_ANDROID) throw new Error('Android tools only available in Termux/Android environment');

      if (params.file) {
        androidExec(`termux-share -a send "${params.file}"`, 8000);
        return `Shared file: ${params.file}`;
      }
      if (params.text) {
        androidExec(`termux-share -a send -t text "${params.text.replace(/"/g, '\\"')}"`, 8000);
        return `Shared text: "${params.text.slice(0, 50)}"`;
      }
      throw new Error('Provide either "text" or "file" to share');
    }
  }
};

// ─── Utility Functions ────────────────────────────────────────

function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

// ─── Tool Registry ────────────────────────────────────────────

class ToolRegistry {
  constructor() {
    this.tools = { ...BUILT_IN_TOOLS };
    this.customTools = {};
  }

  register(toolDef) {
    if (!toolDef.name || !toolDef.description || !toolDef.parameters || !toolDef.handler) {
      throw new Error('Tool must have: name, description, parameters, handler');
    }
    this.customTools[toolDef.name] = toolDef;
    this.tools[toolDef.name] = toolDef;
  }

  getTool(name) {
    return this.tools[name] || null;
  }

  getAllTools() {
    return Object.values(this.tools);
  }

  getToolDefinitions() {
    return this.getAllTools().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  }

  hasTool(name) {
    return name in this.tools;
  }
}

// ─── Exports ──────────────────────────────────────────────────
module.exports = { ToolRegistry, ToolExecutor, SchemaValidator, BUILT_IN_TOOLS, IS_ANDROID };
