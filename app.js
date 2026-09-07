/* ============================================================
   AVATAR FACIAL — app.js
   Módulos: VideoStorage (IndexedDB) + VideoManager (crossfade)
            + SpeechManager (Web Speech API) + UI Controller
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────
//  1. VIDEO STORAGE — persiste blobs en IndexedDB
// ─────────────────────────────────────────────
class VideoStorage {
  constructor() {
    this.dbName    = 'AvatarFacialDB';
    this.storeName = 'videos';
    this.version   = 1;
    this._db       = null;
  }

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'name' });
        }
      };
      req.onsuccess  = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror    = ()  => reject(req.error);
    });
  }

  async save(name, blob) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).put({ name, blob, ts: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => reject(tx.error);
    });
  }

  async load(name) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const req = tx.objectStore(this.storeName).get(name);
      req.onsuccess = () => {
        if (req.result) resolve(URL.createObjectURL(req.result.blob));
        else resolve(null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async loadAll(names) {
    const result = {};
    for (const n of names) {
      result[n] = await this.load(n);
    }
    return result;
  }
}

// ─────────────────────────────────────────────
//  2. VIDEO MANAGER — crossfade entre idle y gesto
// ─────────────────────────────────────────────
class VideoManager {
  /**
   * @param {HTMLVideoElement} videoA
   * @param {HTMLVideoElement} videoB
   */
  constructor(videoA, videoB) {
    this.vA = videoA;
    this.vB = videoB;
    this._current = videoA; // el que está visible
    this._next    = videoB; // el que espera
    this.isGesturePlaying = false;
    this.idleSrc = null;
    this.gestureSrcs = {};

    // Silenciar ambos
    this.vA.muted = true;
    this.vB.muted = true;
  }

  /** Asigna las fuentes de video cargadas */
  setSources(srcs) {
    this.idleSrc = srcs.idle;
    this.gestureSrcs = {
      izquierda: srcs.izquierda,
      derecha:   srcs.derecha,
      sonrisa:   srcs.sonrisa,
    };
  }

  /** Inicia el loop del idle — devuelve true si el autoplay funcionó */
  async startIdle() {
    const v = this._current;
    v.src         = this.idleSrc;
    v.loop        = true;
    v.playsInline = true;
    v.muted       = true;
    try {
      await v.play();
      v.classList.add('v-front');
      this._next.classList.remove('v-front', 'v-back', 'v-out');
      return true;
    } catch (_) {
      v.classList.add('v-front');
      this._next.classList.remove('v-front', 'v-back', 'v-out');
      return false;
    }
  }

  /**
   * Reproduce un gesto y vuelve al idle.
   * Crossfade basado en z-index: el video de atrás siempre tiene opacity 1
   * → nunca se ve el fondo negro entre cambios.
   */
  async playGesture(gestureName, onStart, onEnd) {
    if (this.isGesturePlaying) return;
    const src = this.gestureSrcs[gestureName];
    if (!src) return;

    this.isGesturePlaying = true;

    // Carga el gesto en _next
    // _current (idle) = v-front (z-index 2, opacity 1) — sigue visible
    this._next.src         = src;
    this._next.loop        = false;
    this._next.currentTime = 0;
    this._next.playsInline = true;
    this._next.muted       = true;

    // Espera datos suficientes para reproducir
    await new Promise((resolve) => {
      if (this._next.readyState >= 3) { resolve(); return; }
      const onReady = () => { this._next.removeEventListener('canplay', onReady); resolve(); };
      this._next.addEventListener('canplay', onReady);
      setTimeout(resolve, 800);
    });

    try { await this._next.play(); } catch (_) {}

    // Espera 2 frames: GPU sube la textura del primer frame
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Pone el gesto "detrás" visible antes del crossfade
    // → cuando el idle (frente) se desvanezca, el gesto ya está pintado abajo
    this._next.classList.add('v-back');

    // Crossfade: idle (frente) → gesto (atrás → frente)
    this._crossfade();
    if (onStart) onStart();

    // Vuelve al idle ANTES de que el gesto termine (180ms)
    // para que la transición acabe justo cuando el video acaba → sin negro
    const FADE_S = 0.18;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      this._current.removeEventListener('timeupdate', onTick);
      this._current.removeEventListener('ended',      onEnd_);
      // El idle (_next) lleva corriendo todo el tiempo → ponlo visible atrás
      this._next.classList.add('v-back');
      this._crossfade();
      this.isGesturePlaying = false;
      if (onEnd) onEnd();
    };

    const onTick  = () => {
      if (!this._current.duration) return;
      if (this._current.duration - this._current.currentTime <= FADE_S) finish();
    };
    const onEnd_  = () => finish();

    this._current.addEventListener('timeupdate', onTick);
    this._current.addEventListener('ended', onEnd_, { once: true });
  }

  /**
   * Crossfade basado en z-index:
   *   - outgoing (frente, v-front) → añade v-out (fade 1→0, z-index 2)
   *   - incoming (atrás, v-back)  → ya visible con opacity 1 debajo
   *   - Tras 180ms: outgoing → invisible default, incoming → v-front
   */
  _crossfade() {
    const outgoing = this._current;
    const incoming = this._next;

    // El video de frente empieza a desvanecerse (sigue en z-index 2)
    outgoing.classList.add('v-out');

    // Tras la transición: finaliza el intercambio de roles
    setTimeout(() => {
      outgoing.classList.remove('v-front', 'v-back', 'v-out'); // vuelve a invisible
      incoming.classList.remove('v-back');
      incoming.classList.add('v-front');                        // pasa a frente
    }, 200);

    // Intercambia referencias JS inmediatamente
    this._current = incoming;
    this._next    = outgoing;
  }

} // fin VideoManager

