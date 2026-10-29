/**
 * In-page emulator transport.
 */
export class EmulatorConnection {
    constructor(emulator) {
        this.emulator = emulator;
        this.isConnected = false;
        this.isNewFirmware = true;
        // Same pacing as BGB: a busy game answers "not ready"
        this.minBattlePollMs = 50;
        this.onLinkLost = null;
        this._frameQueue = [];
        this._frameWaiters = [];
        this._generation = 0;
    }

    async connect() {
        this.isConnected = true;
        return true;
    }

    /** During a synchronous data exchange the game only runs when a byte is exchanged. */
    setLinkPaced(on) {
        this.emulator.setLinkPaced(on);
    }

    async disconnect() {
        this.isConnected = false;
        this._generation++;
        for (const w of this._frameWaiters.splice(0)) w.reject(new Error('Disconnected'));
        this._frameQueue = [];
    }

    // One write => exactly one reply frame, queued for the matching read.
    _track(bytes) {
        const generation = this._generation;
        Promise.all(Array.from(bytes, (b) => this.emulator.exchange(b))).then((replies) => {
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

    async writeByte(byte) {
        if (!this.isConnected) throw new Error('Not connected');
        this._track([byte]);
    }

    async writeBytes(bytes) {
        if (!this.isConnected) throw new Error('Not connected');
        this._track(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
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

    // Firmware configuration has no emulator equivalent; accept and ignore.
    async setVoltage() { return true; }

    async setLed() { return true; }

    async setTimingConfig() { return true; }

    async setMode() { return true; }

    async getFirmwareInfo() { return null; }
}
