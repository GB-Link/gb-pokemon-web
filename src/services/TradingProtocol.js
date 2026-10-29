
export class TradingProtocol {
    constructor(usb, ws, logger) {
        this.usb = usb;
        this.ws = ws;
        this.logger = logger || console.log;
        this.stopTrade = false;
        this.verbose = false; // Set by subclass from options

        // Constants (to be overridden by subclasses)
        this.ENTER_ROOM_STATES = [];
        this.START_TRADING_STATES = [];
        this.MASTER_CLOCK = 0x02; // Not used directly in USB?
        this.SLAVE_CLOCK = 0x01;

        this.NO_DATA = 0x00;
        this.NO_INPUT = 0xFE;

        // Index of the ENTER_ROOM_STATES state that sends the room byte (Gen 2), null for none
        this.ROOM_SYNC_STATE = 2;
        this.ROOM_SYNC_QUIET_BYTES = 8;
        this.ROOM_SYNC_QUIET_MS = 300;
    }

    log(msg) {
        this.logger(msg);
    }

    static CLIENT_TYPE_JS_USB = 4;
    static CLIENT_TYPE_JS_EMU_BGB = 5;
    static CLIENT_TYPE_JS_EMU_WEB = 6;

    // TradingVersion 5.0.1 (little-endian 16-bit major/minor/build)
    versionData() {
        return new Uint8Array([5, 0, 0, 0, 1, 0]);
    }

    static isVersionAtLeast(data, major, minor, build) {
        if (!data || data.length < 6) return false;
        const parsed = [data[0] | (data[1] << 8), data[2] | (data[3] << 8), data[4] | (data[5] << 8)];
        for (const [have, want] of [[parsed[0], major], [parsed[1], minor], [parsed[2], build]]) {
            if (have !== want) return have > want;
        }
        return true;
    }

