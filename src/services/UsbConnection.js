/**
 * USB Connection for WebUSB
 * Supports both old (reconfigurable, TinyUSB, VID 0xCAFE) and
 * new (GBLink unified, Zephyr, VID 0x2FE3) firmware.
 */

// Check firmware version from USB device descriptor (bcdDevice)
function fwVersionAtLeast(device, minMajor, minMinor, minPatch) {
    if (!device) return false;
    const major = device.deviceVersionMajor || 0;
    const minor = device.deviceVersionMinor || 0;
    const patch = device.deviceVersionSubminor || 0;
    if (major !== minMajor) return major > minMajor;
    if (minor !== minMinor) return minor > minMinor;
    return patch >= minPatch;
}

// --- Old firmware magic packets (reconfigurable firmware) ---
const MAGIC_PREFIX = new Uint8Array([
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF
]);

function buildVswitchPacket(suffix) {
    const packet = new Uint8Array(36);
    packet.set(MAGIC_PREFIX);
    packet.set(new TextEncoder().encode(suffix), 32);
    return packet;
}

const VSWITCH_3V3_PACKET = buildVswitchPacket('V3V3');
const VSWITCH_5V_PACKET = buildVswitchPacket('V5V0');

const LED_PREFIX = new Uint8Array([...MAGIC_PREFIX, 0x4C, 0x45, 0x44, 0x53]); // "LEDS"

function buildLedPacket(r, g, b, on) {
    const packet = new Uint8Array(40);
    packet.set(LED_PREFIX);
    packet[36] = r; packet[37] = g; packet[38] = b; packet[39] = on ? 1 : 0;
    return packet;
}

// --- New firmware command IDs (GBLink unified firmware) ---
export const CMD = {
    SET_MODE: 0x00,
    CANCEL: 0x01,
    GET_FIRMWARE_INFO: 0x0F,
    SET_TIMING_CONFIG: 0x30,
    SET_VOLTAGE_3V3: 0x40,
    SET_VOLTAGE_5V: 0x41,
    SET_LED_COLOR: 0x42,
};

export const MODE = {
    GBA_TRADE_EMU: 0x00,
    GBA_LINK: 0x01,
    GB_LINK: 0x02,
};

export class UsbConnection {
    constructor() {
        this.device = null;
        this.interfaceNumber = 0;
        this.endpointIn = 0;    // Data IN
        this.endpointOut = 0;    // Data OUT
        this.cmdEndpointIn = 0;    // Command/Status IN  (new firmware only)
        this.cmdEndpointOut = 0;    // Command OUT        (new firmware only)
        this.isConnected = false;
        this.isNewFirmware = false;
        this._pendingDataIn = null; // in-flight transferIn on the data endpoint
    }

