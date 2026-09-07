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
   * @param {HTMLVideoElement} videoA - Video permanente de fondo (Idle)
   * @param {HTMLVideoElement} videoB - Video superpuesto para gestos
   */
  constructor(videoA, videoB) {
    this.vIdle    = videoA;
    this.vGesture = videoB;
    this.isGesturePlaying = false;
    this.idleSrc = null;
    this.gestureSrcs = {};

    // Silenciar y configurar clases iniciales
    this.vIdle.muted    = true;
    this.vGesture.muted = true;

    this.vIdle.className    = 'avatar-video v-idle';
    this.vGesture.className = 'avatar-video v-gesture';
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

  /** Inicia el loop del idle permanente */
  async startIdle() {
    this.vIdle.src         = this.idleSrc;
    this.vIdle.loop        = true;
    this.vIdle.playsInline = true;
    this.vIdle.muted       = true;

    try {
      await this.vIdle.play();
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Reproduce un gesto sobre el video idle de fondo con 0% pantalla negra.
   */
  async playGesture(gestureName, onStart, onEnd) {
    if (this.isGesturePlaying) return;
    const src = this.gestureSrcs[gestureName];
    if (!src) return;

    this.isGesturePlaying = true;

    // Asegurar que el idle de fondo esté reproduciéndose
    if (this.vIdle.paused) {
      this.vIdle.play().catch(() => {});
    }

    // Configurar video de gesto
    this.vGesture.src         = src;
    this.vGesture.loop        = false;
    this.vGesture.currentTime = 0;
    this.vGesture.playsInline = true;
    this.vGesture.muted       = true;

    // Esperar a que el video de gesto esté listo antes de hacerlo visible
    await new Promise((resolve) => {
      let doneCalled = false;
      const done = () => {
        if (!doneCalled) { doneCalled = true; resolve(); }
      };

      if (this.vGesture.readyState >= 3) {
        done();
      } else {
        this.vGesture.addEventListener('playing', done, { once: true });
        this.vGesture.addEventListener('canplaythrough', done, { once: true });
        setTimeout(done, 500);
      }
    });

    try { await this.vGesture.play(); } catch (_) {}

    // Esperar 2 frames de renderizado GPU
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Hacer visible el video de gesto encima del idle
    this.vGesture.classList.add('visible');

    if (onStart) onStart();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;

      this.vGesture.removeEventListener('timeupdate', onTick);
      this.vGesture.removeEventListener('ended', onEnded);

      // Ocultar gesto (vuelve a verse el idle de fondo de inmediato)
      this.vGesture.classList.remove('visible');

      // Pausar gesto tras desvanecer
      setTimeout(() => {
        try { this.vGesture.pause(); } catch (_) {}
        this.isGesturePlaying = false;
        if (onEnd) onEnd();
      }, 150);
    };

    const FADE_MARGIN = 0.15; // segundos antes de finalizar gesto
    const onTick = () => {
      if (!this.vGesture.duration) return;
      if (this.vGesture.duration - this.vGesture.currentTime <= FADE_MARGIN) {
        finish();
      }
    };
    const onEnded = () => finish();

    this.vGesture.addEventListener('timeupdate', onTick);
    this.vGesture.addEventListener('ended', onEnded, { once: true });
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
    this._keepAlive    = null;

    this._SR = SR;
    this._createInstance();
  }

  /** Crea una instancia nueva */
  _createInstance() {
    if (this.rec) {
      try { this.rec.abort(); } catch (_) {}
    }

    this.rec = new this._SR();
    this.rec.lang            = 'es-PE';
    this.rec.continuous      = true;   // Escucha continua activa siempre
    this.rec.interimResults  = true;   // Resultados parciales inmediatos
    this.rec.maxAlternatives = 5;

    this.rec.onstart  = ()  => this._onStart();
    this.rec.onresult = (e) => this._onResult(e);
    this.rec.onerror  = (e) => this._onError(e);
    this.rec.onend    = ()  => this._onEnd();
  }

  /** Inicia el ciclo de escucha continua e ininterrumpida */
  start() {
    this._active = true;
    this.onStatusChange('listening', '🔴 Micrófono Activo — Escuchando siempre');
    this._doStart();

    // Loop de respaldo continuo para reactivar al instante si Android la cierra
    clearInterval(this._keepAlive);
    this._keepAlive = setInterval(() => {
      if (this._active && !this._sessionOpen) {
        this._doStart();
      }
    }, 300);
  }

  /** Detiene completamente */
  stop() {
    this._active = false;
    clearInterval(this._keepAlive);
    try { this.rec.abort(); } catch (_) {}
    this._sessionOpen = false;
    this.onStatusChange('off', 'Detenido');
  }

  _doStart() {
    if (!this._active || this._sessionOpen) return;
    try {
      this.rec.start();
    } catch (e) {
      if (!e.message.includes('already started')) {
        this._createInstance();
        try { this.rec.start(); } catch (_) {}
      }
    }
  }

  _onStart() {
    this._sessionOpen = true;
    this.onStatusChange('listening', '🔴 Micrófono Activo — Escuchando siempre');
  }

  _onResult(e) {
    let latestText = '';

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      for (let a = 0; a < res.length; a++) {
        const text = res[a].transcript.toLowerCase().trim();
        if (!latestText) latestText = text;

        if (this._matchCommand(text)) {
          this.onTranscript(text);
          return;
        }
      }
    }

    if (latestText) {
      this.onTranscript(latestText);
    }
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
    // Si no es un error de permiso fatal, mantener la sesión como abierta visualmente
    if (['not-allowed', 'audio-capture', 'service-not-allowed'].includes(e.error)) {
      this._active = false;
      this._sessionOpen = false;
      clearInterval(this._keepAlive);
      const msgs = {
        'not-allowed':         '❌ Permiso de micrófono denegado.',
        'audio-capture':       '❌ No se encontró micrófono.',
        'service-not-allowed': '❌ Reconocimiento de voz bloqueado.',
      };
      this.onStatusChange('error', msgs[e.error] || `Error: ${e.error}`);
      return;
    }

    // Para cualquier otro corte de red o no-speech, reactivar de inmediato
    this._sessionOpen = false;
    this._doStart();
  }

  _onEnd() {
    this._sessionOpen = false;
    if (!this._active) return;
    // Si la sesión finalizó normalmente, reactivarla inmediatamente
    this._doStart();
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
    // Mapeo de comandos ultrarrápidos (coincide desde la primera sílaba)
    const commands = {
      'izq':        () => this._triggerGesture('izquierda'),
      'izquierd':   () => this._triggerGesture('izquierda'),
      'izquierda':  () => this._triggerGesture('izquierda'),
      'isquierda':  () => this._triggerGesture('izquierda'),
      'esquierda':  () => this._triggerGesture('izquierda'),
      'siquierda':  () => this._triggerGesture('izquierda'),

      'der':        () => this._triggerGesture('derecha'),
      'derec':      () => this._triggerGesture('derecha'),
      'derecha':    () => this._triggerGesture('derecha'),
      'la derecha': () => this._triggerGesture('derecha'),

      'sonr':       () => this._triggerGesture('sonrisa'),
      'sonri':      () => this._triggerGesture('sonrisa'),
      'sonrí':      () => this._triggerGesture('sonrisa'),
      'sonríe':     () => this._triggerGesture('sonrisa'),
      'sonrisa':    () => this._triggerGesture('sonrisa'),
      'sonrie':     () => this._triggerGesture('sonrisa'),
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
