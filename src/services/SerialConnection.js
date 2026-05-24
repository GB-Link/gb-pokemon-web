/**
 * Serial Connection for WebSerial (Firefox + Chromium).
 *
 * Exposes the same public API as UsbConnection so callers (RBYTrading,
 * GSCTrading, RSESPTrading, Multiboot) don't need to know which transport
 * is in use.
 *
 * CDC-ACM is a single bidirectional byte stream — packet boundaries are not
 * preserved. The firmware (SerialLayer) wraps each logical message in a
 * frame; this class parses those frames and reconstructs the same per-call
 * shape WebUSB delivers per endpoint.
 *
 *   | 0x47 0x42 | channel:1 | len:2 LE | payload[len] |
 *     sync 'GB'   0=cmd,1=data,2=status
 */

import { CMD, MODE } from './UsbConnection.js';
export { CMD, MODE };

const SYNC_0 = 0x47; // 'G'
const SYNC_1 = 0x42; // 'B'
const CH_COMMAND = 0x00;
const CH_DATA = 0x01;
const CH_STATUS = 0x02;
const MAX_PAYLOAD = 64;

export class SerialConnection {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;
        this.isNewFirmware = true;

        this._dataQueue = [];
        this._dataWaiters = [];
        this._statusQueue = [];
        this._statusWaiters = [];

        this._rxState = 'sync1';
        this._rxChannel = 0;
        this._rxLen = 0;
        this._rxBuf = null;
        this._rxPos = 0;

