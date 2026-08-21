/**
 * BGB emulator transport.
 *
 * Exposes the same public API as UsbConnection/SerialConnection, but exchanges
 * bytes with the BGB emulator's link port instead of a real Game Boy, through
 * the raw TCP bridge (window.gblinkBGB) that the GB-Link BGB desktop app
 * injects on gblink.io pages.
 *
 * BgbLinkEngine implements BGB's link protocol (https://bgb.bircd.org/bgblink.html),
 * ported from the reference in PokemonGB_Online_Trades
 * utilities/bgb_link_cable_server.py. Packets are a fixed 8 bytes, little
 * endian: command, b2, b3, b4, u32 timestamp. This side is always the SPI
 * clock master (like the physical adapter), so one byte exchange is one
 * sync1 (104) out and one sync2 (105) back.
 */

const BGB_TICKS_PER_MS = (1 << 21) / 1000;

class BgbLinkEngine {
    constructor(pipe, { onFatal } = {}) {
        this.pipe = pipe;
        this.onFatal = onFatal || (() => {});
        this.closed = false;
        this.canGo = false;
        this._closeMessage = 'BGB disconnected';
        this._staging = new Uint8Array(8);
        this._stagingLen = 0;
        this._peerTs = 0;
        this._anchorTicks = this._nowTicks();
        this._pending = [];
        this._versionSeen = false;
        this._versionWaiters = [];
        this._pumpTimer = null;
        this._offData = pipe.onData((bytes) => this._feed(bytes));
        this._offClose = pipe.onClose((reason) => this._fail(`BGB connection closed (${reason})`));
    }

    start() {
        this._sendPacket(1, 1, 4, 0, 0);
        this._pumpTimer = setInterval(() => this._pumpTick(), 10);
    }

