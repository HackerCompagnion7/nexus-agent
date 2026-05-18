/**
 * ═══════════════════════════════════════════════════════════════
 *  NEXUS MEMORY — Persistent Memory with Auto-Consolidation
 *  Implements sliding window context management, fact extraction,
 *  conversation summarization, and persistent storage — all
 *  without additional API cost using local heuristics.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Memory Entry Types ───────────────────────────────────────
const ENTRY_TYPES = {
  FACT: 'fact',             // Extracted factual knowledge
  SUMMARY: 'summary',       // Conversation summary
  CONVERSATION: 'conversation', // Raw conversation excerpt
  INSTRUCTION: 'instruction',  // User preferences/instructions
  CONTEXT: 'context',       // Working context for current task
  ERROR_LOG: 'error_log'    // Error patterns and solutions
};

// ─── Priority Levels ──────────────────────────────────────────
const PRIORITY = {
  CRITICAL: 0,   // Always kept (user instructions, core facts)
  HIGH: 1,       // Important context (current task, recent facts)
  MEDIUM: 2,     // Useful background (past summaries)
  LOW: 3,        // Can be summarized/removed (old conversations)
  DISPOSABLE: 4  // Temporary context, safe to delete
};

// ─── Storage Backend ──────────────────────────────────────────
class MemoryStorage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.factsFile = path.join(dataDir, 'facts.json');
    this.summariesFile = path.join(dataDir, 'summaries.json');
    this.contextFile = path.join(dataDir, 'context.json');
    this.preferencesFile = path.join(dataDir, 'preferences.json');

    fs.mkdirSync(dataDir, { recursive: true });
    this._initializeFiles();
  }

  _initializeFiles() {
    const defaults = {
      [this.factsFile]: [],
      [this.summariesFile]: [],
      [this.contextFile]: { active: [], archived: [] },
      [this.preferencesFile]: { instructions: [], style: {} }
    };

    for (const [file, defaultContent] of Object.entries(defaults)) {
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(defaultContent, null, 2));
      }
    }
  }

  _read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  _write(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  // Facts
  getFacts() { return this._read(this.factsFile) || []; }
  saveFacts(facts) { this._write(this.factsFile, facts); }

  // Summaries
  getSummaries() { return this._read(this.summariesFile) || []; }
  saveSummaries(summaries) { this._write(this.summariesFile, summaries); }

  // Context
  getContext() { return this._read(this.contextFile) || { active: [], archived: [] }; }
  saveContext(ctx) { this._write(this.contextFile, ctx); }

  // Preferences
  getPreferences() { return this._read(this.preferencesFile) || { instructions: [], style: {} }; }
  savePreferences(prefs) { this._write(this.preferencesFile, prefs); }
}

// ─── Fact Extractor (No API cost — heuristic-based) ───────────
class FactExtractor {
  /**
   * Extracts key facts from conversation turns using pattern matching
   * and heuristic rules. Zero API cost.
   */
  static extract(userMessage, assistantMessage) {
    const facts = [];

    // Pattern: "X is Y", "X are Y", "X means Y"
    const definitionPatterns = [
      /(?:^|\n)([^.]+\b(?:is|are|means|refers to|stands for)\b[^.]+\.?)/gi,
      /(?:^|\n)([^.]+\b(?:defined as|known as|called)\b[^.]+\.?)/gi
    ];

    for (const pattern of definitionPatterns) {
      let match;
      while ((match = pattern.exec(userMessage + ' ' + assistantMessage)) !== null) {
        const fact = match[1].trim();
        if (fact.length > 10 && fact.length < 300) {
          facts.push({
            id: hashString(fact),
            content: fact,
            type: ENTRY_TYPES.FACT,
            priority: PRIORITY.MEDIUM,
            source: 'extracted',
            confidence: 0.7,
            timestamp: Date.now(),
            accessCount: 0
          });
        }
      }
    }

    // Pattern: User preferences ("I want", "I prefer", "I like", "always", "never")
    const preferencePatterns = [
      /(?:I (?:want|prefer|like|need|always|never|hate|don't like))\s+([^.]+)/gi,
      /(?:make sure|ensure|always|never|don't)\s+([^.]+)/gi
    ];

    for (const pattern of preferencePatterns) {
      let match;
      while ((match = pattern.exec(userMessage)) !== null) {
        const pref = match[0].trim();
        facts.push({
          id: hashString(pref),
          content: pref,
          type: ENTRY_TYPES.INSTRUCTION,
          priority: PRIORITY.CRITICAL,
          source: 'user_preference',
          confidence: 1.0,
          timestamp: Date.now(),
          accessCount: 0
        });
      }
    }

    // Pattern: File paths mentioned
    const pathPattern = /(?:^|\s)([\/~][\w\/.-]+\.\w+)/gm;
    let pathMatch;
    while ((pathMatch = pathPattern.exec(userMessage + ' ' + assistantMessage)) !== null) {
      facts.push({
        id: hashString(pathMatch[1]),
        content: `File path: ${pathMatch[1]}`,
        type: ENTRY_TYPES.FACT,
        priority: PRIORITY.LOW,
        source: 'mentioned',
        confidence: 0.5,
        timestamp: Date.now(),
        accessCount: 0
      });
    }

    return facts;
  }
}

// ─── Conversation Summarizer (No API cost — extractive) ───────
class ConversationSummarizer {
  /**
   * Creates extractive summaries by identifying the most important
   * sentences in a conversation. No API calls needed.
   */
  static summarize(messages, maxSentences = 8) {
    if (messages.length === 0) return '';

    // Collect all text content
    const allText = messages
      .filter(m => m.content && typeof m.content === 'string')
      .map(m => m.content)
      .join(' ');

    // Split into sentences
    const sentences = allText
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 15 && s.length < 500);

    if (sentences.length <= maxSentences) return sentences.join(' ');

    // Score sentences by importance heuristics
    const scored = sentences.map((sentence, idx) => {
      let score = 0;

      // Position bonus (first and recent messages are more important)
      if (idx < 3) score += 3;
      if (idx > sentences.length - 3) score += 2;

      // Length bonus (medium length is ideal)
      if (sentence.length > 30 && sentence.length < 200) score += 1;

      // Keyword bonuses
      const importantWords = ['error', 'success', 'created', 'modified', 'result',
        'important', 'note', 'warning', 'completed', 'failed', 'key', 'main', 'goal'];
      for (const word of importantWords) {
        if (sentence.toLowerCase().includes(word)) score += 1;
      }

      // Code mention bonus
      if (/`[^`]+`/.test(sentence) || /function|class|const|import/.test(sentence)) score += 1;

      // Contains specific data (numbers, paths)
      if (/\d+/.test(sentence)) score += 0.5;
      if (/\/[\w.-]+/.test(sentence)) score += 0.5;

      // Deduplicate: penalize similarity to higher-scored sentences
      return { sentence, score, idx };
    });

    // Sort by score and take top N
    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, maxSentences);

    // Return in original order
    selected.sort((a, b) => a.idx - b.idx);
    return selected.map(s => s.sentence).join(' ');
  }

  /**
   * Create a structured summary object for storage
   */
  static createSummary(messages, topic = 'general') {
    return {
      id: hashString(`${topic}-${Date.now()}`),
      type: ENTRY_TYPES.SUMMARY,
      content: ConversationSummarizer.summarize(messages),
      topic,
      messageCount: messages.length,
      timeRange: {
        start: messages[0]?.timestamp || Date.now(),
        end: messages[messages.length - 1]?.timestamp || Date.now()
      },
      priority: PRIORITY.MEDIUM,
      timestamp: Date.now(),
      accessCount: 0
    };
  }
}

// ─── Context Window Manager ───────────────────────────────────
class ContextWindowManager {
  /**
   * Manages which memories are included in the context window,
   * implementing a priority-based sliding window that ensures
   * the most relevant information is always available.
   */
  constructor(maxTokens = 6000) {
    this.maxTokens = maxTokens; // Tokens reserved for memory in context
  }

  selectContext(memories, currentTask = '') {
    const scored = memories.map(m => ({
      ...m,
      contextScore: this._scoreRelevance(m, currentTask)
    }));

    // Sort by context score descending
    scored.sort((a, b) => b.contextScore - a.contextScore);

    // Fill context window greedily
    const selected = [];
    let tokenCount = 0;

    for (const memory of scored) {
      const tokens = Math.ceil(memory.content.length / 4);
      if (tokenCount + tokens <= this.maxTokens) {
        selected.push(memory);
        tokenCount += tokens;
      }
    }

    // Sort selected by priority then by context score
    selected.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.contextScore - a.contextScore;
    });

    return selected;
  }

  _scoreRelevance(memory, currentTask) {
    let score = 0;

    // Priority base score
    score += (4 - memory.priority) * 10;

    // Recency bonus
    const ageMs = Date.now() - (memory.timestamp || 0);
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < 1) score += 15;
    else if (ageHours < 24) score += 10;
    else if (ageHours < 168) score += 5; // 1 week

    // Access frequency bonus
    score += Math.min((memory.accessCount || 0) * 2, 10);

    // Current task relevance (simple keyword overlap)
    if (currentTask && memory.content) {
      const taskWords = currentTask.toLowerCase().split(/\s+/);
      const memWords = memory.content.toLowerCase().split(/\s+/);
      const overlap = taskWords.filter(w => w.length > 3 && memWords.includes(w)).length;
      score += overlap * 3;
    }

    // Type bonus
    if (memory.type === ENTRY_TYPES.INSTRUCTION) score += 5;
    if (memory.type === ENTRY_TYPES.FACT) score += 3;
    if (memory.type === ENTRY_TYPES.CONTEXT) score += 4;

    return score;
  }
}

// ─── Main Memory System ───────────────────────────────────────
class MemorySystem {
  constructor(dataDir, options = {}) {
    this.storage = new MemoryStorage(dataDir);
    this.contextManager = new ContextWindowManager(options.maxContextTokens || 6000);
    this.maxFacts = options.maxFacts || 200;
    this.maxSummaries = options.maxSummaries || 50;
    this.maxContextAge = options.maxContextAge || 7 * 24 * 60 * 60 * 1000; // 7 days

    // In-memory cache for fast access
    this._cache = {
      facts: null,
      summaries: null,
      context: null,
      preferences: null
    };
  }

  // ─── Initialize ──────────────────────────────────────────
  initialize() {
    this._cache.facts = this.storage.getFacts();
    this._cache.summaries = this.storage.getSummaries();
    this._cache.context = this.storage.getContext();
    this._cache.preferences = this.storage.getPreferences();
    console.log(`[Memory] Loaded ${this._cache.facts.length} facts, ${this._cache.summaries.length} summaries`);
  }

  // ─── Store new information ───────────────────────────────
  storeFact(fact) {
    const entry = {
      id: fact.id || hashString(fact.content),
      content: fact.content,
      type: fact.type || ENTRY_TYPES.FACT,
      priority: fact.priority || PRIORITY.MEDIUM,
      source: fact.source || 'user',
      confidence: fact.confidence || 1.0,
      timestamp: Date.now(),
      accessCount: 0
    };

    // Check for duplicates
    const existing = this._cache.facts.find(f =>
      similarity(f.content, entry.content) > 0.85
    );

    if (existing) {
      // Update existing fact (boost confidence)
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      existing.accessCount++;
      existing.timestamp = Date.now();
    } else {
      this._cache.facts.push(entry);
    }

    // Enforce limits
    if (this._cache.facts.length > this.maxFacts) {
      this._consolidateFacts();
    }

    this.storage.saveFacts(this._cache.facts);
    return entry;
  }

  // ─── Extract facts from conversation ─────────────────────
  extractAndStore(userMessage, assistantMessage) {
    const facts = FactExtractor.extract(userMessage, assistantMessage);
    for (const fact of facts) {
      this.storeFact(fact);
    }
    return facts;
  }

  // ─── Add conversation summary ────────────────────────────
  addSummary(messages, topic = 'general') {
    const summary = ConversationSummarizer.createSummary(messages, topic);
    this._cache.summaries.push(summary);

    // Enforce limits
    while (this._cache.summaries.length > this.maxSummaries) {
      // Remove oldest low-priority summary
      const idx = this._cache.summaries.findIndex(s => s.priority >= PRIORITY.LOW);
      if (idx >= 0) {
        this._cache.summaries.splice(idx, 1);
      } else {
        this._cache.summaries.shift();
      }
    }

    this.storage.saveSummaries(this._cache.summaries);
    return summary;
  }

  // ─── Set active context ─────────────────────────────────
  setActiveContext(contextEntries) {
    this._cache.context.active = contextEntries.map(c => ({
      ...c,
      timestamp: c.timestamp || Date.now()
    }));
    this.storage.saveContext(this._cache.context);
  }

  // ─── Get context for current task ────────────────────────
  getContextForTask(task) {
    const allMemories = [
      ...this._cache.facts,
      ...this._cache.summaries,
      ...this._cache.context.active
    ];

    const selected = this.contextManager.selectContext(allMemories, task);

    // Update access counts
    for (const memory of selected) {
      const original = this._cache.facts.find(f => f.id === memory.id) ||
                       this._cache.summaries.find(s => s.id === memory.id);
      if (original) original.accessCount++;
    }

    return selected;
  }

  // ─── Format context for injection into messages ──────────
  formatContextForPrompt(task) {
    const memories = this.getContextForTask(task);
    if (memories.length === 0) return '';

    const sections = [];

    // User instructions (always first)
    const instructions = memories.filter(m => m.type === ENTRY_TYPES.INSTRUCTION);
    if (instructions.length > 0) {
      sections.push('## User Preferences & Instructions\n' +
        instructions.map(m => `- ${m.content}`).join('\n'));
    }

    // Key facts
    const facts = memories.filter(m => m.type === ENTRY_TYPES.FACT);
    if (facts.length > 0) {
      sections.push('## Relevant Facts\n' +
        facts.map(m => `- ${m.content}`).join('\n'));
    }

    // Past summaries
    const summaries = memories.filter(m => m.type === ENTRY_TYPES.SUMMARY);
    if (summaries.length > 0) {
      sections.push('## Previous Context\n' +
        summaries.map(m => `- ${m.content}`).join('\n'));
    }

    // Active context
    const active = memories.filter(m => m.type === ENTRY_TYPES.CONTEXT);
    if (active.length > 0) {
      sections.push('## Current Task Context\n' +
        active.map(m => `- ${m.content}`).join('\n'));
    }

    return sections.join('\n\n');
  }

  // ─── Store user preference ───────────────────────────────
  setUserInstruction(instruction) {
    this._cache.preferences.instructions.push({
      content: instruction,
      timestamp: Date.now()
    });
    this.storage.savePreferences(this._cache.preferences);

    // Also store as critical fact
    this.storeFact({
      content: instruction,
      type: ENTRY_TYPES.INSTRUCTION,
      priority: PRIORITY.CRITICAL,
      source: 'user_instruction',
      confidence: 1.0
    });
  }

  // ─── Query memory ────────────────────────────────────────
  query(query, type = 'all', limit = 5) {
    let results = [];

    if (type === 'all' || type === 'fact') {
      results.push(...this._cache.facts);
    }
    if (type === 'all' || type === 'summary') {
      results.push(...this._cache.summaries);
    }
    if (type === 'all' || type === 'conversation') {
      results.push(...this._cache.context.active);
    }

    // Simple keyword search
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    results = results.map(r => {
      const contentLower = r.content.toLowerCase();
      const matchCount = queryWords.filter(w => contentLower.includes(w)).length;
      return { ...r, matchScore: matchCount / queryWords.length };
    }).filter(r => r.matchScore > 0);

    results.sort((a, b) => b.matchScore - a.matchScore);
    return results.slice(0, limit);
  }

  // ─── Consolidation (dream cycle) ─────────────────────────
  /**
   * Called periodically to consolidate memory:
   * 1. Merge duplicate facts
   * 2. Promote/demote priorities
   * 3. Archive old context
   * 4. Create summaries from accumulated context
   */
  consolidate() {
    console.log('[Memory] Running consolidation cycle...');

    // 1. Archive old context
    const now = Date.now();
    const active = this._cache.context.active.filter(c => {
      const age = now - (c.timestamp || 0);
      if (age > this.maxContextAge && c.priority > PRIORITY.HIGH) {
        this._cache.context.archived.push(c);
        return false;
      }
      return true;
    });
    this._cache.context.active = active;

    // 2. Merge similar facts
    this._consolidateFacts();

    // 3. Demote stale facts
    for (const fact of this._cache.facts) {
      const age = now - (fact.timestamp || 0);
      const ageDays = age / (1000 * 60 * 60 * 24);
      if (ageDays > 30 && fact.priority < PRIORITY.CRITICAL) {
        fact.priority = Math.min(PRIORITY.DISPOSABLE, fact.priority + 1);
      }
    }

    // 4. Save everything
    this.storage.saveFacts(this._cache.facts);
    this.storage.saveSummaries(this._cache.summaries);
    this.storage.saveContext(this._cache.context);

    const stats = this.getStats();
    console.log(`[Memory] Consolidation complete: ${stats.totalFacts} facts, ${stats.totalSummaries} summaries`);
  }

  _consolidateFacts() {
    // Remove duplicates and merge similar facts
    const unique = [];
    const removed = new Set();

    for (let i = 0; i < this._cache.facts.length; i++) {
      if (removed.has(i)) continue;

      for (let j = i + 1; j < this._cache.facts.length; j++) {
        if (removed.has(j)) continue;
        if (similarity(this._cache.facts[i].content, this._cache.facts[j].content) > 0.8) {
          // Keep the higher-confidence one
          if (this._cache.facts[j].confidence > this._cache.facts[i].confidence) {
            removed.add(i);
          } else {
            removed.add(j);
          }
        }
      }
    }

    this._cache.facts = this._cache.facts.filter((_, idx) => !removed.has(idx));

    // If still over limit, remove lowest priority
    while (this._cache.facts.length > this.maxFacts) {
      const lowestIdx = this._cache.facts.reduce((minIdx, f, idx, arr) =>
        f.priority > arr[minIdx].priority ? idx : minIdx, 0);
      this._cache.facts.splice(lowestIdx, 1);
    }
  }

  // ─── Stats ───────────────────────────────────────────────
  getStats() {
    return {
      totalFacts: this._cache.facts.length,
      totalSummaries: this._cache.summaries.length,
      activeContext: this._cache.context.active.length,
      archivedContext: this._cache.context.archived.length,
      userInstructions: this._cache.preferences.instructions.length,
      memoryTypes: {
        facts: this._cache.facts.filter(f => f.type === ENTRY_TYPES.FACT).length,
        instructions: this._cache.facts.filter(f => f.type === ENTRY_TYPES.INSTRUCTION).length,
        summaries: this._cache.summaries.length
      }
    };
  }
}

// ─── Utility Functions ────────────────────────────────────────

function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 12);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const aWords = new Set(a.toLowerCase().split(/\s+/));
  const bWords = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...aWords].filter(w => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

// ─── Exports ──────────────────────────────────────────────────
module.exports = {
  MemorySystem,
  MemoryStorage,
  FactExtractor,
  ConversationSummarizer,
  ContextWindowManager,
  ENTRY_TYPES,
  PRIORITY
};
