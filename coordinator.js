/**
 * ═══════════════════════════════════════════════════════════════
 *  NEXUS COORDINATOR — Multi-Agent Task Orchestration
 *  Implements an Actor Model pattern for decomposing complex
 *  tasks into parallel subtasks, distributing them to worker
 *  agents, and synthesizing their results.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { EventEmitter } = require('events');

// ─── Task States ──────────────────────────────────────────────
const TASK_STATE = {
  PENDING: 'pending',
  PLANNING: 'planning',
  DECOMPOSED: 'decomposed',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// ─── Worker States ────────────────────────────────────────────
const WORKER_STATE = {
  IDLE: 'idle',
  WORKING: 'working',
  WAITING: 'waiting',
  ERROR: 'error'
};

// ─── Task Definition ──────────────────────────────────────────
class Task {
  constructor(description, options = {}) {
    this.id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.description = description;
    this.state = TASK_STATE.PENDING;
    this.parentId = options.parentId || null;
    this.subtasks = [];
    this.result = null;
    this.error = null;
    this.priority = options.priority || 5;
    this.maxSubtasks = options.maxSubtasks || 5;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.metadata = options.metadata || {};
  }

  get duration() {
    if (!this.startedAt) return 0;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }

  get isComplete() {
    return this.state === TASK_STATE.COMPLETED || this.state === TASK_STATE.FAILED;
  }
}

// ─── Worker Agent ─────────────────────────────────────────────
class WorkerAgent {
  constructor(id, llmClient, toolExecutor, options = {}) {
    this.id = id;
    this.llmClient = llmClient;
    this.toolExecutor = toolExecutor;
    this.state = WORKER_STATE.IDLE;
    this.currentTask = null;
    this.completedTasks = 0;
    this.failedTasks = 0;
    this.eventEmitter = options.eventEmitter || new EventEmitter();
  }

  async execute(task, systemPrompt, tools) {
    this.state = WORKER_STATE.WORKING;
    this.currentTask = task;
    task.state = TASK_STATE.RUNNING;
    task.startedAt = Date.now();

    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task.description }
      ];

      const result = await this.llmClient.agentLoop(messages, tools, this.toolExecutor, {
        maxIterations: 10,
        stream: false,
        onToolResult: (result) => {
          this.eventEmitter.emit('worker:tool_result', {
            workerId: this.id,
            taskId: task.id,
            tool: result.name,
            success: result.success,
            duration: result.executionTime
          });
        }
      });

      task.result = result.content;
      task.state = TASK_STATE.COMPLETED;
      this.completedTasks++;
      this.eventEmitter.emit('worker:completed', { workerId: this.id, taskId: task.id, result: result.content });

    } catch (error) {
      task.error = error.message;
      task.state = TASK_STATE.FAILED;
      this.failedTasks++;
      this.eventEmitter.emit('worker:error', { workerId: this.id, taskId: task.id, error: error.message });
    } finally {
      this.state = WORKER_STATE.IDLE;
      this.currentTask = null;
      task.completedAt = Date.now();
    }

    return task;
  }

  getStats() {
    return {
      id: this.id,
      state: this.state,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks
    };
  }
}

// ─── Coordinator ──────────────────────────────────────────────
class Coordinator extends EventEmitter {
  constructor(llmClient, toolExecutor, options = {}) {
    super();
    this.llmClient = llmClient;
    this.toolExecutor = toolExecutor;
    this.maxWorkers = options.maxWorkers || 3;
    this.workers = [];
    this.taskQueue = [];
    this.completedTasks = [];
    this.isRunning = false;
    this.systemPrompt = options.systemPrompt || '';

    // Initialize workers
    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = new WorkerAgent(`worker_${i}`, llmClient, toolExecutor, {
        eventEmitter: this
      });
      this.workers.push(worker);
    }
  }

  // ─── Submit a task for execution ─────────────────────────
  async submit(description, options = {}) {
    const task = new Task(description, options);
    this.taskQueue.push(task);
    this.emit('task:submitted', { taskId: task.id, description });
    return task;
  }

  // ─── Decompose a complex task into subtasks ──────────────
  async decompose(task) {
    task.state = TASK_STATE.PLANNING;
    this.emit('task:decomposing', { taskId: task.id });

    const decompositionPrompt = `You are a task decomposition specialist. Given a complex task, break it down into ${task.maxSubtasks} or fewer independent subtasks that can be executed in parallel.

IMPORTANT RULES:
1. Each subtask must be self-contained and executable independently
2. Subtasks should not depend on each other's results
3. If the task is simple enough, indicate it doesn't need decomposition
4. Return the subtasks as a JSON array of objects with "description" and "priority" (1-10) fields

Original task: ${task.description}

Respond ONLY with a JSON array. Example:
[
  {"description": "Research existing solutions for X", "priority": 8},
  {"description": "Design the architecture for Y", "priority": 6}
]

If the task is simple and doesn't need decomposition, respond with:
[{"description": "<original task>", "priority": 5}]`;

    try {
      const response = await this.llmClient.chat(
        [
          { role: 'system', content: decompositionPrompt },
          { role: 'user', content: `Decompose this task: ${task.description}` }
        ],
        [], // No tools needed for decomposition
        { temperature: 0.3, maxTokens: 1024 }
      );

      // Parse subtasks from response
      const jsonMatch = response.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        // Can't decompose, execute as-is
        task.subtasks = [new Task(task.description, { parentId: task.id, priority: task.priority })];
      } else {
        const subtaskDefs = JSON.parse(jsonMatch[0]);
        task.subtasks = subtaskDefs.map(def =>
          new Task(def.description, {
            parentId: task.id,
            priority: def.priority || 5
          })
        );
      }

      task.state = TASK_STATE.DECOMPOSED;
      this.emit('task:decomposed', {
        taskId: task.id,
        subtaskCount: task.subtasks.length,
        subtasks: task.subtasks.map(s => s.description)
      });

    } catch (error) {
      // If decomposition fails, execute as single task
      task.subtasks = [new Task(task.description, { parentId: task.id })];
      task.state = TASK_STATE.DECOMPOSED;
    }

    return task;
  }

  // ─── Execute a task with optional decomposition ──────────
  async execute(task, tools) {
    if (!task.subtasks || task.subtasks.length === 0) {
      await this.decompose(task);
    }

    // Single subtask = execute directly
    if (task.subtasks.length === 1) {
      const worker = this._getAvailableWorker();
      if (!worker) {
        // No workers available, execute sequentially
        const result = await this.workers[0].execute(task.subtasks[0], this.systemPrompt, tools);
        task.result = result.result;
        task.state = result.state;
        return task;
      }

      const result = await worker.execute(task.subtasks[0], this.systemPrompt, tools);
      task.result = result.result;
      task.state = result.state;
      return task;
    }

    // Multiple subtasks = parallel execution
    task.state = TASK_STATE.RUNNING;
    task.startedAt = Date.now();

    // Sort by priority
    const sortedSubtasks = [...task.subtasks].sort((a, b) => b.priority - a.priority);

    // Execute in parallel with available workers
    const results = await this._executeParallel(sortedSubtasks, tools);

    // Synthesize results
    if (results.every(r => r.state === TASK_STATE.COMPLETED)) {
      task.result = await this._synthesizeResults(task, results);
      task.state = TASK_STATE.COMPLETED;
    } else {
      const failedCount = results.filter(r => r.state === TASK_STATE.FAILED).length;
      task.result = this._partialResults(task, results);
      task.state = failedCount === results.length ? TASK_STATE.FAILED : TASK_STATE.COMPLETED;
      task.error = `${failedCount}/${results.length} subtasks failed`;
    }

    task.completedAt = Date.now();
    this.completedTasks.push(task);
    this.emit('task:completed', { taskId: task.id, state: task.state, duration: task.duration });

    return task;
  }

  // ─── Run parallel execution with worker pool ────────────
  async _executeParallel(subtasks, tools) {
    const results = [];
    const executing = new Map();

    for (const subtask of subtasks) {
      // Wait for a worker to become available
      let worker = this._getAvailableWorker();
      while (!worker) {
        await new Promise(r => setTimeout(r, 100));
        worker = this._getAvailableWorker();
      }

      const promise = worker.execute(subtask, this.systemPrompt, tools);
      executing.set(worker.id, promise);
    }

    // Wait for all executions to complete
    const settled = await Promise.allSettled([...executing.values()]);

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({
          state: TASK_STATE.FAILED,
          error: result.reason?.message || 'Unknown error',
          result: null
        });
      }
    }

    return results;
  }

  // ─── Synthesize parallel results ─────────────────────────
  async _synthesizeResults(parentTask, results) {
    const synthesisPrompt = `You are a result synthesis specialist. Combine the following parallel task results into a coherent, unified response.

ORIGINAL TASK: ${parentTask.description}

PARALLEL RESULTS:
${results.map((r, i) => `--- Subtask ${i + 1} ---\n${r.result}`).join('\n\n')}

Provide a unified, comprehensive response that combines all the results. Remove redundancies and ensure consistency.`;

    try {
      const response = await this.llmClient.chat(
        [
          { role: 'system', content: synthesisPrompt },
          { role: 'user', content: 'Synthesize the results above into a unified response.' }
        ],
        [],
        { temperature: 0.4, maxTokens: 2048 }
      );
      return response.content;
    } catch {
      // If synthesis fails, concatenate results
      return results.map((r, i) => `## Part ${i + 1}\n${r.result}`).join('\n\n');
    }
  }

  // ─── Handle partial results ──────────────────────────────
  _partialResults(parentTask, results) {
    const successful = results.filter(r => r.state === TASK_STATE.COMPLETED);
    const failed = results.filter(r => r.state === TASK_STATE.FAILED);

    let output = '';
    if (successful.length > 0) {
      output += '## Completed Results\n' +
        successful.map((r, i) => `### Part ${i + 1}\n${r.result}`).join('\n\n');
    }
    if (failed.length > 0) {
      output += '\n\n## Failed Parts\n' +
        failed.map((r, i) => `- Part ${successful.length + i + 1}: ${r.error}`).join('\n');
    }

    return output;
  }

  // ─── Get available worker ────────────────────────────────
  _getAvailableWorker() {
    return this.workers.find(w => w.state === WORKER_STATE.IDLE);
  }

  // ─── Run the coordinator's main loop ─────────────────────
  async run(tools, onResult) {
    this.isRunning = true;

    while (this.taskQueue.length > 0 && this.isRunning) {
      const task = this.taskQueue.shift();
      if (!task) continue;

      try {
        const result = await this.execute(task, tools);
        if (onResult) onResult(result);
      } catch (error) {
        task.state = TASK_STATE.FAILED;
        task.error = error.message;
        task.completedAt = Date.now();
        if (onResult) onResult(task);
      }
    }

    this.isRunning = false;
  }

  // ─── Stop execution ──────────────────────────────────────
  stop() {
    this.isRunning = false;
    this.emit('coordinator:stopped');
  }

  // ─── Get coordinator stats ───────────────────────────────
  getStats() {
    return {
      isRunning: this.isRunning,
      pendingTasks: this.taskQueue.length,
      completedTasks: this.completedTasks.length,
      workers: this.workers.map(w => w.getStats()),
      totalTokensUsed: this.llmClient.getStats().totalRequests
    };
  }
}

// ─── Exports ──────────────────────────────────────────────────
module.exports = { Coordinator, WorkerAgent, Task, TASK_STATE, WORKER_STATE };