    waitForHandshake(timeoutMs = 3000) {
        if (this._versionSeen) return Promise.resolve();
        if (this.closed) return Promise.reject(new Error(this._closeMessage));
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            this._versionWaiters.push(waiter);
            setTimeout(() => {
                const idx = this._versionWaiters.indexOf(waiter);
                if (idx !== -1) {
                    this._versionWaiters.splice(idx, 1);
                    reject(new Error('Connected, but BGB never completed the handshake.'));
                }
            }, timeoutMs);
        });
    }

    /** One master transfer; resolves with the byte BGB's Game Boy shifted out. */
    exchange(byte) {
        return new Promise((resolve, reject) => {
            if (this.closed) { reject(new Error(this._closeMessage)); return; }
            this._pending.push({ app: true, resolve, reject });
            this._sendPacket(104, byte & 0xFF, 0x80, 0, this._anchoredTs());
        });
    }

    /**
     * Mark every in-flight exchange discard-on-arrival. Entries stay in the
     * FIFO so their replies still consume their slot and later replies keep
     * their alignment.
     */
    discardPending() {
        for (const p of this._pending) p.app = false;
    }

    stop() {
        this._teardown(null);
    }

    _nowTicks() {
        return performance.now() * BGB_TICKS_PER_MS;
    }

    _anchoredTs() {
        return (this._peerTs + Math.round(this._nowTicks() - this._anchorTicks)) & 0x7FFFFFFF;
    }

    _sendPacket(b1, b2, b3, b4, ts) {
        if (this.closed) return;
        const p = new Uint8Array(8);
        p[0] = b1; p[1] = b2; p[2] = b3; p[3] = b4;
        p[4] = ts & 0xFF;
        p[5] = (ts >>> 8) & 0xFF;
        p[6] = (ts >>> 16) & 0xFF;
        p[7] = (ts >>> 24) & 0xFF;
        this.pipe.send(p);
    }

    // TCP chunk boundaries are arbitrary; reassemble fixed 8-byte packets.
    _feed(chunk) {
        let i = 0;
        while (i < chunk.length) {
            const take = Math.min(8 - this._stagingLen, chunk.length - i);
            this._staging.set(chunk.subarray(i, i + take), this._stagingLen);
            this._stagingLen += take;
            i += take;
            if (this._stagingLen === 8) {
                this._stagingLen = 0;
                this._handlePacket(this._staging);
            }
        }
    }

    _handlePacket(p) {
        const b1 = p[0], b2 = p[1], b3 = p[2], b4 = p[3];
        const ts = (p[4] | (p[5] << 8) | (p[6] << 16) | (p[7] << 24)) >>> 0;
        if (ts !== 0) {
            this._peerTs = ts & 0x7FFFFFFF;
            this._anchorTicks = this._nowTicks();
        }
        switch (b1) {
            case 1: // version
                if (b2 !== 1 || b3 !== 4 || b4 !== 0) {
                    this._fail(`Unsupported BGB protocol version ${b2}.${b3}.${b4} (need 1.4.0)`);
                    return;
                }
                this._versionSeen = true;
                for (const w of this._versionWaiters.splice(0)) w.resolve();
                this._sendStatus();
                break;
            case 101: // joypad
                break;
            case 104: // sync1: the emulated game briefly drove the clock
                this._sendPacket(105, 0, 0x80, 0, this._peerTs);
                break;
            case 105: // sync2: slave data answering our master transfer
                this._resolveExchange(b2);
                break;
            case 106: // sync3
                if (b2 === 1) {
                    // BGB's "no slave byte armed" answer to a sync1; also the
                    // first sign the link is live.
                    if (!this.canGo) {
                        this.canGo = true;
                        console.log('BGB link live');
                    }
                    this._resolveExchange(0x00);
                } else {
                    this._sendPacket(106, b2, b3, b4, this._anchoredTs());
                }
                break;
            case 108: // status: reply in kind (doc says don't; the reference
                      // found the link unstable without it)
                this._sendStatus();
                break;
            case 109:
                console.log('BGB requested disconnect');
                break;
        }
    }

    _resolveExchange(byte) {
        const p = this._pending.shift();
        if (p && p.app) p.resolve(byte);
    }

    _pumpTick() {
        if (this.closed) return;
        if (this._peerTs === 0) {
            this._sendPacket(106, 0, 0, 0, this._anchoredTs());
        } else if (!this.canGo && this._pending.length === 0) {
            // Keep pumping zero transfers until the emulated game arms its
            // link port, like the reference's idle sender.
            this._pending.push({ app: false });
            this._sendPacket(104, 0, 0x80, 0, this._anchoredTs());
        }
    }

    _sendStatus() {
        this._sendPacket(108, 1, 0, 0, this._peerTs);
    }

    _fail(message) {
        this._teardown(message);
    }

    _teardown(message) {
        if (this.closed) return;
        this.closed = true;
        if (message) this._closeMessage = message;
        if (this._pumpTimer !== null) clearInterval(this._pumpTimer);
        try { this._offData(); } catch (_) {}
        try { this._offClose(); } catch (_) {}
        const err = new Error(this._closeMessage);
        for (const p of this._pending.splice(0)) {
            if (p.app) p.reject(err);
        }
        for (const w of this._versionWaiters.splice(0)) w.reject(err);
        try { this.pipe.disconnect(); } catch (_) {}
        if (message) this.onFatal(message);
    }
}

function describeBridgeFailure(st, target) {
    switch (st.reason) {
        case 'refused':
        case 'timeout':
            return `Could not reach BGB at ${target.host}:${target.port}. Is BGB running with Link > Listen enabled?`;
        case 'addr-in-use':
            return `Port ${target.port} is already in use by another program.`;
        case 'not-allowed':
            return 'Only local addresses are allowed.';
        case 'busy':
            return 'A BGB connection is already active.';
        case 'peer-closed':
        case 'reset':
            return 'BGB closed the connection.';
        default:
            return `BGB bridge error${st.detail ? ` (${st.detail})` : ''}.`;
    }
}

export class BgbConnection {
    constructor(target) {
        this.isConnected = false;
        this.isNewFirmware = true;
        this._target = Object.assign({ mode: 'connect', host: '127.0.0.1', port: 8765 }, target);
        this._engine = null;
        this._fatalMessage = null;
        this._frameQueue = [];
        this._frameWaiters = [];
    }

    async connect() {
        const bridge = window.gblinkBGB;
        if (!bridge || bridge.version < 1) {
            throw new Error('BGB play requires the GB-Link desktop app (gblink.io/bgb).');
        }
        if (BgbConnection._active) {
            throw new Error('A BGB connection is already active.');
        }
        BgbConnection._active = this;
        try {
            await this._openBridge(bridge);
            this._engine = new BgbLinkEngine(this._makePipe(bridge), {
                onFatal: (message) => this._onFatal(message)
            });
            this._engine.start();
            await this._engine.waitForHandshake(3000);
            this.isConnected = true;
            console.log('BGB link established (protocol 1.4.0)');
            return true;
        } catch (error) {
            if (BgbConnection._active === this) BgbConnection._active = null;
            if (this._engine) {
                this._engine.stop();
                this._engine = null;
            } else {
                try { await bridge.close(); } catch (_) {}
            }
            console.error('BGB connection failed:', error);
            throw error;
        }
    }

