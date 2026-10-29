/**
 * Game Boy emulator (mGBA's GB core compiled to WebAssembly, emulator/mgba-gb.*)
 * running in the page: frames, screen, sound, keys, battery save and the link
 * port. The link port is driven as clock master, the same way the GB-Link
 * adapter drives a real cartridge.
 *
 * Frames are paced by the sound output when sound is running (the audio
 * thread keeps going in background tabs), otherwise by requestAnimationFrame,
 * or timers while the page is hidden.
 */

export const GB_KEYS = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };

const FRAME_MS = 1000 * 70224 / 4194304;
const MAX_CATCH_UP_FRAMES = 6;
const LINK_NOT_READY = 0x100;
const SAVE_CHECK_FRAMES = 60;
const AUDIO_TARGET_SECONDS = 0.07;

export class GameBoyEmulator {
    static async create(moduleOptions = {}) {
        const { default: createGbEmu } = await import('../../emulator/mgba-gb.js?v=98');
        const options = { ...moduleOptions };
        if (!options.locateFile && typeof window !== 'undefined') {
            options.locateFile = (path) => new URL(`../../emulator/${path}?v=98`, import.meta.url).href;
        }
        return new GameBoyEmulator(await createGbEmu(options));
    }

    constructor(module) {
        this.m = module;
        this.loaded = false;
        this.running = false;
        this.frames = 0;
        this.onSaveChange = null;
        this.onFrame = null;
        this._keySources = new Map();
        this._linkQueue = [];
        this._linkWaiter = null;
        this._lastSave = null;
        this._canvas = null;
        this._ctx = null;
        this._image = null;
        this._drawPending = false;
        this._rafId = null;
        this._timerId = null;
        this._nextFrameAt = 0;
        this._audio = null;
        this._volume = 1;
        this._onVisibility = () => this._schedule();
        this.onResize = null;
    }

    /**
     * Loads a ROM (and battery save). Returns false when the core rejects it.
     * sgb: games that also run on a Game Boy Color start as on a Super Game Boy.
     */
    load(rom, save = null, { sgb = false } = {}) {
        const m = this.m;
        this._abortLink();
        m._emu_set_prefer_sgb(sgb ? 1 : 0);
        const romPtr = m._emu_alloc(rom.length);
        m.HEAPU8.set(rom, romPtr);
        let savePtr = 0;
        if (save && save.length) {
            savePtr = m._emu_alloc(save.length);
            m.HEAPU8.set(save, savePtr);
        }
        const rc = m._emu_load(romPtr, rom.length, savePtr, save ? save.length : 0);
        if (savePtr) m._emu_free(savePtr);
        this.loaded = rc === 0;
        this.frames = 0;
        if (this._audio) m._emu_set_sample_rate(this._audio.ctx.sampleRate);
        this._applyKeys();
        this._lastSave = this.loaded ? this.getSave() : null;
        return this.loaded;
    }

    unload() {
        this.stop();
        this._abortLink();
        this.m._emu_unload();
        this.loaded = false;
    }

    reset() {
        if (this.loaded) this.m._emu_reset();
    }

    /** True when the running game is in Super Game Boy mode (its colors, and a border if enabled). */
    get isSgb() {
        return this.loaded && this.m._emu_is_sgb() === 1;
    }

    /** True when the game has a Super Game Boy border (Gold and Silver keep their Game Boy Color colors inside it). */
    get hasBorder() {
        return this.loaded && this.m._emu_has_border() === 1;
    }

    /** Draws the game's Super Game Boy border around the screen (256x224 instead of 160x144). */
    setSgbBorder(on) {
        this.m._emu_set_sgb_border(on ? 1 : 0);
        this._drawPending = true;
    }

    getSave() {
        const m = this.m;
        const size = m._emu_save_size();
        if (size <= 0) return new Uint8Array(0);
        const ptr = m._emu_save_data();
        return m.HEAPU8.slice(ptr, ptr + size);
    }

