/**
 * ═══════════════════════════════════════════════════════════════
 *  JARVIS STT Module — Whisper.cpp Speech-to-Text
 *  Open-source transcription via whisper.cpp
 *  Zero npm dependencies — Node.js child_process + fs only
 * ═══════════════════════════════════════════════════════════════
 *
 *  Architecture:
 *  - Browser captures audio via MediaRecorder → sends to /api/stt
 *  - Node.js saves temp audio file → converts to 16kHz WAV
 *  - whisper.cpp transcribes → returns text
 *  - Text goes to Mistral API → response → Piper TTS → audio back
 *
 *  Models: ggml-tiny.bin (75MB), ggml-base.bin (142MB)
 *  Default: ggml-tiny.bin (fastest, good for Spanish)
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ─── Model Configuration ──────────────────────────────────────
const MODELS = {
  'ggml-tiny.bin': {
    size: '~75MB', lang: 'multilingual', quality: 'tiny',
    desc: 'Tiny model — fastest, good quality for Spanish'
  },
  'ggml-tiny.en.bin': {
    size: '~75MB', lang: 'en-only', quality: 'tiny',
    desc: 'Tiny English-only — fastest for English'
  },
  'ggml-base.bin': {
    size: '~142MB', lang: 'multilingual', quality: 'base',
    desc: 'Base model — better quality, still fast'
  },
  'ggml-base.en.bin': {
    size: '~142MB', lang: 'en-only', quality: 'base',
    desc: 'Base English-only — better for English'
  },
  'ggml-small.bin': {
    size: '~466MB', lang: 'multilingual', quality: 'small',
    desc: 'Small model — high quality, heavier'
  }
};

const DEFAULT_MODEL = 'ggml-tiny.bin';

class WhisperSTT {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(__dirname);
    this.whisperBin = options.whisperBin || this._findBinary();
    this.modelDir = options.modelDir || path.join(this.baseDir, 'models', 'whisper');
    this.defaultModel = options.defaultModel || DEFAULT_MODEL;
    this.defaultLang = options.defaultLang || 'es';
    this.enabled = false;
    this.tempDir = options.tempDir || path.join(os.tmpdir(), 'jarvis-stt');

    // Ensure temp dir
    try { fs.mkdirSync(this.tempDir, { recursive: true }); } catch {}

    // Check availability on init
    this._checkAvailable();
  }

  _findBinary() {
    const binDir = path.join(this.baseDir, 'bin', 'whisper');

    // Check for whisper-cpp binary in project
    const localPath = path.join(binDir, 'main');
    if (fs.existsSync(localPath)) return localPath;

    const localPathAlt = path.join(binDir, 'whisper-cpp');
    if (fs.existsSync(localPathAlt)) return localPathAlt;

    // Check PATH
    try {
      const which = execSync('which whisper-cpp 2>/dev/null || which whisper 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (which) return which;
    } catch {}

    // Check common Termux location
    const termuxPath = '/data/data/com.termux/files/usr/bin/whisper-cpp';
    if (fs.existsSync(termuxPath)) return termuxPath;

    const termuxPath2 = '/data/data/com.termux/files/usr/bin/whisper';
    if (fs.existsSync(termuxPath2)) return termuxPath2;

    return 'whisper-cpp'; // fallback to PATH
  }

  _checkAvailable() {
    const modelPath = this._getModelPath(this.defaultModel);

    this.enabled = fs.existsSync(this.whisperBin) && fs.existsSync(modelPath);

    if (!this.enabled) {
      console.log(`[STT] Whisper not available. Binary: ${fs.existsSync(this.whisperBin)}, Model: ${fs.existsSync(modelPath)}`);
      console.log('[STT] Run install.sh to compile whisper.cpp + download models');
    } else {
      console.log(`[STT] Whisper ready — model: ${this.defaultModel}`);
    }
  }

  _getModelPath(model) {
    return path.join(this.modelDir, model);
  }

  isAvailable() {
    return this.enabled;
  }

  getAvailableModels() {
    const models = [];
    try {
      const files = fs.readdirSync(this.modelDir);
      for (const file of files) {
        if (file.startsWith('ggml-') && file.endsWith('.bin')) {
          const info = MODELS[file] || { size: 'unknown', lang: 'multilingual', quality: 'custom', desc: file };
          models.push({ name: file, ...info, installed: true });
        }
      }
    } catch {}
    return models;
  }

  /**
   * Transcribe audio buffer to text
   * @param {Buffer} audioBuffer - Raw audio data (WebM, WAV, etc.)
   * @param {object} options - { lang, model, format }
   * @returns {Promise<{text: string, lang: string, confidence: number}>}
   */
  async transcribe(audioBuffer, options = {}) {
    if (!this.enabled) {
      throw new Error('Whisper STT not available. Run install.sh first.');
    }

    const lang = options.lang || this.defaultLang;
    const model = options.model || this.defaultModel;
    const format = options.format || 'webm';
    const tempId = crypto.randomBytes(8).toString('hex');

    // Save raw audio to temp file
    const rawFile = path.join(this.tempDir, `stt-raw-${tempId}.${format}`);
    const wavFile = path.join(this.tempDir, `stt-${tempId}.wav`);

    try {
      // Write raw audio
      fs.writeFileSync(rawFile, audioBuffer);

      // Convert to 16kHz mono WAV (whisper.cpp requirement)
      await this._convertToWav(rawFile, wavFile);

      if (!fs.existsSync(wavFile)) {
        throw new Error('Audio conversion failed — ffmpeg/sox not available');
      }

      // Run whisper.cpp transcription
      const result = await this._runWhisper(wavFile, { lang, model });

      return result;

    } finally {
      // Clean up temp files
      try { fs.unlinkSync(rawFile); } catch {}
      try { fs.unlinkSync(wavFile); } catch {}
    }
  }

  /**
   * Convert audio file to 16kHz mono WAV
   * Tries ffmpeg first, then sox
   */
  _convertToWav(inputFile, outputFile) {
    return new Promise((resolve, reject) => {
      // Try ffmpeg first (best compatibility)
      const ffmpeg = spawn('ffmpeg', [
        '-y',           // Overwrite output
        '-i', inputFile, // Input file
        '-ar', '16000',  // Sample rate 16kHz
        '-ac', '1',      // Mono
        '-f', 'wav',     // WAV format
        outputFile
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stderrOutput = '';
      ffmpeg.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputFile)) {
          resolve();
          return;
        }

        // Fallback to sox
        const sox = spawn('sox', [
          inputFile,
          '-r', '16000',
          '-c', '1',
          '-b', '16',
          outputFile
        ], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let soxStderr = '';
        sox.stderr.on('data', (data) => {
          soxStderr += data.toString();
        });

        sox.on('close', (soxCode) => {
          if (soxCode === 0 && fs.existsSync(outputFile)) {
            resolve();
          } else {
            // If input is already WAV, try using it directly
            if (inputFile.endsWith('.wav') && fs.existsSync(inputFile)) {
              try {
                fs.copyFileSync(inputFile, outputFile);
                resolve();
                return;
              } catch {}
            }
            reject(new Error(`Audio conversion failed. ffmpeg: code ${code}, sox: code ${soxCode}`));
          }
        });

        sox.on('error', () => {
          // sox not found, try direct copy if WAV
          if (inputFile.endsWith('.wav')) {
            try {
              fs.copyFileSync(inputFile, outputFile);
              resolve();
            } catch {
              reject(new Error('No audio converter available (ffmpeg/sox)'));
            }
          } else {
            reject(new Error('No audio converter available (ffmpeg/sox)'));
          }
        });
      });

      ffmpeg.on('error', () => {
        // ffmpeg not found, try sox directly
        const sox = spawn('sox', [
          inputFile,
          '-r', '16000',
          '-c', '1',
          '-b', '16',
          outputFile
        ], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        sox.on('close', (soxCode) => {
          if (soxCode === 0 && fs.existsSync(outputFile)) {
            resolve();
          } else if (inputFile.endsWith('.wav')) {
            try {
              fs.copyFileSync(inputFile, outputFile);
              resolve();
            } catch {
              reject(new Error('No audio converter available'));
            }
          } else {
            reject(new Error('No audio converter available (ffmpeg/sox)'));
          }
        });

        sox.on('error', () => {
          if (inputFile.endsWith('.wav')) {
            try {
              fs.copyFileSync(inputFile, outputFile);
              resolve();
            } catch {
              reject(new Error('No audio converter available'));
            }
          } else {
            reject(new Error('No audio converter available (ffmpeg/sox)'));
          }
        });
      });
    });
  }

  /**
   * Run whisper.cpp transcription on a WAV file
   */
  _runWhisper(wavFile, options = {}) {
    return new Promise((resolve, reject) => {
      const model = options.model || this.defaultModel;
      const modelPath = this._getModelPath(model);
      const lang = options.lang || this.defaultLang;

      if (!fs.existsSync(modelPath)) {
        reject(new Error(`Whisper model not found: ${model}. Run install.sh to download.`));
        return;
      }

      // whisper-cpp main CLI args
      const args = [
        '-m', modelPath,       // Model path
        '-f', wavFile,          // Audio file
        '-l', lang,             // Language
        '--no-timestamps',      // Clean output
        '-nt',                  // No timestamps (alternative flag)
        '--output-txt',         // Output as plain text
      ];

      const proc = spawn(this.whisperBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LD_LIBRARY_PATH: path.dirname(this.whisperBin) }
      });

      let stdout = '';
      let stderrOutput = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          // Parse whisper.cpp output — extract transcription
          const text = this._parseWhisperOutput(stdout, stderrOutput);
          resolve({
            text: text.trim(),
            lang: lang,
            confidence: 0.9 // whisper.cpp doesn't provide confidence
          });
        } else {
          reject(new Error(`Whisper exited with code ${code}: ${stderrOutput.slice(0, 300)}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start whisper: ${err.message}`));
      });
    });
  }

  /**
   * Parse whisper.cpp output to extract clean transcription
   */
  _parseWhisperOutput(stdout, stderr) {
    // whisper.cpp outputs transcription to stdout
    // Format: [00:00:00.000 --> 00:00:05.000]   Transcribed text here
    // Or with --no-timestamps: just the text

    let text = stdout;

    // Remove timestamp lines if present
    text = text.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '');

    // Remove system messages
    text = text.replace(/^whisper.*$/gm, '');
    text = text.replace(/^system_info.*$/gm, '');
    text = text.replace(/^main.*$/gm, '');

    // Clean up whitespace
    text = text.replace(/\n{2,}/g, '\n');
    text = text.trim();

    // If stdout was empty, try parsing stderr (some versions output there)
    if (!text && stderr) {
      const lines = stderr.split('\n');
      const textLines = lines.filter(l =>
        !l.startsWith('whisper') &&
        !l.startsWith('system_info') &&
        !l.startsWith('main') &&
        !l.startsWith('ggml') &&
        !l.startsWith('load') &&
        l.trim().length > 0
      );
      text = textLines.join(' ').trim();
    }

    return text;
  }

  /**
   * Clean up temp files older than 1 hour
   */
  cleanup() {
    try {
      const files = fs.readdirSync(this.tempDir);
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > 3600000) { // 1 hour
            fs.unlinkSync(filePath);
            cleaned++;
          }
        } catch {}
      }

      return cleaned;
    } catch {
      return 0;
    }
  }

  getStats() {
    let modelSize = 0;
    const modelPath = this._getModelPath(this.defaultModel);
    try {
      if (fs.existsSync(modelPath)) {
        modelSize = fs.statSync(modelPath).size;
      }
    } catch {}

    return {
      available: this.enabled,
      whisperBin: this.whisperBin,
      defaultModel: this.defaultModel,
      defaultLang: this.defaultLang,
      models: this.getAvailableModels(),
      modelSizeMB: (modelSize / (1024 * 1024)).toFixed(1)
    };
  }
}

module.exports = { WhisperSTT, MODELS, DEFAULT_MODEL };
