/**
 * In-page emulator transport. It stands in for a GB-Link adapter: in active mode the
 * page clocks the game, and in passive mode (the game plays Player 1) the game drives
 * the clock and the adapter's passive mode answers it (emulator/PassiveAdapter.js).
 */
import { PassiveAdapter } from '../emulator/PassiveAdapter.js?v=104';
import { GbLinkPassive } from './GbLinkPassive.js?v=104';

export class EmulatorConnection {
    constructor(emulator) {
        this.emulator = emulator;
        this.isConnected = false;
        this.isNewFirmware = true;
        // A busy game answers "not ready", so battle choices are polled no faster than this
        this.minBattlePollMs = 50;
        this._frameQueue = [];
        this._frameWaiters = [];
        this._generation = 0;
        this._adapter = new PassiveAdapter();
        this._lastTrack = Promise.resolve();
        this.passiveLink = new GbLinkPassive(this);
    }

    async connect() {
        this.isConnected = true;
        this.emulator.setLinkClockHandler((sent) => this._onGameClock(sent));
        return true;
    }

    /** During a synchronous data exchange the game only runs when a byte is exchanged. */
    setLinkPaced(on) {
        this.emulator.setLinkPaced(on);
    }

    async disconnect() {
        this.isConnected = false;
        this._generation++;
        this.emulator.setLinkClockHandler(null);
        this._adapter = new PassiveAdapter();
        this.passiveLink.master = false;
        for (const w of this._frameWaiters.splice(0)) w.reject(new Error('Disconnected'));
        this._frameQueue = [];
    }

    // The game drives the clock: only the passive mode answers it
    _onGameClock(sent) {
        if (!this._adapter.passive) return -1;
        const answer = this._adapter.onGameClock(sent);
        this._takeFromAdapter();
        return answer;
    }

    _takeFromAdapter() {
        for (const frame of this._adapter.takeForHost()) this._pushFrame(new Uint8Array(frame));
    }

    // One write => exactly one reply frame, queued for the matching read.
    _track(bytes) {
        const generation = this._generation;
        this._lastTrack = Promise.all(Array.from(bytes, (b) => this.emulator.exchange(b))).then((replies) => {
            if (generation !== this._generation) return;
            this._pushFrame(new Uint8Array(replies.map((r) => r ?? 0x00)));
        });
    }

    _pushFrame(frame) {
        const waiter = this._frameWaiters.shift();
        if (waiter) waiter.resolve(frame);
        else this._frameQueue.push(frame);
    }

    _awaitFrame(timeoutMs) {
        if (this._frameQueue.length > 0) return Promise.resolve(this._frameQueue.shift());
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            this._frameWaiters.push(waiter);
            if (timeoutMs > 0) {
                setTimeout(() => {
                    const idx = this._frameWaiters.indexOf(waiter);
                    if (idx !== -1) {
                        this._frameWaiters.splice(idx, 1);
                        resolve(null);
                    }
                }, timeoutMs);
            }
        });
    }

    _write(bytes) {
        if (!this.isConnected) throw new Error('Not connected');
        if (this._adapter.passive) {
            this._adapter.queue(bytes);
            this._takeFromAdapter();
        } else {
            this._track(bytes);
        }
    }

    async writeByte(byte) {
        this._write([byte]);
    }

    async writeBytes(bytes) {
        this._write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }

    /** The adapter's GB Link commands, in turn with the data written before them. */
    async sendCommand(bytes) {
        if (!this.isConnected) throw new Error('Not connected');
        const command = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (!PassiveAdapter.isCommand(command[0])) return;
        await this._lastTrack;
        this._adapter.command(command);
        this._takeFromAdapter();
    }

    async readByte(timeoutMs = 2000) {
        const frame = await this._awaitFrame(timeoutMs);
        if (frame === null) {
            const err = new Error('The emulated Game Boy did not answer (is the game paused?)');
            err.isTimeout = true;
            throw err;
        }
        if (frame.length === 0) throw new Error('Read failed or empty');
        return frame[0];
    }

    async readBytes(length, timeoutMs = 2000) {
        const frame = await this._awaitFrame(timeoutMs);
        return frame || new Uint8Array(0);
    }

    async readBytesRaw(length = 64, timeoutMs = 100) {
        if (!this.isConnected) throw new Error('Not connected');
        const frame = await this._awaitFrame(timeoutMs);
        return frame || new Uint8Array(0);
    }

    async drain() {
        this._generation++;
        this._frameQueue = [];
    }

    // Voltage, LED and timing have no emulator equivalent; accept and ignore.
    async setVoltage() { return true; }

    async setLed() { return true; }

    async setTimingConfig() { return true; }

    async setMode() { return true; }

    async getFirmwareInfo() { return null; }
}
