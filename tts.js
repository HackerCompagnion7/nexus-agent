/**
 * ═══════════════════════════════════════════════════════════════
 *  JARVIS TTS Module — Piper Text-to-Speech
 *  Open-source male Spanish voice via Piper TTS
 *  Zero npm dependencies — Node.js child_process + fs only
 * ═══════════════════════════════════════════════════════════════
 *
 *  Architecture:
 *  - Piper binary (bin/piper/piper) generates raw PCM audio
 *  - This module wraps it with WAV header for web streaming
 *  - Fallback: termux-tts-speak for CLI mode
 *  - Web: /api/tts → audio/wav stream → <audio> playback
 *
 *  Voice: es_ES-carlfm-high (Spanish male, MIT license)
 *  Voice: en_US-danny-medium (English male, MIT license)
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ─── Voice Configuration ──────────────────────────────────────
const VOICES = {
  'es_ES-carlfm-high': {
    lang: 'es', gender: 'male', quality: 'high',
    desc: 'Carlos - Spanish male, professional'
  },
  'es_ES-davefx-medium': {
    lang: 'es', gender: 'male', quality: 'medium',
    desc: 'Dave - Spanish male, casual'
  },
  'en_US-danny-medium': {
    lang: 'en', gender: 'male', quality: 'medium',
    desc: 'Danny - English male'
  },
  'en_US-joe-medium': {
    lang: 'en', gender: 'male', quality: 'medium',
    desc: 'Joe - English male, deep voice'
  }
};

const DEFAULT_VOICE_MAP = {
  'es': 'es_ES-carlfm-high',
  'en': 'en_US-danny-medium'
};

class PiperTTS {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(__dirname);
    this.piperBin = options.piperBin || this._findBinary();
    this.modelDir = options.modelDir || path.join(this.baseDir, 'models', 'piper');
    this.cacheDir = options.cacheDir || path.join(this.baseDir, 'data', 'tts-cache');
    this.defaultLang = options.defaultLang || 'es';
    this.defaultVoice = options.defaultVoice || DEFAULT_VOICE_MAP[this.defaultLang] || 'es_ES-carlfm-high';
    this.enabled = false;
    this.cacheEnabled = options.cacheEnabled !== false;

    // Ensure cache dir
    if (this.cacheEnabled) {
      try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch {}
    }

    // Check availability on init
    this._checkAvailable();
  }

  _findBinary() {
    const binDir = path.join(this.baseDir, 'bin', 'piper');
    const arch = os.arch();
    const platform = os.platform();

    // Check for piper binary in project
    const localPath = path.join(binDir, 'piper');
    if (fs.existsSync(localPath)) return localPath;

    // Check PATH
    try {
      const which = execSync('which piper 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (which) return which;
    } catch {}

    // Check common Termux location
    const termuxPath = '/data/data/com.termux/files/usr/bin/piper';
    if (fs.existsSync(termuxPath)) return termuxPath;

    return 'piper'; // fallback to PATH
  }

  _checkAvailable() {
    const modelPath = this._getModelPath(this.defaultVoice);
    const configPath = modelPath + '.json';

    this.enabled = fs.existsSync(this.piperBin) && fs.existsSync(modelPath) && fs.existsSync(configPath);

    if (!this.enabled) {
      console.log(`[TTS] Piper not available. Binary: ${fs.existsSync(this.piperBin)}, Model: ${fs.existsSync(modelPath)}`);
      console.log('[TTS] Run install.sh to download Piper + voice models');
    } else {
      console.log(`[TTS] Piper ready — voice: ${this.defaultVoice}`);
    }
  }

  _getModelPath(voice) {
    return path.join(this.modelDir, `${voice}.onnx`);
  }

  _getCacheKey(text, voice) {
    return crypto.createHash('md5').update(`${voice}:${text}`).digest('hex');
  }

  isAvailable() {
    return this.enabled;
  }

  getAvailableVoices() {
    const voices = [];
    try {
      const files = fs.readdirSync(this.modelDir);
      for (const file of files) {
        if (file.endsWith('.onnx')) {
          const name = file.replace('.onnx', '');
          const info = VOICES[name] || { lang: 'unknown', gender: 'unknown', quality: 'unknown', desc: name };
          voices.push({ name, ...info });
        }
      }
    } catch {}
    return voices;
  }

  /**
   * Synthesize text to WAV audio buffer
   * @param {string} text - Text to speak
   * @param {object} options - { voice, lang, noiseScale, lengthScale }
   * @returns {Promise<Buffer>} - WAV audio buffer
   */
  async synthesize(text, options = {}) {
    if (!this.enabled) {
      throw new Error('Piper TTS not available. Run install.sh first.');
    }

    // Clean text for TTS
    const cleanText = this._cleanText(text);
    if (!cleanText.trim()) {
      throw new Error('Empty text after cleaning');
    }

    // Select voice
    const voice = options.voice
      || DEFAULT_VOICE_MAP[options.lang]
      || this.defaultVoice;

    const modelPath = this._getModelPath(voice);
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Voice model not found: ${voice}. Available: ${this.getAvailableVoices().map(v => v.name).join(', ')}`);
    }

    // Check cache
    if (this.cacheEnabled) {
      const cacheKey = this._getCacheKey(cleanText, voice);
      const cachePath = path.join(this.cacheDir, `${cacheKey}.wav`);
      if (fs.existsSync(cachePath)) {
        return fs.readFileSync(cachePath);
      }
    }

    // Generate audio via Piper
    const wavBuffer = await this._runPiper(cleanText, modelPath, options);

    // Save to cache
    if (this.cacheEnabled) {
      const cacheKey = this._getCacheKey(cleanText, voice);
      const cachePath = path.join(this.cacheDir, `${cacheKey}.wav`);
      try { fs.writeFileSync(cachePath, wavBuffer); } catch {}
    }

    return wavBuffer;
  }

  /**
   * Stream synthesis — generates WAV and returns it (for HTTP streaming)
   */
  async synthesizeStream(text, options = {}) {
    return await this.synthesize(text, options);
  }

  _runPiper(text, modelPath, options = {}) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const noiseScale = options.noiseScale || 0.667;
      const lengthScale = options.lengthScale || 1.0;

      const args = [
        '--model', modelPath,
        '--output-raw',
        '--noise-scale', String(noiseScale),
        '--length-scale', String(lengthScale)
      ];

      const proc = spawn(this.piperBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PIPER_CACHE_DIR: this.cacheDir }
      });

      proc.stdout.on('data', (chunk) => chunks.push(chunk));

      let stderrOutput = '';
      proc.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          const rawAudio = Buffer.concat(chunks);
          // Piper outputs 22050Hz, 16-bit, mono PCM
          const wavBuffer = this._pcmToWav(rawAudio, 22050, 1, 16);
          resolve(wavBuffer);
        } else {
          reject(new Error(`Piper exited with code ${code}: ${stderrOutput.slice(0, 200)}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Piper: ${err.message}`));
      });

      // Send text to piper's stdin
      proc.stdin.write(text);
      proc.stdin.end();
    });
  }

  /**
   * Convert raw PCM data to WAV format with proper header
   */
  _pcmToWav(pcmData, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmData.length;
    const headerSize = 44;

    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);

    // fmt sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);              // Sub-chunk size
    buffer.writeUInt16LE(1, 20);               // Audio format (1 = PCM)
    buffer.writeUInt16LE(channels, 22);        // Channels
    buffer.writeUInt32LE(sampleRate, 24);       // Sample rate
    buffer.writeUInt32LE(byteRate, 28);         // Byte rate
    buffer.writeUInt16LE(blockAlign, 32);       // Block align
    buffer.writeUInt16LE(bitsPerSample, 34);    // Bits per sample

    // data sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    pcmData.copy(buffer, 44);

    return buffer;
  }

  /**
   * Clean text for TTS — remove markdown, code blocks, etc.
   */
  _cleanText(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' código omitido ')
      .replace(/`[^`]+`/g, ' código ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
      .replace(/^[\s]*[-*+]\s/gm, '')
      .replace(/^\d+\.\s/gm, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ', ')
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);
  }

  /**
   * Speak via Termux TTS (CLI mode fallback)
   */
  async speakTermux(text) {
    const cleanText = this._cleanText(text);
    if (!cleanText.trim()) return;

    return new Promise((resolve, reject) => {
      const proc = spawn('termux-tts-speak', ['-l', this.defaultLang === 'es' ? 'es' : 'en'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      proc.stdin.write(cleanText);
      proc.stdin.end();

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`termux-tts-speak exited with code ${code}`));
      });

      proc.on('error', (err) => {
        reject(new Error(`termux-tts-speak not available: ${err.message}`));
      });
    });
  }

  /**
   * Speak audio — uses Piper if available, falls back to termux-tts-speak
   */
  async speak(text, options = {}) {
    if (this.enabled) {
      // Generate WAV and play via aplay/termux-media-player
      try {
        const wavBuffer = await this.synthesize(text, options);
        const tempFile = path.join(os.tmpdir(), `jarvis-tts-${Date.now()}.wav`);
        fs.writeFileSync(tempFile, wavBuffer);

        // Try to play the audio
        await this._playAudio(tempFile);

        // Clean up
        try { fs.unlinkSync(tempFile); } catch {}
        return true;
      } catch (e) {
        console.error('[TTS] Piper failed:', e.message);
      }
    }

    // Fallback: termux-tts-speak
    try {
      await this.speakTermux(text);
      return true;
    } catch (e) {
      console.error('[TTS] termux-tts-speak failed:', e.message);
      return false;
    }
  }

  _playAudio(filePath) {
    return new Promise((resolve, reject) => {
      // Try termux first, then aplay, then afplay (macOS)
      const players = ['termux-media-player play', 'aplay', 'afplay', 'play'];
      let played = false;

      for (const player of players) {
        try {
          const cmd = player.split(' ')[0];
          const which = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' }).trim();
          if (which) {
            execSync(`${player} "${filePath}"`, { timeout: 30000 });
            played = true;
            break;
          }
        } catch {}
      }

      if (played) resolve();
      else reject(new Error('No audio player found'));
    });
  }

  /**
   * Clear TTS cache
   */
  clearCache() {
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.wav')) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  getStats() {
    let cacheSize = 0;
    let cacheCount = 0;
    try {
      const files = fs.readdirSync(this.cacheDir);
      cacheCount = files.filter(f => f.endsWith('.wav')).length;
      for (const file of files) {
        if (file.endsWith('.wav')) {
          cacheSize += fs.statSync(path.join(this.cacheDir, file)).size;
        }
      }
    } catch {}

    return {
      available: this.enabled,
      piperBin: this.piperBin,
      defaultVoice: this.defaultVoice,
      voices: this.getAvailableVoices(),
      cacheCount,
      cacheSizeMB: (cacheSize / (1024 * 1024)).toFixed(1)
    };
  }
}

module.exports = { PiperTTS, VOICES, DEFAULT_VOICE_MAP };