    // Log only if verbose mode is enabled
    logVerbose(msg) {
        if (this.verbose) {
            this.logger(msg);
        }
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async enterRoom() {
        this.log("Entering room...");
        // This is a simplified version of the enter_room logic from ref. impl.
        // It tries to sync with the GB until it reaches the stable state.

        let stateIndex = 0;
        let consecutiveNoData = 0;
        let readFailures = 0;
        const lastState = this.ENTER_ROOM_STATES[0].length - 1;
        this.resetRoomSync();

        while ((stateIndex <= lastState || !this.roomSyncSettled()) && !this.stopTrade) {
            const nextByte = this.ENTER_ROOM_STATES[0][Math.min(stateIndex, lastState)];

            // Send byte to GB
            await this.usb.writeByte(nextByte);

            // Read response
            let recv;
            try {
                recv = await this.usb.readByte();
                readFailures = 0;
            } catch (e) {
                recv = this.failedRead(e, ++readFailures);
            }

            if (await this.turnAwayOtherRoom(recv)) {
                stateIndex = 0;
                this.resetRoomSync();
                continue;
            }

            const heldIndex = this.holdRoomSync(this.ENTER_ROOM_STATES, stateIndex, recv);
            if (heldIndex !== stateIndex || stateIndex > lastState) {
                if (heldIndex !== stateIndex) this.logVerbose(`Room byte repeated, back to state ${heldIndex}`);
                stateIndex = heldIndex;
                await this.sleep(5);
                continue;
            }

            // Check if response matches expected state
            const expectedStates = this.ENTER_ROOM_STATES[1][stateIndex];
            // expectedStates can be an array of valid values

            let matched = false;
            if (Array.isArray(expectedStates)) {
                matched = expectedStates.includes(recv);
            } else {
                matched = (recv === expectedStates);
            }

            if (matched) {
                stateIndex++;
                consecutiveNoData = 0;
                this.logVerbose(`State advanced to ${stateIndex}. Recv: ${recv.toString(16)}`);
            } else {
                // If we receive NO_DATA (0x00) too many times, we might be disconnected
                if (recv === this.NO_DATA) {
                    consecutiveNoData++;
                    if (consecutiveNoData > 100) {
                        this.logVerbose("Too many NO_DATA, retrying...");
                        consecutiveNoData = 0;
                        stateIndex = 0; // Reset
                    }
                } else {
                    // Received something else, maybe we are out of sync
                    this.logVerbose(`Unexpected byte: ${recv.toString(16)}. Expected: ${expectedStates}`);
                    // In ref. impl. it stays in the same state or resets depending on logic.
                    // We'll just stay and retry for now.
                }
            }

            await this.sleep(5); // Small delay to prevent flooding and allow device to process

        }

        if (this.stopTrade) return false;
        this.log("Entered Room!");
        return true;
    }

    /**
     * Gen 2 games send the room they chose (0xD1 Trade Center, 0xD2 Colosseum) and wait
     * for their partner's. A game in the other room gets our room byte back: it then says
     * the rooms don't match and lets the player out, instead of waiting at "Please wait"
     * for a room byte that never comes. True when the game was turned away.
     */
    async turnAwayOtherRoom(recv) {
        const chosen = this.OTHER_ROOMS?.[recv];
        if (!chosen) return false;
        this.log(`Your game went to the ${chosen}, but this is a ${this.SESSION_KIND}: talk to the ${this.ROOM_NAME} receptionist.`);
        this.onStatus?.(`Wrong room: this is a ${this.SESSION_KIND}`, 'error',
            `Your game went to the ${chosen}. Once it says the rooms don't match, talk to the ${this.ROOM_NAME} receptionist.`);
        const ours = this.ENTER_ROOM_STATES[0][2];
        let quiet = 0;
        const end = Date.now() + 15000;
        while (quiet < 60 && Date.now() < end && !this.stopTrade) {
            const back = await this.exchangeByte(ours);
            quiet = (back & 0xF0) === 0xD0 ? 0 : quiet + 1;
            await this.sleep(5);
        }
        return true;
    }

    // Gen 2 games keep resending the room byte, with 0x00/0xFE in between, until they
    // have read ours: fall back to sending it, and only leave once they have stopped.
    resetRoomSync() {
        this.roomSyncQuiet = { since: 0, count: 0 };
    }

    holdRoomSync(states, index, recv) {
        const roomState = this.ROOM_SYNC_STATE;
        if (roomState === null || recv !== states[0][roomState]) {
            this.roomSyncQuiet.count++;
            return index;
        }
        this.roomSyncQuiet = { since: Date.now(), count: 0 };
        return Math.min(index, roomState);
    }

    roomSyncSettled() {
        return this.ROOM_SYNC_STATE === null
            || (this.roomSyncQuiet.count >= this.ROOM_SYNC_QUIET_BYTES
                && Date.now() - this.roomSyncQuiet.since >= this.ROOM_SYNC_QUIET_MS);
    }

    /**
     * Handle a failed transport read inside a tolerant polling loop.
     * A few timeouts are tolerated as NO_DATA (the retry loops are built for
     * that), but a persistent silence or a hard transfer error aborts the
     * trade loudly instead of forging 0x00 protocol bytes forever.
     */
    failedRead(error, failureCount) {
        const MAX_CONSECUTIVE_FAILURES = 25;
        if (error.isTimeout && failureCount < MAX_CONSECUTIVE_FAILURES) {
            return this.NO_DATA;
        }
        this.log(`[ERROR] Game Boy link not responding: ${error.message}`);
        this.stopTrade = true;
        throw error;
    }

    async exchangeByte(byteToSend) {
        await this.usb.writeByte(byteToSend);
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (this.stopTrade) return this.NO_DATA;
            try {
                // Retrying only the read is safe: a timed-out transfer stays
                // pending in the transport and is consumed by the next read,
                // so the write/read pairing is preserved.
                return await this.usb.readByte();
            } catch (e) {
                lastError = e;
                if (!e.isTimeout) break;
            }
        }
        this.log(`[ERROR] USB exchange failed: ${lastError ? lastError.message : 'unknown error'}`);
        this.stopTrade = true;
        throw lastError || new Error('USB exchange failed');
    }
}