    async disconnect() {
        this.isConnected = false;
        if (BgbConnection._active === this) BgbConnection._active = null;
        if (this._engine) {
            this._engine.stop();
            this._engine = null;
        }
        for (const w of this._frameWaiters.splice(0)) w.reject(new Error('Disconnected'));
        this._frameQueue = [];
    }

    async _openBridge(bridge) {
        // Reclaim the bridge from an abandoned transport (e.g. reconnect after
        // an error screen) — only one session exists per page.
        const prior = await bridge.getState();
        if (prior.state !== 'idle') await bridge.close();
        const t = this._target;
        if (t.mode === 'listen') {
            const st = await bridge.listen({ port: t.port });
            if (st.state !== 'listening') throw new Error(describeBridgeFailure(st, t));
            console.log(`Waiting for BGB - in BGB use Link > Connect (127.0.0.1:${t.port})`);
            await this._waitForPeer(bridge, 60000);
        } else {
            const st = await bridge.connect({ host: t.host, port: t.port });
            if (st.state !== 'connected') throw new Error(describeBridgeFailure(st, t));
        }
    }

    _waitForPeer(bridge, timeoutMs) {
        const t = this._target;
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (fn, arg) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                unsubscribe();
                fn(arg);
            };
            const unsubscribe = bridge.onStatus((st) => {
                if (st.state === 'connected') finish(resolve);
                else if (st.state === 'idle') finish(reject, new Error(describeBridgeFailure(st, t)));
            });
            const timer = setTimeout(() => {
                bridge.close();
                finish(reject, new Error(`BGB never connected to port ${t.port}. In BGB use Link > Connect (127.0.0.1:${t.port}).`));
            }, timeoutMs);
        });
    }

    _makePipe(bridge) {
        return {
            send: (bytes) => bridge.send(bytes),
            onData: (cb) => bridge.onData(cb),
            onClose: (cb) => bridge.onStatus((st) => {
                if (st.state === 'idle') cb(st.reason || 'closed');
            }),
            disconnect: () => { bridge.close(); }
        };
    }

    // One write => exactly one reply frame, queued for the matching read.
    // A timed-out reply stays queued and is consumed by the next read, which
    // TradingProtocol.exchangeByte's retry loop depends on.
    _track(promises) {
        Promise.all(promises).then(
            (replies) => this._pushFrame(new Uint8Array(replies)),
            () => {} // fatal close already surfaced through _onFatal
        );
    }

    _pushFrame(frame) {
        const waiter = this._frameWaiters.shift();
        if (waiter) waiter.resolve(frame);
        else this._frameQueue.push(frame);
    }

    _awaitFrame(timeoutMs) {
        // After a lost link, fail fast (non-timeout) so the protocols abort
        // instead of retrying 2s timeouts against a dead connection.
        if (this._fatalMessage !== null) return Promise.reject(new Error(this._fatalMessage));
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
        if (!this._engine) throw new Error('Not connected');
        this._track([this._engine.exchange(byte)]);
    }

    async writeBytes(bytes) {
        if (!this._engine) throw new Error('Not connected');
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this._track(Array.from(buf, (b) => this._engine.exchange(b)));
    }

    async readByte(timeoutMs = 2000) {
        const frame = await this._awaitFrame(timeoutMs);
        if (frame === null) {
            const err = new Error(`BGB read timed out after ${timeoutMs}ms`);
            err.isTimeout = true;
            throw err;
        }
        if (!frame || frame.length === 0) throw new Error('Read failed or empty');
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
        this._frameQueue = [];
        if (this._engine) this._engine.discardPending();
    }

    // Firmware configuration has no BGB equivalent; accept and ignore.
    async setVoltage() { return true; }

    async setLed() { return true; }

    async setTimingConfig() { return true; }

    async setMode() { return true; }

    async getFirmwareInfo() { return null; }

    _onFatal(message) {
        this.isConnected = false;
        if (BgbConnection._active === this) BgbConnection._active = null;
        this._engine = null;
        this._fatalMessage = message;
        console.error('BGB link lost:', message);
        for (const w of this._frameWaiters.splice(0)) w.reject(new Error(message));
    }
}

BgbConnection._active = null;