    read8(address) {
        return this.m._emu_read8(address);
    }

    /** Keys from one input source (keyboard, gamepad, touch...); all sources are OR'ed. */
    setKeys(source, mask) {
        if (mask) this._keySources.set(source, mask);
        else this._keySources.delete(source);
        this._applyKeys();
    }

    _applyKeys() {
        let mask = 0;
        for (const v of this._keySources.values()) mask |= v;
        // Opposite directions at once confuse some games
        if ((mask & (GB_KEYS.LEFT | GB_KEYS.RIGHT)) === (GB_KEYS.LEFT | GB_KEYS.RIGHT)) mask &= ~(GB_KEYS.LEFT | GB_KEYS.RIGHT);
        if ((mask & (GB_KEYS.UP | GB_KEYS.DOWN)) === (GB_KEYS.UP | GB_KEYS.DOWN)) mask &= ~(GB_KEYS.UP | GB_KEYS.DOWN);
        if (this.loaded) this.m._emu_set_keys(mask);
    }

    /**
     * One clock-master transfer. Resolves with the byte the game shifted out,
     * or null when the game did not arm its port within a frame.
     */
    exchange(byte) {
        if (!this.loaded) return Promise.resolve(null);
        return new Promise((resolve) => {
            this._linkQueue.push({ byte: byte & 0xFF, resolve });
            this._pumpLink();
        });
    }

    _pumpLink() {
        if (this._linkWaiter || this._linkQueue.length === 0) return;
        const { byte, resolve } = this._linkQueue.shift();
        this._linkWaiter = resolve;
        this.m._emu_link_send(byte);
    }

    _abortLink() {
        const waiters = this._linkQueue.splice(0).map((q) => q.resolve);
        if (this._linkWaiter) waiters.unshift(this._linkWaiter);
        this._linkWaiter = null;
        for (const resolve of waiters) resolve(null);
    }

    /** Runs one frame. */
    step() {
        if (!this.loaded) return;
        const m = this.m;
        m._emu_frame();
        this.frames++;
        const samples = m._emu_audio();
        if (samples > 0 && this._audio) this._pushAudio(m._emu_audio_buffer() >> 1, samples);
        const result = m._emu_link_result();
        if (result >= 0 && this._linkWaiter) {
            const resolve = this._linkWaiter;
            this._linkWaiter = null;
            resolve(result === LINK_NOT_READY ? null : result);
            this._pumpLink();
        }
        if (this.frames % SAVE_CHECK_FRAMES === 0) this.checkSave();
        this._drawPending = true;
        if (this.onFrame) this.onFrame(this.frames);
    }

    /** Reports a changed battery save to onSaveChange now (it is also checked every second). */
    checkSave() {
        if (!this.onSaveChange) return;
        const save = this.getSave();
        const last = this._lastSave;
        if (last && last.length === save.length && last.every((v, i) => v === save[i])) return;
        this._lastSave = save;
        this.onSaveChange(save);
    }

    // ==================== Clock ====================

    start() {
        if (this.running || !this.loaded) return;
        this.running = true;
        this._nextFrameAt = performance.now();
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
        this._schedule();
    }

    stop() {
        this.running = false;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
        if (this._rafId !== null) cancelAnimationFrame(this._rafId);
        if (this._timerId !== null) clearTimeout(this._timerId);
        this._rafId = null;
        this._timerId = null;
    }

    _audioClock() {
        return this._audio && this._audio.ready && this._audio.ctx.state === 'running';
    }

    _schedule() {
        if (!this.running) return;
        const hidden = typeof document !== 'undefined' && document.hidden;
        if (typeof requestAnimationFrame === 'function' && !hidden) {
            if (this._rafId === null) this._rafId = requestAnimationFrame(() => { this._rafId = null; this._tick(); });
        } else if (this._timerId === null) {
            this._timerId = setTimeout(() => { this._timerId = null; this._tick(); }, FRAME_MS);
        }
    }

