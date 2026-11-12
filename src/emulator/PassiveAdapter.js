/**
 * The GB-Link adapter's passive mode (firmware 3.0) for the in-page Game Boy.
 *
 * The game drives the clock, and each transfer is answered with the next byte the
 * page queued, or with the idle byte while nothing is queued. The game's answers to
 * queued bytes go back to the page as they arrive. A section preloads a whole block:
 * the waiting byte is answered until the game sends the preamble byte, the preamble
 * while the game repeats it, then the block, keeping the game's block for the page
 * to read back.
 *
 * It takes the adapter's GB Link commands (without hybrid mode) in turn with the
 * data, and its query answers come back as data, as from the adapter.
 */

const BUFFER_BYTES = 0x3FF;
const MAX_REPLY = 64;

const CMD = {
    SET_ACTIVE: 0x33,
    SET_PASSIVE: 0x34,
    SET_IDLE: 0x36,
    CLEAR_QUEUES: 0x37,
    RESTART: 0x38,
    LOAD_SECTION: 0x39,
    SECTION_LOADED: 0x3A,
    START_SECTION: 0x3B,
    SECTION_STATUS: 0x3C,
    READ_SECTION: 0x3D,
    END_SECTION: 0x3E,
};

const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

export class PassiveAdapter {
    constructor() {
        this.passive = false;
        this.idle = 0;
        // The answer to the game's next transfer
        this.next = 0;
        this.toGame = [];
        this.toHost = [];
        this.replies = [];
        this.scheduled = false;
        this.preamble = 0;
        this.waiting = 0;
        this.sectionSetup = false;
        this.sectionRequested = false;
        this.preambleStarted = false;
        this.pastPreamble = false;
    }

    static isCommand(id) {
        return id >= CMD.SET_ACTIVE && id <= CMD.END_SECTION;
    }

    _clear() {
        this.scheduled = false;
        this.toHost = [];
        this.toGame = [];
        this.sectionSetup = false;
        this.sectionRequested = false;
        this.preambleStarted = false;
        this.pastPreamble = false;
    }

    /** bytes: the command byte, then its payload. */
    command(bytes) {
        const id = bytes[0];
        const payload = bytes.slice(1);
        switch (id) {
            case CMD.SET_ACTIVE:
                this.passive = false;
                this._clear();
                break;
            case CMD.SET_PASSIVE:
                if (this.passive) break;
                this._clear();
                this.passive = true;
                this.next = this.idle;
                break;
            case CMD.SET_IDLE:
                if (payload.length >= 1) this.idle = payload[0];
                break;
            case CMD.CLEAR_QUEUES:
                this.toHost = [];
                this.toGame = [];
                break;
            case CMD.RESTART:
                if (!this.passive) break;
                this._clear();
                this.next = this.idle;
                break;
            case CMD.LOAD_SECTION:
                if (payload.length < 2) break;
                this._clear();
                this.sectionSetup = true;
                this.sectionRequested = true;
                this.preamble = payload[0];
                this.waiting = payload[1];
                break;
            case CMD.SECTION_LOADED: {
                let sum = 0;
                this.toGame.forEach((b, i) => { sum = (sum + (b << (8 * (i % 4)))) >>> 0; });
                this.replies.push([id, ...u32(sum), ...u32(this.toGame.length)]);
                break;
            }
            case CMD.START_SECTION:
                this.sectionSetup = false;
                break;
            case CMD.SECTION_STATUS: {
                const done = this.toGame.length === 0 && !this.scheduled ? 1 : 0;
                this.replies.push([id, done, ...u32(this.toHost.length), ...u32(this.toGame.length)]);
                break;
            }
            case CMD.READ_SECTION: {
                if (payload.length < 1) break;
                const bytes = this.sectionRequested ? this.toHost.splice(0, Math.min(payload[0], MAX_REPLY - 2)) : [];
                this.replies.push([id, bytes.length, ...bytes]);
                break;
            }
            case CMD.END_SECTION:
                this._clear();
                break;
        }
    }

    /** Bytes for the game; what does not fit is dropped (the section check shows it). */
    queue(bytes) {
        for (const b of bytes) {
            if (this.toGame.length >= BUFFER_BYTES) break;
            this.toGame.push(b);
        }
    }

    /** The game started a transfer sending `sent`: the byte it receives. */
    onGameClock(sent) {
        const answer = this.next;
        this.next = this._afterTransfer(sent);
        return answer;
    }

    // One transfer finished with the game's byte: the byte for the next transfer
    _afterTransfer(received) {
        if (this.scheduled && this.toHost.length < BUFFER_BYTES) this.toHost.push(received);
        this.scheduled = false;
        let next = this.idle;
        if (this.sectionSetup) {
            // The page is still loading the block
        } else if (this.sectionRequested) {
            if (!this.preambleStarted && received === this.preamble) this.preambleStarted = true;
            if (!this.pastPreamble && this.preambleStarted && received !== this.preamble) {
                // The game's first byte after the preamble starts its block
                this.pastPreamble = true;
                this.toHost.push(received);
            }
            if (!this.preambleStarted) next = this.waiting;
            else if (!this.pastPreamble) next = this.preamble;
            else if (this.toGame.length > 0) {
                next = this.toGame.shift();
                // The game's answer to the block's last byte is not part of its block
                if (this.toGame.length > 0) this.scheduled = true;
            }
        } else if (this.toGame.length > 0) {
            next = this.toGame.shift();
            this.scheduled = true;
        }
        return next;
    }

    /** What the adapter sends back now: the query answers, then in regular passive mode the game's bytes. */
    takeForHost() {
        const frames = this.replies.splice(0);
        if (this.passive && !this.sectionRequested) {
            while (this.toHost.length > 0) frames.push(this.toHost.splice(0, MAX_REPLY));
        }
        return frames;
    }
}