// ─────────────────────────────────────────────

//  3. SPEECH MANAGER — Web Speech API en español
//  Patrón: sesiones cortas + reinicio automático
//  (más confiable que continuous:true en Chrome)
// ─────────────────────────────────────────────
class SpeechManager {
  /**
   * @param {Object}   commands       — { palabra: callback }
   * @param {Function} onTranscript   — cb(texto) con texto parcial/final
   * @param {Function} onStatusChange — cb(status, mensaje)
   */
  constructor(commands, onTranscript, onStatusChange) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('Web Speech API no disponible. Usa Google Chrome.');

    this.commands        = commands;
    this.onTranscript    = onTranscript;
    this.onStatusChange  = onStatusChange;

    this._active       = false; // queremos estar escuchando
    this._sessionOpen  = false; // sesión actualmente abierta
    this._restartTimer = null;
    this._errorCount   = 0;     // contador para backoff

    this._SR = SR;
    this._createInstance();
  }

  /** Crea una instancia nueva (necesario tras algunos errores) */
  _createInstance() {
    if (this.rec) {
      try { this.rec.abort(); } catch (_) {}
    }

    this.rec = new this._SR();
    // ── CLAVE: continuous:false + reinicio manual es MUCHO más estable ──
    this.rec.lang            = 'es-PE';
    this.rec.continuous      = false;  // ← sesiones cortas, sin errores de red
    this.rec.interimResults  = true;
    this.rec.maxAlternatives = 5;      // más alternativas = mejor detección

    this.rec.onstart  = ()  => this._onStart();
    this.rec.onresult = (e) => this._onResult(e);
    this.rec.onerror  = (e) => this._onError(e);
    this.rec.onend    = ()  => this._onEnd();
  }

  /** Inicia el ciclo de escucha */
  start() {
    this._active = true;
    this._errorCount = 0;
    this._doStart();
  }

  /** Detiene completamente */
  stop() {
    this._active = false;
    clearTimeout(this._restartTimer);
    try { this.rec.abort(); } catch (_) {}
    this._sessionOpen = false;
    this.onStatusChange('off', 'Detenido');
  }

  _doStart() {
    if (!this._active || this._sessionOpen) return;
    try {
      this.rec.start();
    } catch (e) {
      // "already started" → ignorar; otro error → recrear
      if (!e.message.includes('already started')) {
        this._createInstance();
        setTimeout(() => this._doStart(), 400);
      }
    }
  }

  _onStart() {
    this._sessionOpen = true;
    this._errorCount  = 0;
    this.onStatusChange('listening', 'Escuchando... habla ahora');
  }

  _onResult(e) {
    let finalText   = '';
    let interimText = '';

    for (let i = e.resultIndex; i < e.results.length; i++) {
      // Revisa TODAS las alternativas para mayor cobertura
      const alts = [];
      for (let a = 0; a < e.results[i].length; a++) {
        alts.push(e.results[i][a].transcript.toLowerCase().trim());
      }
      const best = alts[0];
      if (e.results[i].isFinal) finalText   += best + ' ';
      else                      interimText += best;

      // Busca comando en TODAS las alternativas (más detección)
      if (e.results[i].isFinal) {
        const allText = alts.join(' ');
        this._matchCommand(allText);
      }
    }

    this.onTranscript(interimText || finalText);

    // También busca en interim para reaccionar más rápido
    if (interimText) this._matchCommand(interimText);
  }

  _matchCommand(text) {
    const t = text.toLowerCase();
    for (const [keyword, cb] of Object.entries(this.commands)) {
      if (t.includes(keyword)) {
        cb(keyword, t);
        return true;
      }
    }
    return false;
  }

  _onError(e) {
    this._sessionOpen = false;
    this._errorCount++;

    // 'no-speech' es normal (silencio) → reiniciar rápido sin mensaje
    if (e.error === 'no-speech') {
      this.onStatusChange('listening', 'Escuchando... (sin voz detectada)');
      this._scheduleRestart(300);
      return;
    }

    // 'network' → error más común; backoff corto y reintentar
    if (e.error === 'network') {
      const delay = Math.min(800 * this._errorCount, 4000);
      this.onStatusChange('listening',
        `Reintentando conexión... (${this._errorCount}x)`);
      this._createInstance(); // instancia fresca
      this._scheduleRestart(delay);
      return;
    }

    // Errores fatales → no reintentar
    if (['not-allowed', 'audio-capture', 'service-not-allowed'].includes(e.error)) {
      this._active = false;
      const msgs = {
        'not-allowed':         '❌ Permiso de micrófono denegado. Habilítalo en Chrome.',
        'audio-capture':       '❌ No se encontró micrófono.',
        'service-not-allowed': '❌ Reconocimiento de voz bloqueado.',
      };
      this.onStatusChange('error', msgs[e.error] || `Error: ${e.error}`);
      return;
    }

    // Otros errores → reintentar con backoff
    this.onStatusChange('listening', `Error (${e.error}), reintentando...`);
    this._scheduleRestart(600);
  }

  _onEnd() {
    this._sessionOpen = false;
    if (!this._active) return;
    // Sesión terminó (normal) → nueva sesión inmediatamente
    this._scheduleRestart(200);
  }

  _scheduleRestart(delay) {
    clearTimeout(this._restartTimer);
    if (!this._active) return;
    this._restartTimer = setTimeout(() => this._doStart(), delay);
  }
}

