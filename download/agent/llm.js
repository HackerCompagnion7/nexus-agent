/**
 * ═══════════════════════════════════════════════════════════════
 *  NEXUS LLM SHIM — Enterprise API Adapter
 *  Transforms Mistral's chat completion API into an autonomous
 *  agent-capable interface with streaming, retry logic, rate
 *  limiting, token management, and tool call orchestration.
 * ═══════════════════════════════════════════════════════════════
 *  Zero external dependencies — Node.js 18+ native fetch
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// ─── Configuration ─────────────────────────────────────────────
const CONFIG = {
  baseURL: 'https://integrate.api.nvidia.com/v1',
  model: 'mistralai/mistral-small-4-119b-2603',
  maxRetries: 3,
  retryBaseDelay: 1000,       // ms, exponential backoff base
  rateLimitWindow: 60000,     // 1 minute sliding window
  rateLimitMaxRequests: 40,   // requests per window
  maxTokens: 4096,
  temperature: 0.7,
  topP: 0.9,
  streamTimeout: 30000,       // ms before considering stream stalled
  contextWindow: 32000,       // Mistral Small context window
  reservedForOutput: 1024,    // tokens reserved for model output
  summarizationThreshold: 0.8 // summarize when 80% of context used
};

// ─── Rate Limiter (Token Bucket) ──────────────────────────────
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  async acquire() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const oldestInWindow = this.timestamps[0];
      const waitTime = this.windowMs - (now - oldestInWindow) + 50;
      if (waitTime > 0) {
        await new Promise(r => setTimeout(r, waitTime));
        return this.acquire();
      }
    }

    this.timestamps.push(now);
    return true;
  }
}

// ─── Token Estimator ──────────────────────────────────────────
class TokenEstimator {
  // Rough but fast: ~4 chars per token for English, ~2 for CJK
  static estimate(text) {
    if (!text) return 0;
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars / 2 + otherChars / 4);
  }

  static estimateMessages(messages) {
    return messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + TokenEstimator.estimate(content) + 4; // +4 for message metadata
    }, 0);
  }
}

// ─── Retry with Exponential Backoff ───────────────────────────
class RetryHandler {
  static async execute(fn, maxRetries = CONFIG.maxRetries) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Don't retry on client errors (4xx) except 429 (rate limited)
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
          throw error;
        }

        if (attempt < maxRetries) {
          const delay = CONFIG.retryBaseDelay * Math.pow(2, attempt) + Math.random() * 500;
          console.error(`[LLM] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms — ${error.message}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }
}

// ─── Tool Call Parser ─────────────────────────────────────────
class ToolCallParser {
  /**
   * Parses streaming tool call deltas into complete tool calls.
   * Mistral/NVIDIA returns tool_calls as partial JSON fragments
   * across multiple SSE chunks.
   */
  static mergeDeltas(accumulated, delta) {
    if (!delta.tool_calls) return accumulated;

    const result = accumulated ? [...accumulated] : [];

    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? result.length;
      if (!result[idx]) {
        result[idx] = {
          id: tc.id || '',
          type: 'function',
          function: { name: '', arguments: '' }
        };
      }
      if (tc.id) result[idx].id = tc.id;
      if (tc.function?.name) result[idx].function.name += tc.function.name;
      if (tc.function?.arguments) result[idx].function.arguments += tc.function.arguments;
    }

    return result;
  }

  /**
   * Validates and parses tool call arguments from JSON string.
   */
  static parseArguments(toolCalls) {
    return toolCalls.map(tc => ({
      ...tc,
      function: {
        ...tc.function,
        parsed: (() => {
          try {
            return JSON.parse(tc.function.arguments);
          } catch {
            console.error(`[LLM] Failed to parse tool arguments: ${tc.function.arguments}`);
            return {};
          }
        })()
      }
    }));
  }
}