        this._readLoopPromise = null;
    }

    async connect() {
        try {
            if (!navigator.serial) {
                throw new Error('WebSerial is not supported. Use Firefox 151+, Chrome, or Edge.');
            }
            this.port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: 0x2FE3 }]
            });
            await this.port.open({ baudRate: 115200 });

            this.writer = this.port.writable.getWriter();
            this.reader = this.port.readable.getReader();
            this.isConnected = true;

            this._readLoopPromise = this._runReadLoop();
            console.log('Firmware: GBLink Unified (WebSerial)');
            return true;
        } catch (error) {
            console.error('Serial connection failed:', error);
            this.isConnected = false;
            throw error;
        }
    }

    async disconnect() {
        this.isConnected = false;
        try {
            if (this.reader) {
                try { await this.reader.cancel(); } catch (_) {}
                try { this.reader.releaseLock(); } catch (_) {}
                this.reader = null;
            }
            if (this.writer) {
                try { this.writer.releaseLock(); } catch (_) {}
                this.writer = null;
            }
            if (this.port) {
                try { await this.port.close(); } catch (_) {}
                this.port = null;
            }
        } catch (e) {
            console.warn('Disconnect warning:', e);
        }
        for (const w of this._dataWaiters) w.reject(new Error('Disconnected'));
        for (const w of this._statusWaiters) w.reject(new Error('Disconnected'));
        this._dataWaiters = [];
        this._statusWaiters = [];
        this._dataQueue = [];
        this._statusQueue = [];
    }

    async _runReadLoop() {
        try {
            while (this.isConnected && this.reader) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                for (let i = 0; i < value.length; i++) this._feedByte(value[i]);
            }
        } catch (e) {
            if (this.isConnected) console.warn('Serial read loop error:', e);
        }
    }

    _feedByte(b) {
        switch (this._rxState) {
            case 'sync1':
                if (b === SYNC_0) this._rxState = 'sync2';
                break;
            case 'sync2':
                if (b === SYNC_1) this._rxState = 'channel';
                else if (b === SYNC_0) this._rxState = 'sync2';
                else this._rxState = 'sync1';
                break;
            case 'channel':
                this._rxChannel = b;
                this._rxState = 'lenLo';
                break;
            case 'lenLo':
                this._rxLen = b;
                this._rxState = 'lenHi';
                break;
            case 'lenHi':
                this._rxLen |= b << 8;
                if (this._rxLen > MAX_PAYLOAD) { this._rxState = 'sync1'; break; }
                this._rxPos = 0;
                this._rxBuf = new Uint8Array(this._rxLen);
                if (this._rxLen === 0) {
                    this._dispatchFrame();
                    this._rxState = 'sync1';
                } else {
                    this._rxState = 'payload';
                }
                break;
            case 'payload':
                this._rxBuf[this._rxPos++] = b;
                if (this._rxPos >= this._rxLen) {
                    this._dispatchFrame();
                    this._rxState = 'sync1';
                }
                break;
        }
    }

    _dispatchFrame() {
        const frame = this._rxBuf;
        if (this._rxChannel === CH_DATA) {
            const waiter = this._dataWaiters.shift();
            if (waiter) waiter.resolve(frame);
            else this._dataQueue.push(frame);
        } else if (this._rxChannel === CH_STATUS) {
            const waiter = this._statusWaiters.shift();
            if (waiter) waiter.resolve(frame);
            else this._statusQueue.push(frame);
        }
    }

    async _writeFrame(channel, payload) {
        if (!this.isConnected || !this.writer) throw new Error('Not connected');
        if (payload.length > MAX_PAYLOAD) throw new Error('Payload too large');
        const frame = new Uint8Array(5 + payload.length);
        frame[0] = SYNC_0;
        frame[1] = SYNC_1;
        frame[2] = channel;
        frame[3] = payload.length & 0xFF;
        frame[4] = (payload.length >> 8) & 0xFF;
        frame.set(payload, 5);
        await this.writer.write(frame);
    }

    _awaitChannel(queue, waiters, timeoutMs) {
        if (queue.length > 0) return Promise.resolve(queue.shift());
        return new Promise((resolve) => {
            const waiter = { resolve, reject: resolve };
            waiters.push(waiter);
            if (timeoutMs > 0) {
                setTimeout(() => {
                    const idx = waiters.indexOf(waiter);
                    if (idx !== -1) {
                        waiters.splice(idx, 1);
                        resolve(null);
                    }
                }, timeoutMs);
            }
        });
    }

    async sendCommand(bytes) {
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        await this._writeFrame(CH_COMMAND, buf);
    }

    async readCommandResponse(timeoutMs = 500) {
        if (!this.isConnected) return null;
        return await this._awaitChannel(this._statusQueue, this._statusWaiters, timeoutMs);
    }

    async writeByte(byte) {
        await this.writeBytes(new Uint8Array([byte]));
    }

    async writeBytes(bytes) {
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        await this._writeFrame(CH_DATA, buf);
    }

    async readByte() {
        const frame = await this._awaitChannel(this._dataQueue, this._dataWaiters, 0);
        if (!frame || frame.length === 0) throw new Error('Read failed or empty');
        return frame[0];
    }

    async readBytes(length) {
        const frame = await this._awaitChannel(this._dataQueue, this._dataWaiters, 0);
        return frame || new Uint8Array(0);
    }

    async readBytesRaw(length = 64, timeoutMs = 100) {
        if (!this.isConnected) throw new Error('Not connected');
        const frame = await this._awaitChannel(this._dataQueue, this._dataWaiters, timeoutMs);
        return frame || new Uint8Array(0);
    }

    async setVoltage(mode) {
        if (!this.isConnected) return false;
        const cmd = mode === '5v' ? CMD.SET_VOLTAGE_5V : CMD.SET_VOLTAGE_3V3;
        await this.sendCommand(new Uint8Array([cmd]));
        console.log(`Voltage set to ${mode}`);
        return true;
    }

    async setLed(r, g, b, on = true) {
        if (!this.isConnected) return false;
        await this.sendCommand(new Uint8Array([CMD.SET_LED_COLOR, r, g, b, on ? 1 : 0]));
        return true;
    }

    async setTimingConfig(usBetweenTransfer, bytesPerTransfer) {
        if (!this.isConnected) return false;
        await this.sendCommand(new Uint8Array([
            CMD.SET_TIMING_CONFIG,
            usBetweenTransfer & 0xFF,
            (usBetweenTransfer >> 8) & 0xFF,
            (usBetweenTransfer >> 16) & 0xFF,
            bytesPerTransfer & 0xFF
        ]));
        return true;
    }

    async setMode(mode) {
        if (!this.isConnected) return false;
        await this.sendCommand(new Uint8Array([CMD.SET_MODE, mode]));
        return true;
    }

    async getFirmwareInfo() {
        if (!this.isConnected) return null;
        await this.sendCommand(new Uint8Array([CMD.GET_FIRMWARE_INFO]));
        const resp = await this._awaitChannel(this._dataQueue, this._dataWaiters, 1000);
        if (resp && resp.length >= 4 && resp[0] === 0x0F) {
            return { major: resp[1], minor: resp[2], patch: resp[3] };
        }
        return null;
    }
}