// ─────────────────────────────────────────────
//  4. UI CONTROLLER — orquesta todo
// ─────────────────────────────────────────────
class AvatarApp {
  constructor() {
    this.storage      = new VideoStorage();
    this.videoMgr     = null;
    this.speechMgr    = null;
    this.loadedVideos = {}; // { idle: null, izquierda: null, ... }
    this.uploadCount  = 0;

    this._el = {
      setupScreen:   document.getElementById('setup-screen'),
      avatarScreen:  document.getElementById('avatar-screen'),
      startBtn:      document.getElementById('start-btn'),
      startBtnText:  document.getElementById('start-btn-text'),
      settingsBtn:   document.getElementById('settings-btn'),
      videoA:        document.getElementById('video-a'),
      videoB:        document.getElementById('video-b'),
      avatarFrame:   document.getElementById('avatar-frame'),   // .video-fullscreen
      gestureBadge:  document.getElementById('gesture-badge'),
      gestureLabel:  document.getElementById('gesture-label'),
      soundWaves:    document.getElementById('sound-waves'),
      micDot:        document.getElementById('mic-dot'),
      micStatusText: document.getElementById('mic-status-text'),
      transcriptLive:document.getElementById('transcript-live'),
      lastCmdPanel:  document.getElementById('last-command-panel'),
      lastCmdChip:   document.getElementById('last-command-chip'),
      toastContainer:document.getElementById('toast-container'),
    };

    this._gestures = {
      izquierda: { label: 'Izquierda', btnId: 'btn-izquierda' },
      derecha:   { label: 'Derecha',   btnId: 'btn-derecha'   },
      sonrisa:   { label: 'Sonrisa',   btnId: 'btn-sonrisa'   },
    };

    this._init();
  }

