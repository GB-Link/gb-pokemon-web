import { GB_KEYS } from './GameBoyEmulator.js?v=100';

const KEYBOARD = {
    ArrowUp: GB_KEYS.UP, ArrowDown: GB_KEYS.DOWN, ArrowLeft: GB_KEYS.LEFT, ArrowRight: GB_KEYS.RIGHT,
    KeyX: GB_KEYS.A, KeyA: GB_KEYS.A, KeyZ: GB_KEYS.B, KeyS: GB_KEYS.B,
    Enter: GB_KEYS.START, ShiftLeft: GB_KEYS.SELECT, ShiftRight: GB_KEYS.SELECT, Backspace: GB_KEYS.SELECT,
};

// Standard gamepad layout, by position: right face button = A, bottom = B
const GAMEPAD_BUTTONS = [[1, GB_KEYS.A], [0, GB_KEYS.B], [9, GB_KEYS.START], [8, GB_KEYS.SELECT],
    [12, GB_KEYS.UP], [13, GB_KEYS.DOWN], [14, GB_KEYS.LEFT], [15, GB_KEYS.RIGHT]];

/**
 * Keyboard, gamepad and on-screen touch controls for the emulator. Keys are
 * only taken while isActive() says so and the focus is not in a text field.
 */
export class EmulatorInput {
    constructor(emulator, { isActive, touchArea, onGesture }) {
        this.emulator = emulator;
        this.isActive = isActive;
        this.onGesture = onGesture || (() => {});
        this.touchArea = touchArea;
        this._held = new Set();
        this._pointers = new Map();
        this._padTimer = null;
        this._onKeyDown = (e) => this._key(e, true);
        this._onKeyUp = (e) => this._key(e, false);
        this._onBlur = () => { this._held.clear(); this.emulator.setKeys('keyboard', 0); };
        this._onPad = () => this._watchGamepads();
        this._onPointer = (e) => this._pointer(e);
        this._onPointerEnd = (e) => this._pointerEnd(e);
    }

    attach() {
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('blur', this._onBlur);
        window.addEventListener('gamepadconnected', this._onPad);
        this._watchGamepads();
        if (this.touchArea) {
            this.touchArea.addEventListener('pointerdown', this._onPointer);
            this.touchArea.addEventListener('pointermove', this._onPointer);
            for (const type of ['pointerup', 'pointercancel', 'pointerleave']) this.touchArea.addEventListener(type, this._onPointerEnd);
            this.touchArea.addEventListener('contextmenu', (e) => e.preventDefault());
        }
    }

    detach() {
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        window.removeEventListener('blur', this._onBlur);
        window.removeEventListener('gamepadconnected', this._onPad);
        if (this._padTimer !== null) clearInterval(this._padTimer);
        this._padTimer = null;
        if (this.touchArea) {
            this.touchArea.removeEventListener('pointerdown', this._onPointer);
            this.touchArea.removeEventListener('pointermove', this._onPointer);
            for (const type of ['pointerup', 'pointercancel', 'pointerleave']) this.touchArea.removeEventListener(type, this._onPointerEnd);
        }
        this._onBlur();
        this._pointers.clear();
        this.emulator.setKeys('touch', 0);
        this.emulator.setKeys('gamepad', 0);
    }

    _typing() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    }

    _key(e, down) {
        const key = KEYBOARD[e.code];
        if (key === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
        if (down && (!this.isActive() || this._typing())) return;
        e.preventDefault();
        if (down) {
            this._held.add(e.code);
            this.onGesture();
        } else {
            this._held.delete(e.code);
        }
        let mask = 0;
        for (const code of this._held) mask |= KEYBOARD[code];
        this.emulator.setKeys('keyboard', mask);
    }

    _watchGamepads() {
        if (this._padTimer !== null || typeof navigator.getGamepads !== 'function') return;
        this._padTimer = setInterval(() => this._pollGamepads(), 16);
    }

    _pollGamepads() {
        let mask = 0;
        let any = false;
        for (const pad of navigator.getGamepads()) {
            if (!pad) continue;
            any = true;
            for (const [index, key] of GAMEPAD_BUTTONS) if (pad.buttons[index]?.pressed) mask |= key;
            const [x = 0, y = 0] = pad.axes;
            if (x < -0.5) mask |= GB_KEYS.LEFT;
            if (x > 0.5) mask |= GB_KEYS.RIGHT;
            if (y < -0.5) mask |= GB_KEYS.UP;
            if (y > 0.5) mask |= GB_KEYS.DOWN;
        }
        if (!any) {
            clearInterval(this._padTimer);
            this._padTimer = null;
        }
        this.emulator.setKeys('gamepad', this.isActive() ? mask : 0);
    }

    // Each finger presses whatever control is under it, so a thumb can slide across the D-pad
    _pointer(e) {
        if (e.type === 'pointermove' && !this._pointers.has(e.pointerId)) return;
        e.preventDefault();
        if (e.type === 'pointerdown') {
            this.onGesture();
            try { this.touchArea.setPointerCapture(e.pointerId); } catch (_) {}
        }
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-key]');
        this._pointers.set(e.pointerId, target && this.touchArea.contains(target) ? GB_KEYS[target.dataset.key] : 0);
        this._applyTouch();
    }

    _pointerEnd(e) {
        if (!this._pointers.has(e.pointerId)) return;
        this._pointers.delete(e.pointerId);
        this._applyTouch();
    }

    _applyTouch() {
        let mask = 0;
        for (const key of this._pointers.values()) mask |= key;
        for (const el of this.touchArea.querySelectorAll('[data-key]')) el.classList.toggle('pressed', (mask & GB_KEYS[el.dataset.key]) !== 0);
        this.emulator.setKeys('touch', mask);
    }
}
