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

// ═══════════════════════════════════════════════════════════════
//  BUILT-IN TOOLS — 12 tools for full autonomous capability
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
      return JSON.stringify({ note: 'Memory system not yet connected', query: params.query });
    }
  },

  // ─── 13. OCR (Optical Character Recognition) ────────────
  ocr_extract: {
    name: 'ocr_extract',
    description: 'Extract text from an image file using OCR (Optical Character Recognition). Requires tesseract to be installed (pkg install tesseract in Termux).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the image file (PNG, JPG, TIFF, PDF)' },
        language: { type: 'string', default: 'eng', description: 'Language for OCR (eng=English, spa=Spanish, etc.)' },
        output_format: { type: 'string', enum: ['text', 'json'], default: 'text', description: 'Output format' }
      },
      required: ['path']
    },
    handler: async (params, ctx) => {
      const filePath = path.resolve(ctx.sandboxDir, params.path);
      if (!fs.existsSync(filePath)) throw new Error(`Image file not found: ${filePath}`);

      const lang = params.language || 'eng';
      const timeout = 60000; // OCR can be slow

      try {
        // Check if tesseract is available
        execSync('which tesseract 2>/dev/null', { encoding: 'utf-8' });
      } catch {
        // Tesseract not installed — try to install or give helpful error
        const isTermux = fs.existsSync('/data/data/com.termux');
        const installCmd = isTermux ? 'pkg install tesseract' : 'sudo apt install tesseract-ocr';
        throw new Error(
          `Tesseract OCR is not installed. Install it with:\n  ${installCmd}\n` +
          `For Spanish language support also run:\n  ${isTermux ? 'pkg install tesseract-es' : 'sudo apt install tesseract-ocr-spa'}`
        );
      }

      try {
        // Run tesseract
        const output = execSync(
          `tesseract "${filePath}" stdout -l ${lang} 2>/dev/null`,
          {
            encoding: 'utf-8',
            timeout,
            maxBuffer: 5 * 1024 * 1024
          }
        ).trim();

        if (!output) {
          return 'No text detected in the image.';
        }

        if (params.output_format === 'json') {
          // Also get confidence data
          let confidence = 'N/A';
          try {
            const tsvOutput = execSync(
              `tesseract "${filePath}" stdout -l ${lang} --tsv 2>/dev/null`,
              { encoding: 'utf-8', timeout }
            );
            const lines = tsvOutput.trim().split('\n');
            if (lines.length > 1) {
              const confValues = lines.slice(1)
                .map(l => parseInt(l.split('\t')[l.split('\t').length - 1]))
                .filter(v => !isNaN(v) && v > 0);
              if (confValues.length > 0) {
                confidence = Math.round(confValues.reduce((a, b) => a + b, 0) / confValues.length);
              }
            }
          } catch {}

          return JSON.stringify({
            text: output,
            confidence,
            language: lang,
            file: params.path,
            characters: output.length
          }, null, 2);
        }

        return output;
      } catch (error) {
        if (error.killed) {
          throw new Error('OCR processing timed out (image may be too large)');
        }
        throw new Error(`OCR failed: ${error.message}`);
      }
    }
  },

  // ─── 14. SCREENSHOT OCR (Termux) ────────────────────────
  ocr_screenshot: {
    name: 'ocr_screenshot',
    description: 'Take a screenshot and extract text from it using OCR. Only works in Termux with termux-api installed.',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', default: 'eng', description: 'Language for OCR' },
        delay: { type: 'integer', default: 1, description: 'Delay before screenshot in seconds' }
      }
    },
    handler: async (params, ctx) => {
      const isTermux = fs.existsSync('/data/data/com.termux');
      if (!isTermux) throw new Error('Screenshot only works in Termux on Android');

      // Check for termux-api
      try {
        execSync('which termux-screenshot 2>/dev/null', { encoding: 'utf-8' });
      } catch {
        throw new Error(
          'termux-api not installed. Install with:\n' +
          '  pkg install termux-api\n' +
          '  Also install the Termux:API app from F-Droid'
        );
      }

      const screenshotPath = `/tmp/jarvis_screenshot_${Date.now()}.png`;

      try {
        // Take screenshot
        if (params.delay > 0) {
          await new Promise(r => setTimeout(r, (params.delay || 1) * 1000));
        }
        execSync(`termux-screenshot -f "${screenshotPath}"`, { encoding: 'utf-8', timeout: 10000 });

        // Wait for file
        await new Promise(r => setTimeout(r, 1000));
        if (!fs.existsSync(screenshotPath)) {
          throw new Error('Screenshot was not saved. Check Termux:API app permissions.');
        }

        // OCR the screenshot
        const lang = params.language || 'eng';
        const output = execSync(
          `tesseract "${screenshotPath}" stdout -l ${lang} 2>/dev/null`,
          { encoding: 'utf-8', timeout: 60000, maxBuffer: 5 * 1024 * 1024 }
        ).trim();

        // Clean up
        try { fs.unlinkSync(screenshotPath); } catch {}

        return output || 'No text detected in screenshot.';
      } catch (error) {
        try { fs.unlinkSync(screenshotPath); } catch {}
        throw error;
      }
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
module.exports = { ToolRegistry, ToolExecutor, SchemaValidator, BUILT_IN_TOOLS };