  async _init() {
    this._bindSetupEvents();

    // Intenta cargar videos previamente guardados
    const slots = ['idle', 'izquierda', 'derecha', 'sonrisa'];
    const srcs  = await this.storage.loadAll(slots);
    const allLoaded = slots.every(s => srcs[s] !== null);

    if (allLoaded) {
      // Marca todos los slots como cargados en la UI
      for (const slot of slots) {
        this._markSlotLoaded(slot);
        this.loadedVideos[slot] = srcs[slot];
        this.uploadCount++;
      }
      this._updateStartBtn();
      this.toast('✅ Videos cargados desde la sesión anterior.', 'success');
    }
  }

  _bindSetupEvents() {
    // Cada input de archivo
    const inputs = document.querySelectorAll('input[type="file"]');
    inputs.forEach(input => {
      input.addEventListener('change', (e) => this._handleFileInput(e));
    });

    // Botón iniciar
    this._el.startBtn.addEventListener('click', () => this._goToAvatar());

    // Botón de configuración (volver al setup)
    this._el.settingsBtn.addEventListener('click', () => this._goToSetup());

    // Botones manuales (respaldo cuando falla el micrófono)
    document.querySelectorAll('.manual-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const gesture = btn.dataset.gesture;
        if (gesture) this._triggerGesture(gesture);
      });
    });
  }

  async _handleFileInput(e) {
    const input = e.target;
    const slot  = input.dataset.slot;
    const file  = input.files[0];
    if (!file) return;

    // Validar que sea video
    if (!file.type.startsWith('video/')) {
      this.toast('⚠️ Solo se aceptan archivos de video.', 'error');
      return;
    }

    const statusEl = document.getElementById(`status-${slot}`);
    statusEl.textContent = 'Guardando...';

    try {
      await this.storage.save(slot, file);
      const url = URL.createObjectURL(file);
      this.loadedVideos[slot] = url;
      this.uploadCount++;
      this._markSlotLoaded(slot);
      this._updateStartBtn();
      this.toast(`✅ "${this._slotLabel(slot)}" guardado.`, 'success');
    } catch (err) {
      statusEl.textContent = 'Error al guardar.';
      this.toast(`❌ Error al guardar el video.`, 'error');
    }
  }

  _markSlotLoaded(slot) {
    const item     = document.getElementById(`slot-${slot}`);
    const statusEl = document.getElementById(`status-${slot}`);
    if (item) item.classList.add('loaded');
    if (statusEl) statusEl.textContent = '✓ Listo';

    const btn = document.querySelector(`[data-slot="${slot}"]`)?.closest('label');
    if (btn) btn.querySelector('.btn-text').textContent = 'Cambiar video';
  }

  _slotLabel(slot) {
    return { idle: 'Cara Neutral', izquierda: 'Izquierda', derecha: 'Derecha', sonrisa: 'Sonrisa' }[slot] || slot;
  }

  _updateStartBtn() {
    const total = Object.keys(this.loadedVideos).filter(k => this.loadedVideos[k]).length;
    const ready = total >= 4;
    this._el.startBtn.disabled = !ready;
    this._el.startBtnText.textContent = ready
      ? '¡Iniciar Avatar!'
      : `Carga los ${4 - total} video(s) restante(s)`;
  }

  async _goToAvatar() {
    this._el.setupScreen.classList.remove('active');
    this._el.avatarScreen.classList.add('active');

    // Detectar iOS Safari (sin soporte confiable de voz)
    this._checkIOS();

    // Inicializa VideoManager
    this.videoMgr = new VideoManager(this._el.videoA, this._el.videoB);
    this.videoMgr.setSources(this.loadedVideos);

    // En móvil, el autoplay puede estar bloqueado hasta que el usuario toca
    const tapOverlay = document.getElementById('tap-overlay');
    const played = await this.videoMgr.startIdle();

    if (!played) {
      // Autoplay bloqueado → mostrar overlay "Toca para activar"
      tapOverlay.style.display = 'flex';
      tapOverlay.addEventListener('click', async () => {
        tapOverlay.style.display = 'none';
        await this.videoMgr.startIdle();
        this._startSpeech();
      }, { once: true });
    } else {
      // Autoplay OK → iniciar directo
      this._startSpeech();
    }
  }

  /** Detecta iOS Safari y muestra el banner informativo */
  _checkIOS() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua);
    if (isIOS || isSafari) {
      const banner = document.getElementById('ios-banner');
      if (banner) {
        banner.style.display = 'flex';
        document.getElementById('ios-banner-close')?.addEventListener('click', () => {
          banner.style.display = 'none';
        });
      }
    }
  }

  _goToSetup() {
    if (this.speechMgr) this.speechMgr.stop();
    this._el.avatarScreen.classList.remove('active');
    this._el.setupScreen.classList.add('active');
  }

  _startSpeech() {
    // Mapeo de comandos: varias variantes → mismo gesto
    // Incluye variantes con/sin tilde y errores comunes de transcripción
    const commands = {
      'izquierda':  () => this._triggerGesture('izquierda'),
      'isquierda':  () => this._triggerGesture('izquierda'),  // error tipográfico frecuente
      'esquierda':  () => this._triggerGesture('izquierda'),
      'siquierda':  () => this._triggerGesture('izquierda'),
      'derecha':    () => this._triggerGesture('derecha'),
      'la derecha': () => this._triggerGesture('derecha'),
      'sonríe':     () => this._triggerGesture('sonrisa'),
      'sonrisa':    () => this._triggerGesture('sonrisa'),
      'sonrie':     () => this._triggerGesture('sonrisa'),
      'sonri':      () => this._triggerGesture('sonrisa'),
      'smile':      () => this._triggerGesture('sonrisa'),
      'ríe':        () => this._triggerGesture('sonrisa'),
    };

    try {
      this.speechMgr = new SpeechManager(
        commands,
        (text) => this._onTranscript(text),
        (status, msg) => this._onSpeechStatus(status, msg)
      );
      this.speechMgr.start();
    } catch (err) {
      this._onSpeechStatus('error', err.message);
      this.toast('❌ ' + err.message, 'error');
    }
  }

  async _triggerGesture(name) {
    if (!this.videoMgr || this.videoMgr.isGesturePlaying) return;

    const info = this._gestures[name];
    if (!info) return;

    await this.videoMgr.playGesture(
      name,
      () => {
        this._showGestureBadge(info.label);
        this._highlightBtn(info.btnId);
        this._el.avatarFrame.classList.add('gesture-active');
        this._el.soundWaves.classList.remove('active');
        this._showLastCommand(info.label);
      },
      () => {
        this._hideGestureBadge();
        this._unhighlightAll();
        this._el.avatarFrame.classList.remove('gesture-active');
        if (this.speechMgr && !this.speechMgr._sessionOpen) {
          this.speechMgr._doStart();
        }
      }
    );
  }

  // ─── Helpers de UI ───

  _onTranscript(text) {
    this._el.transcriptLive.textContent = text || '...';
  }

  _onSpeechStatus(status, msg) {
    const dot  = this._el.micDot;
    const txt  = this._el.micStatusText;
    txt.textContent = msg;
    dot.className   = 'mic-dot';

    if (status === 'listening') {
      dot.classList.add('listening');
      this._el.soundWaves.classList.add('active');
    } else if (status === 'error') {
      dot.classList.add('error');
      this._el.soundWaves.classList.remove('active');
    }
  }

  _showGestureBadge(label) {
    this._el.gestureLabel.textContent = label;
    this._el.gestureBadge.classList.add('visible');
  }

  _hideGestureBadge() {
    this._el.gestureBadge.classList.remove('visible');
  }

  _showLastCommand(text) {
    this._el.lastCmdChip.textContent = text;
    this._el.lastCmdPanel.style.display = 'flex';
  }

  _highlightBtn(btnId) {
    this._unhighlightAll();
    const el = document.getElementById(btnId);
    if (el) el.classList.add('highlight');
  }

  _unhighlightAll() {
    document.querySelectorAll('.manual-btn').forEach(el => el.classList.remove('highlight'));
  }

  toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    this._el.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
}

// ─── Arranque ───
document.addEventListener('DOMContentLoaded', () => {
  window.avatarApp = new AvatarApp();
});