// ─── Main LLM Client ─────────────────────────────────────────
class LLMClient {
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('[LLM] API key is required. Set NVIDIA_API_KEY env var.');
    this.apiKey = apiKey;
    this.config = { ...CONFIG, ...options };
    this.rateLimiter = new RateLimiter(this.config.rateLimitMaxRequests, this.config.rateLimitWindow);
    this.requestCount = 0;
  }

  // ─── Core Chat Completion ────────────────────────────────
  async chat(messages, tools = [], options = {}) {
    await this.rateLimiter.acquire();

    const body = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      top_p: options.topP ?? this.config.topP,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      stream: false
    };

    if (tools.length > 0) {
      body.tools = this._formatTools(tools);
      body.tool_choice = options.toolChoice || 'auto';
    }

    const requestFn = async () => {
      this.requestCount++;
      const response = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const error = new Error(`API ${response.status}: ${errorBody}`);
        error.status = response.status;
        throw error;
      }

      return response.json();
    };

    const result = await RetryHandler.execute(requestFn);
    return this._processResponse(result);
  }

  // ─── Streaming Chat Completion ───────────────────────────
  async *chatStream(messages, tools = [], options = {}) {
    await this.rateLimiter.acquire();

    const body = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      top_p: options.topP ?? this.config.topP,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      stream: true
    };

    if (tools.length > 0) {
      body.tools = this._formatTools(tools);
      body.tool_choice = options.toolChoice || 'auto';
    }

    const requestFn = async () => {
      this.requestCount++;
      const response = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const error = new Error(`API ${response.status}: ${errorBody}`);
        error.status = response.status;
        throw error;
      }

      return response;
    };

    const response = await RetryHandler.execute(requestFn);
    yield* this._processStream(response);
  }

  // ─── Tool Call Execution Loop ────────────────────────────
  /**
   * The autonomous agent loop:
   * 1. Send messages + tools to model
   * 2. If model requests tool calls → execute them → feed results back
   * 3. Repeat until model returns a final text response
   * 4. Returns the complete conversation including all tool interactions
   */
  async agentLoop(messages, tools, toolExecutor, options = {}) {
    const maxIterations = options.maxIterations || 15;
    const conversationHistory = [...messages];
    const allToolResults = [];

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Check context window usage
      const tokenUsage = TokenEstimator.estimateMessages(conversationHistory);
      const usageRatio = tokenUsage / this.config.contextWindow;

      if (usageRatio > this.config.summarizationThreshold) {
        // Signal to caller that summarization is needed
        if (options.onSummarizationNeeded) {
          await options.onSummarizationNeeded(conversationHistory, tokenUsage);
        }
      }

      // Call model with streaming for real-time output
      let assistantContent = '';
      let toolCalls = null;
      let finishReason = null;

      if (options.stream && options.onToken) {
        // Streaming path
        for await (const chunk of this._chatStreamRaw(conversationHistory, tools, options)) {
          if (chunk.content) {
            assistantContent += chunk.content;
            options.onToken(chunk.content);
          }
          if (chunk.toolCalls) {
            toolCalls = ToolCallParser.mergeDeltas(toolCalls, chunk);
          }
          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }
        }
      } else {
        // Non-streaming path
        const response = await this.chat(conversationHistory, tools, options);
        assistantContent = response.content;
        toolCalls = response.toolCalls;
        finishReason = response.finishReason;
      }

      // Add assistant message to history
      const assistantMsg = { role: 'assistant' };
      if (assistantContent) assistantMsg.content = assistantContent;
      if (toolCalls) {
        assistantMsg.tool_calls = ToolCallParser.parseArguments(toolCalls).map(tc => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        }));
      }
      conversationHistory.push(assistantMsg);

      // If no tool calls, we're done
      if (!toolCalls || toolCalls.length === 0 || finishReason === 'stop') {
        return {
          content: assistantContent,
          conversationHistory,
          toolResults: allToolResults,
          iterations: iteration + 1,
          tokensUsed: TokenEstimator.estimateMessages(conversationHistory)
        };
      }

      // Execute tool calls in parallel
      const parsedCalls = ToolCallParser.parseArguments(toolCalls);
      const toolPromises = parsedCalls.map(async (tc) => {
        const startTime = Date.now();
        try {
          const result = await toolExecutor(
            tc.function.name,
            tc.function.parsed,
            { timeout: options.toolTimeout || 30000 }
          );
          return {
            tool_call_id: tc.id,
            role: 'tool',
            name: tc.function.name,
            content: typeof result === 'string' ? result : JSON.stringify(result),
            executionTime: Date.now() - startTime,
            success: true
          };
        } catch (error) {
          return {
            tool_call_id: tc.id,
            role: 'tool',
            name: tc.function.name,
            content: JSON.stringify({ error: error.message, success: false }),
            executionTime: Date.now() - startTime,
            success: false
          };
        }
      });

      const results = await Promise.all(toolPromises);
      allToolResults.push(...results);

      // Feed results back to conversation
      for (const result of results) {
        conversationHistory.push(result);
        if (options.onToolResult) {
          options.onToolResult(result);
        }
      }
    }

    // Max iterations reached
    return {
      content: assistantContent || 'Max iterations reached without completion.',
      conversationHistory,
      toolResults: allToolResults,
      iterations: maxIterations,
      tokensUsed: TokenEstimator.estimateMessages(conversationHistory),
      truncated: true
    };
  }

  // ─── Internal: Raw stream processing ─────────────────────
  async *_chatStreamRaw(messages, tools, options) {
    await this.rateLimiter.acquire();

    const body = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      top_p: options.topP ?? this.config.topP,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      stream: true
    };

    if (tools.length > 0) {
      body.tools = this._formatTools(tools);
      body.tool_choice = options.toolChoice || 'auto';
    }

    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const error = new Error(`API ${response.status}: ${errorBody}`);
      error.status = response.status;
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let toolCalls = null;
    let stallTimer = null;

    try {
      while (true) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            stallTimer = setTimeout(() => reject(new Error('Stream stalled')), this.config.streamTimeout);
          })
        ]);
        clearTimeout(stallTimer);

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(trimmed.slice(6));
            const choice = data.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (delta?.content) {
              yield { type: 'content', content: delta.content };
            }
            if (delta?.tool_calls) {
              toolCalls = ToolCallParser.mergeDeltas(toolCalls, delta);
              yield { type: 'tool_call_delta', toolCalls: delta.tool_calls };
            }
            if (choice.finish_reason) {
              if (toolCalls) {
                yield { type: 'tool_calls', toolCalls, finishReason: choice.finish_reason };
              }
              yield { type: 'done', finishReason: choice.finish_reason };
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      clearTimeout(stallTimer);
      reader.releaseLock();
    }
  }

  // ─── Internal: Process non-streaming response ────────────
  _processResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) throw new Error('[LLM] No choices in response');

    const message = choice.message;
    return {
      content: message.content || '',
      toolCalls: message.tool_calls || null,
      finishReason: choice.finish_reason,
      usage: data.usage || null,
      model: data.model
    };
  }

  // ─── Internal: Process streaming response ────────────────
  async *_processStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let toolCalls = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));
          const choice = data.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (delta?.content) {
            fullContent += delta.content;
            yield { type: 'token', content: delta.content, fullContent };
          }
          if (delta?.tool_calls) {
            toolCalls = ToolCallParser.mergeDeltas(toolCalls, delta);
          }
          if (choice.finish_reason) {
            yield {
              type: 'complete',
              content: fullContent,
              toolCalls,
              finishReason: choice.finish_reason,
              usage: data.usage
            };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  // ─── Internal: Format tools for Mistral/OpenAI API ───────
  _formatTools(tools) {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  // ─── Utility: Count tokens ───────────────────────────────
  estimateTokens(text) {
    return TokenEstimator.estimate(text);
  }

  // ─── Utility: Get stats ──────────────────────────────────
  getStats() {
    return {
      totalRequests: this.requestCount,
      model: this.config.model,
      contextWindow: this.config.contextWindow,
      maxTokens: this.config.maxTokens
    };
  }
}

// ─── Exports ──────────────────────────────────────────────────
module.exports = { LLMClient, TokenEstimator, RateLimiter, RetryHandler, ToolCallParser, CONFIG };