    _tick() {
        if (!this.running) return;
        if (!this._audioClock()) {
            const now = performance.now();
            let due = Math.floor((now - this._nextFrameAt) / FRAME_MS) + 1;
            if (due > MAX_CATCH_UP_FRAMES) {
                due = MAX_CATCH_UP_FRAMES;
                this._nextFrameAt = now;
            }
            for (let i = 0; i < due && this.running; i++) this.step();
            this._nextFrameAt += due * FRAME_MS;
        } else {
            this._nextFrameAt = performance.now();
        }
        this._draw();
        this._schedule();
    }

    // ==================== Screen ====================

    attachCanvas(canvas) {
        this._canvas = canvas;
        this._ctx = canvas ? canvas.getContext('2d') : null;
        this._image = null;
        this._drawPending = true;
        this._draw();
    }

    _draw() {
        if (!this._ctx || !this._drawPending || !this.loaded) return;
        this._drawPending = false;
        const m = this.m;
        const w = m._emu_video_width(), h = m._emu_video_height(), stride = m._emu_video_stride();
        if (this._canvas.width !== w || this._canvas.height !== h) {
            this._canvas.width = w;
            this._canvas.height = h;
            this._image = null;
            if (this.onResize) this.onResize(w, h);
        }
        if (!this._image) this._image = this._ctx.createImageData(w, h);
        const src = m.HEAPU8;
        const base = m._emu_video();
        const dst = this._image.data;
        for (let y = 0; y < h; y++) {
            const row = base + y * stride * 4;
            dst.set(src.subarray(row, row + w * 4), y * w * 4);
        }
        this._ctx.putImageData(this._image, 0, 0);
    }

    // ==================== Sound ====================

    /** Starts sound output; call from a user gesture. Frames then follow the sound clock. */
    async enableAudio() {
        if (this._audio || typeof AudioContext === 'undefined') {
            if (this._audio && this._audio.ctx.state !== 'running') await this._audio.ctx.resume().catch(() => {});
            return;
        }
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        const gain = ctx.createGain();
        gain.gain.value = this._volume;
        gain.connect(ctx.destination);
        this._audio = { ctx, gain, node: null, ready: false, pushed: 0, taken: 0, scratch: new Float32Array(8192) };
        this.m._emu_set_sample_rate(ctx.sampleRate);
        try {
            await ctx.audioWorklet.addModule(new URL('./audio-worklet.js?v=98', import.meta.url));
            const node = new AudioWorkletNode(ctx, 'gb-audio', { outputChannelCount: [2] });
            node.port.onmessage = (e) => this._onAudioTaken(e.data);
            node.connect(gain);
            this._audio.node = node;
            this._audio.ready = true;
        } catch (e) {
            console.warn('Emulator sound unavailable:', e);
        }
        if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    }

    setVolume(volume) {
        this._volume = volume;
        if (this._audio) this._audio.gain.gain.value = volume;
    }

    _onAudioTaken(taken) {
        if (!this.running || !this._audioClock()) return;
        const a = this._audio;
        a.taken = Math.max(a.taken, taken);
        const target = a.ctx.sampleRate * AUDIO_TARGET_SECONDS;
        let guard = MAX_CATCH_UP_FRAMES;
        while (a.pushed - a.taken < target && guard-- > 0 && this.running) this.step();
    }

    _pushAudio(offset, samples) {
        const a = this._audio;
        if (!a.ready) return;
        const n = samples * 2;
        const out = n <= a.scratch.length ? a.scratch.subarray(0, n) : new Float32Array(n);
        const src = this.m.HEAP16;
        for (let i = 0; i < n; i++) out[i] = src[offset + i] / 32768;
        a.node.port.postMessage(out.slice());
        a.pushed += samples;
    }

    destroy() {
        this.unload();
        if (this._audio) {
            this._audio.ctx.close().catch(() => {});
            this._audio = null;
        }
        this.attachCanvas(null);
    }
}
