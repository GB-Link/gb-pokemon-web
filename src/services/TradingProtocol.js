
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
    }

    log(msg) {
        this.logger(msg);
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

        while (stateIndex < this.ENTER_ROOM_STATES[0].length && !this.stopTrade) {
            const nextByte = this.ENTER_ROOM_STATES[0][stateIndex];

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

        this.log("Entered Room!");
        return true;
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
