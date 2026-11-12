/**
 * The GB Link mode's passive mode, from the page's side (GB-Link firmware 3.0 and the
 * in-page emulator): the Game Boy drives the clock and plays Player 1, and the adapter
 * answers each transfer with the bytes queued here, or with the idle byte.
 *
 * A byte exchange queues one byte and waits for the Game Boy's answer to it, however
 * long the game takes to clock it. A section loads a whole block into the adapter,
 * which then answers the game's preamble and block by itself, and is read back once
 * the game is through.
 *
 * transport: sendCommand(bytes), writeBytes(bytes), readBytesRaw(length, timeoutMs).
 * The adapter answers its queries on the data channel.
 */

const CMD = {
    SET_ACTIVE: 0x33,
    SET_PASSIVE: 0x34,
    SET_IDLE: 0x36,
    CLEAR_QUEUES: 0x37,
    LOAD_SECTION: 0x39,
    SECTION_LOADED: 0x3A,
    START_SECTION: 0x3B,
    SECTION_STATUS: 0x3C,
    READ_SECTION: 0x3D,
    END_SECTION: 0x3E,
};

const CHUNK_BYTES = 56;
const READ_CHUNK = 60;
const QUERY_TIMEOUT_MS = 1000;
const POLL_MS = 10;
// The game stops clocking one byte before the end of our block: once only that one
// is left for this long, the section is through
const LAST_BYTE_MS = 1000;
// Back in active mode, the passive answers still in flight have all come once nothing came for this long
const QUIET_MS = 50;
const LOAD_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readU32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

export function sectionChecksum(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum = (sum + (bytes[i] << (8 * (i % 4)))) >>> 0;
    return sum;
}

export class GbLinkPassive {
    constructor(transport) {
        this.transport = transport;
        this.master = false;
        this._bytes = [];
        this._unanswered = 0;
    }

    async _command(bytes) {
        await this.transport.sendCommand(new Uint8Array(bytes));
    }

    async _readFrame(timeoutMs) {
        const frame = await this.transport.readBytesRaw(64, timeoutMs);
        return frame && frame.length ? frame : null;
    }

    // Reads until nothing has come for QUIET_MS
    async _drain() {
        this._bytes = [];
        this._unanswered = 0;
        while (await this._readFrame(QUIET_MS)) { /* stale */ }
    }

    /** The Game Boy drives the clock (Player 1), or the adapter does again (Player 2). */
    async setMaster(on) {
        if (on) {
            await this._drain();
            await this._command([CMD.SET_PASSIVE]);
            this.master = true;
        } else {
            await this._command([CMD.CLEAR_QUEUES]);
            await this._command([CMD.SET_ACTIVE]);
            this.master = false;
            await this._drain();
        }
    }

    /** The byte the Game Boy gets while nothing is queued. */
    async setIdleByte(byte) {
        await this._command([CMD.SET_IDLE, byte & 0xFF]);
    }

    /**
     * Queues a byte and resolves with the Game Boy's byte of that transfer, or null once
     * isStopped() says so. Answers to bytes queued by exchanges that were stopped are
     * skipped first.
     */
    async exchange(byte, isStopped = () => false) {
        await this.transport.writeBytes(new Uint8Array([byte & 0xFF]));
        this._unanswered++;
        for (;;) {
            while (this._bytes.length === 0) {
                if (isStopped()) return null;
                const frame = await this._readFrame(200);
                if (frame) this._bytes.push(...frame);
            }
            const answer = this._bytes.shift();
            if (--this._unanswered === 0) return answer;
        }
    }

    // A query's answer: the frame that starts with its command byte
    async _query(bytes, length) {
        await this._command(bytes);
        const end = Date.now() + QUERY_TIMEOUT_MS;
        while (Date.now() < end) {
            const frame = await this._readFrame(Math.max(1, end - Date.now()));
            if (frame && frame[0] === bytes[0] && frame.length >= length) return frame;
        }
        return null;
    }

    /**
     * Loads a block for the next section: the adapter answers `waiting` until the game
     * sends `preamble`, the preamble while the game repeats it, then the block.
     */
    async sendSection(block, preamble, waiting, isStopped = () => false) {
        const data = Uint8Array.from(block);
        const checksum = sectionChecksum(data);
        for (let attempt = 0; attempt < LOAD_ATTEMPTS && !isStopped(); attempt++) {
            await this._drain();
            await this._command([CMD.LOAD_SECTION, preamble & 0xFF, waiting & 0xFF]);
            for (let i = 0; i < data.length; i += CHUNK_BYTES) {
                await this.transport.writeBytes(data.subarray(i, i + CHUNK_BYTES));
            }
            const loaded = await this._query([CMD.SECTION_LOADED], 9);
            if (loaded && readU32(loaded, 1) === checksum && readU32(loaded, 5) === data.length) {
                await this._command([CMD.START_SECTION]);
                return true;
            }
        }
        if (!isStopped()) throw new Error('The adapter did not take the section data');
        return false;
    }

    /**
     * Waits for the game to finish the section and returns its block. onProgress(sent)
     * tells how many of our bytes the game has taken.
     */
    async sectionResult(total, isStopped = () => false, onProgress = null) {
        let ready = 0;
        let lastOnlySince = null;
        let skippedLast = false;
        while (!isStopped()) {
            const status = await this._query([CMD.SECTION_STATUS], 10);
            if (status) {
                let done = status[1] === 1;
                ready = readU32(status, 2);
                const left = readU32(status, 6);
                onProgress?.(total - left);
                if (!done && left <= 1) {
                    lastOnlySince ??= Date.now();
                    if (Date.now() - lastOnlySince >= LAST_BYTE_MS) {
                        done = true;
                        skippedLast = left === 1;
                    }
                }
                if (done) break;
            }
            await sleep(POLL_MS);
        }
        const block = [];
        while (ready > 0 && !isStopped()) {
            const reply = await this._query([CMD.READ_SECTION, Math.min(ready, READ_CHUNK)], 2);
            if (!reply || reply[1] === 0) break;
            block.push(...reply.subarray(2, 2 + reply[1]));
            ready -= reply[1];
        }
        if (skippedLast) block.push(0);
        await this._command([CMD.END_SECTION]);
        return block;
    }
}