    /**
     * Single-reader transferIn on the data endpoint.
     * A timed-out transfer is kept pending and consumed by the next read, so a
     * late packet is delivered in order instead of being swallowed by an
     * abandoned zombie transfer (which would shift every subsequent read).
     * Always requests at least 64 bytes: transferIn length is a maximum, and
     * requesting less than a full packet errors the transfer (babble).
     */
    async _dataTransferIn(length, timeoutMs) {
        if (!this._pendingDataIn) {
            this._pendingDataIn = this.device.transferIn(this.endpointIn, Math.max(length, 64));
        }
        const pending = this._pendingDataIn;

        if (!(timeoutMs > 0)) {
            try {
                const result = await pending;
                if (this._pendingDataIn === pending) this._pendingDataIn = null;
                return result;
            } catch (e) {
                if (this._pendingDataIn === pending) this._pendingDataIn = null;
                throw e;
            }
        }

        let timer = null;
        const timedOut = {};
        try {
            const winner = await Promise.race([
                pending,
                new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), timeoutMs); })
            ]);
            if (winner === timedOut) {
                const err = new Error(`USB read timed out after ${timeoutMs}ms`);
                err.isTimeout = true;
                throw err; // transfer stays in _pendingDataIn for the next read
            }
            if (this._pendingDataIn === pending) this._pendingDataIn = null;
            return winner;
        } catch (e) {
            if (!e.isTimeout && this._pendingDataIn === pending) this._pendingDataIn = null;
            throw e;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    async connect() {
        try {
            if (!navigator.usb) {
                throw new Error('WebUSB is not supported. Please use Chrome or Edge.');
            }

            const filters = [
                { vendorId: 0xCAFE },  // Old reconfigurable firmware (TinyUSB)
                { vendorId: 0x239A },  // Adafruit boards
                { vendorId: 0x2FE3 }   // GBLink unified firmware (Zephyr default VID)
            ];

            this.device = await navigator.usb.requestDevice({ filters });
            await this.device.open();

            // Reset stale connection from a previous page load
            if (this.device.reset) {
                await this.device.reset().catch(e =>
                    console.warn('Device reset failed (non-fatal):', e)
                );
            }

            await this.device.selectConfiguration(1);

            // Detect firmware by VID
            this.isNewFirmware = (this.device.vendorId === 0x2FE3);

            // Find the vendor class interface and map endpoints
            const interfaces = this.device.configuration.interfaces;
            let foundInterface = false;

            for (const iface of interfaces) {
                for (const alt of iface.alternates) {
                    if (alt.interfaceClass !== 0xFF) continue;

                    this.interfaceNumber = iface.interfaceNumber;

                    const inEps = alt.endpoints
                        .filter(ep => ep.direction === 'in')
                        .sort((a, b) => a.endpointNumber - b.endpointNumber);
                    const outEps = alt.endpoints
                        .filter(ep => ep.direction === 'out')
                        .sort((a, b) => a.endpointNumber - b.endpointNumber);

                    if (this.isNewFirmware && inEps.length >= 2 && outEps.length >= 2) {
                        // EP1 = commands, EP2 = data  (per firmware source)
                        this.cmdEndpointOut = outEps[0].endpointNumber;
                        this.cmdEndpointIn = inEps[0].endpointNumber;
                        this.endpointOut = outEps[1].endpointNumber;
                        this.endpointIn = inEps[1].endpointNumber;
                        console.log(`New firmware: cmd=EP${this.cmdEndpointOut} data=EP${this.endpointOut}`);
                    } else {
                        if (outEps.length > 0) this.endpointOut = outEps[0].endpointNumber;
                        if (inEps.length > 0) this.endpointIn = inEps[0].endpointNumber;
                    }

                    foundInterface = true;
                    break;
                }
                if (foundInterface) break;
            }

            if (!foundInterface) {
                throw new Error('Could not find compatible USB interface (Class 0xFF)');
            }

            await this.device.claimInterface(this.interfaceNumber);
            await this.device.selectAlternateInterface(this.interfaceNumber, 0);

            // CDC handshake — old firmware only (new firmware uses command endpoint)
            if (!this.isNewFirmware) {
                await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x22,
                    value: 0x01,
                    index: this.interfaceNumber
                });
            }

            this.isConnected = true;

            if (this.isNewFirmware) {
                console.log('Firmware: GBLink Unified');
            } else {
                const v = `${this.device.deviceVersionMajor}.${this.device.deviceVersionMinor}.${this.device.deviceVersionSubminor}`;
                console.log(`Firmware: Reconfigurable v${v}`);
            }

            return true;

        } catch (error) {
            console.error('USB Connection failed:', error);
            this.isConnected = false;
            throw error;
        }
    }

    async disconnect() {
        if (this.device) {
            try {
                await this.device.releaseInterface(this.interfaceNumber);
                await this.device.close();
            } catch (e) {
                console.warn('Disconnect warning:', e);
            }
            this.device = null;
            this.isConnected = false;
            this.isNewFirmware = false;
            this._pendingDataIn = null;
        }
    }

    // --- Command endpoint (new firmware) / data endpoint (old firmware) ---

    async sendCommand(bytes) {
        if (!this.isConnected) throw new Error('Not connected');
        const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (this.isNewFirmware && this.cmdEndpointOut) {
            await this.device.transferOut(this.cmdEndpointOut, buffer);
        } else {
            await this.device.transferOut(this.endpointOut, buffer);
        }
    }

    async readCommandResponse(timeoutMs = 500) {
        if (!this.isConnected || !this.isNewFirmware || !this.cmdEndpointIn) return null;
        try {
            const result = await Promise.race([
                this.device.transferIn(this.cmdEndpointIn, 64),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), timeoutMs)
                )
            ]);
            if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
                return new Uint8Array(result.data.buffer);
            }
        } catch (e) { /* timeout */ }
        return null;
    }

    // --- Data endpoint ---

    async writeByte(byte) {
        if (!this.isConnected) throw new Error('Not connected');
        await this.device.transferOut(this.endpointOut, new Uint8Array([byte]));
    }

    async writeBytes(bytes) {
        if (!this.isConnected) throw new Error('Not connected');
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        await this.device.transferOut(this.endpointOut, data);
    }

    async readByte(timeoutMs = 2000) {
        if (!this.isConnected) throw new Error('Not connected');
        const result = await this._dataTransferIn(64, timeoutMs);
        if (result.status === 'ok' && result.data.byteLength > 0) {
            return result.data.getUint8(0);
        }
        throw new Error('Read failed or empty');
    }

    async readBytes(length, timeoutMs = 2000) {
        if (!this.isConnected) throw new Error('Not connected');
        const result = await this._dataTransferIn(length, timeoutMs);
        if (result.status === 'ok') {
            return new Uint8Array(result.data.buffer);
        }
        throw new Error('Read failed');
    }

    async readBytesRaw(length = 64, timeoutMs = 100) {
        if (!this.isConnected) throw new Error('Not connected');
        try {
            const result = await this._dataTransferIn(length, timeoutMs);
            if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
                return new Uint8Array(result.data.buffer);
            }
        } catch (e) { /* timeout or transfer error: caller treats empty as no-data */ }
        return new Uint8Array(0);
    }

    /**
     * Discard any stale data queued on the device from a previous session,
     * mirroring the Python reference's pre-trade FIFO drain.
     */
    async drain() {
        for (let i = 0; i < 32; i++) {
            const stale = await this.readBytesRaw(64, 50);
            if (stale.length === 0) break;
        }
    }

    // --- Voltage switching ---

    async setVoltage(mode) {
        // mode: '3v3' | '5v'
        if (!this.isConnected) return false;

        if (this.isNewFirmware) {
            const cmd = mode === '5v' ? CMD.SET_VOLTAGE_5V : CMD.SET_VOLTAGE_3V3;
            await this.sendCommand(new Uint8Array([cmd]));
        } else {
            if (!fwVersionAtLeast(this.device, 1, 0, 6)) return false;
            const packet = mode === '5v' ? VSWITCH_5V_PACKET : VSWITCH_3V3_PACKET;
            await this.device.transferOut(this.endpointOut, packet);
            await this.readBytesRaw(64, 500); // ack; empty on timeout is non-fatal
        }

        console.log(`Voltage set to ${mode}`);
        return true;
    }

    // --- LED control ---

    async setLed(r, g, b, on = true) {
        if (!this.isConnected) return false;

        if (this.isNewFirmware) {
            await this.sendCommand(new Uint8Array([CMD.SET_LED_COLOR, r, g, b, on ? 1 : 0]));
        } else {
            if (!fwVersionAtLeast(this.device, 1, 0, 6)) return false;
            await this.device.transferOut(this.endpointOut, buildLedPacket(r, g, b, on));
            await this.readBytesRaw(64, 500); // ack; empty on timeout is non-fatal
        }
        return true;
    }

    // --- Timing config ---

    async setTimingConfig(usBetweenTransfer, bytesPerTransfer) {
        if (!this.isConnected) return false;

        if (this.isNewFirmware) {
            await this.sendCommand(new Uint8Array([
                CMD.SET_TIMING_CONFIG,
                usBetweenTransfer & 0xFF,
                (usBetweenTransfer >> 8) & 0xFF,
                (usBetweenTransfer >> 16) & 0xFF,
                bytesPerTransfer & 0xFF
            ]));
        } else {
            const config = new Uint8Array(36);
            config.set(MAGIC_PREFIX);
            config[32] = usBetweenTransfer & 0xFF;
            config[33] = (usBetweenTransfer >> 8) & 0xFF;
            config[34] = (usBetweenTransfer >> 16) & 0xFF;
            config[35] = bytesPerTransfer & 0xFF;
            await this.device.transferOut(this.endpointOut, config);
        }
        return true;
    }

    // --- Mode selection (new firmware only) ---

    async setMode(mode) {
        if (!this.isConnected || !this.isNewFirmware) return false;
        await this.sendCommand(new Uint8Array([CMD.SET_MODE, mode]));
        return true;
    }

    // --- Firmware info (new firmware only) ---

    async getFirmwareInfo() {
        if (!this.isConnected || !this.isNewFirmware) return null;
        await this.sendCommand(new Uint8Array([CMD.GET_FIRMWARE_INFO]));
        const resp = await this.readCommandResponse(1000);
        if (resp && resp.length >= 4 && resp[0] === 0x0F) {
            return { major: resp[1], minor: resp[2], patch: resp[3] };
        }
        return null;
    }
}
