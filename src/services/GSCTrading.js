
import { TradingProtocol } from './TradingProtocol.js?v=88';
import { GSCUtils } from './GSCUtils.js?v=88';
import { GSCChecks } from './GSCChecks.js?v=88';
import { GSCJPMailConverter } from './GSCJPMailConverter.js?v=88';

export class GSCTrading extends TradingProtocol {
    constructor(usb, ws, logger, tradeType = 'pool', isBuffered = false, doSanityChecks = true, options = {}) {
        super(usb, ws, logger);

        // Sanity checks instance - validates/sanitizes incoming Pokemon data
        this.checks = new GSCChecks(doSanityChecks);
        this.doSanityChecks = doSanityChecks;

        // Additional settings from options
        this.isJapanese = options.isJapanese ?? false;
        this.verbose = options.verbose ?? false;
        this.crashOnSyncDrop = options.crashOnSyncDrop ?? true;
        this.maxLevel = options.maxLevel ?? 100;
        this.convertToEggs = options.convertToEggs ?? false;

        // Negotiation prompt callback - called when user needs to decide whether to switch modes
        // Should return a Promise that resolves to true (switch) or false (keep)
        // If not provided, auto-accepts the other player's mode
        this.negotiationPrompt = options.negotiationPrompt ?? null;

        // Japanese mail converter - for converting mail between JP and International formats
        this.jpMailConverter = this.isJapanese ? new GSCJPMailConverter() : null;

        // Trade configuration
        this.tradeType = tradeType;    // 'pool' or 'link'
        this.isBuffered = isBuffered;  // true for buffered/async, false for sync
        this.isLinkTrade = (tradeType === 'link');


        this.ENTER_ROOM_STATES = [
            [0x01, 0x61, 0xD1, 0x00, 0xFE],
            [
                [0x61],
                [0xD1],
                [0x00],
                [0xFE],
                [0xFE]
            ]
        ];

        this.START_TRADING_STATES = [
            [0x75, 0x75, 0x76],
            [
                [0x75],
                [0x00],
                [0xFD]
            ]
        ];

        this.SPECIAL_SECTIONS_LEN = [0xA, 0x1BC, 0xC5, 0x181]; // Random, Pokemon, Patches, Mail (Matches ref impl)
        this.SECTION_NAMES = ['Random data', 'Party data', 'Patch data', 'Mail data']; // UI progress labels
        this.SPECIAL_SECTIONS_PREAMBLE_LEN = [7, 6, 3, 5]; // Random, Pokemon, Patches, Mail (Matches ref impl)

        // drop_bytes_checks: [[start_positions], [bad_bytes]]
        // If a byte at position >= start_position equals bad_byte, ref impl flags transfer as failed
        // Sections: 0=Random, 1=Pokemon, 2=Patches, 3=Mail
        this.DROP_BYTES_CHECK_START = [0xFFFF, 0x1B9, 0x48, 0xAB]; // [FFFF, 441, 72, 171]
        this.DROP_BYTES_CHECK_VALUE = [0x76, 0xFD, 0xFD, 0xFD];    // Bad byte values

        // Special mons that may learn new moves - matches special_mons set
        // These Pokemon require input check even if they didn't evolve
        // GSC species IDs: Lugia=0xF9, Moltres=0x49, Zapdos=0x4A, Articuno=0x4B
        this.SPECIAL_MONS = new Set([0xF9, 0x49, 0x4A, 0x4B]);

        // GSC Party Data Structure offsets (from gsc_trading_data_utils.py)
        this.TRADING_POKEMON_LENGTH = 0x30;      // 48 bytes per Pokemon core data
        this.TRADING_NAME_LENGTH = 0x0B;         // 11 bytes per name (OT/Nickname)
        this.TRADING_POKEMON_POS = 0x15;         // Offset where Pokemon data starts
        this.TRADING_POKEMON_OT_POS = 0x135;     // Offset where OT names start
        this.TRADING_POKEMON_NICKNAME_POS = 0x177; // Offset where nicknames start

        // Store received GB party data
        this.gbPartyData = null;

        // Counter for trade messages - must increment: CHC2(0) -> ACP2(1) -> SUC2(2)
        this.tradeCounter = 0;

        // Track peer's counter - used to reject stale messages
        // null = not yet set, will be set from first received message
        this.peerCounterId = null;

        // Track how many REAL trades have completed (not ghost trades)
        // MVS2 exchange only happens when completedTradeCount > 0
        this.completedTradeCount = 0;

        // SNG2 Protocol version: false = OLD (7 bytes), true = NEW (32 bytes)
        // Starts with OLD (compat_3_mode), switches to NEW if peer sends VEC2
        this.useNewProtocol = false;


        // True = need full section exchange (first sit or after certain trades)
        // False = can reuse cached data, only exchange MVS2
        this.ownBlankTrade = true;
        this.otherBlankTrade = true;

        // Track if we've completed the initial version/buffered negotiation (done once per session)
        this.initialNegotiationDone = false;

        // Mail section handling: ref impl skips sync for Section 3 when neither party has mail
        // This is detected after Section 1 (party data) exchange
        this.ownPartyHasMail = false;
        this.peerPartyHasMail = false;
        this.peerPartyData = null;  // Store peer's party data from sync exchange

        // Mail item IDs (0x9E-0xA8 are mail items in GSC)
        // From ids_mail.bin: mail items are in range 0x9E to 0xA8
        this.MAIL_ITEM_IDS = new Set([0x9E, 0x9F, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8]);

        // Offset of held item in Pokemon data (within the 48-byte Pokemon structure)
        // From gsc_trading_data_utils.py: item_pos = 1 (second byte)
        this.POKEMON_ITEM_OFFSET = 1;
    }

    // ==================== MESSAGE TAG GETTERS ====================
    // Override in subclasses for Gen1 vs Gen2 message tags
    get MSG_BUF() { return "BUF2"; }
    get MSG_NEG() { return "NEG2"; }
    get MSG_SNG() { return "SNG2"; }
    get MSG_MVS() { return "MVS2"; }
    get MSG_ASK() { return "ASK2"; }
    get MSG_FLL() { return "FLL2"; }
    get MSG_POL() { return "POL2"; }
    get MSG_CHC() { return "CHC2"; }
    get MSG_ACP() { return "ACP2"; }
    get MSG_SUC() { return "SUC2"; }
    get MSG_VEC() { return "VEC2"; }
    get MSG_VES() { return "VES2"; }
    get MSG_RAN() { return "RAN2"; }

    /**
     * Check if a party has any Pokemon holding mail.
     * @param {Uint8Array} partyData - The 444-byte party data section
     * @returns {boolean} True if any Pokemon in the party is holding mail
     */
    partyHasMail(partyData) {
        if (!partyData || partyData.length < this.TRADING_POKEMON_POS) {
            return false;
        }

        // Get party size (first byte of party data after header)
        // Party structure: [count byte, species list (7 bytes), ...]
        // Pokemon data starts at TRADING_POKEMON_POS (0x15 = 21)
        const partySize = Math.min(partyData[0] || 0, 6); // Max 6 Pokemon

        for (let i = 0; i < partySize; i++) {
            // Calculate offset for this Pokemon's held item
            // Each Pokemon is TRADING_POKEMON_LENGTH (48) bytes
            const pokemonOffset = this.TRADING_POKEMON_POS + (i * this.TRADING_POKEMON_LENGTH);
            const itemOffset = pokemonOffset + this.POKEMON_ITEM_OFFSET;

            if (itemOffset < partyData.length) {
                const heldItem = partyData[itemOffset];
                if (this.MAIL_ITEM_IDS.has(heldItem)) {
                    if (this.verbose) this.log(`[DEBUG] Party has mail: Pokemon ${i} holds item 0x${heldItem.toString(16)}`);
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Wait for peer to connect in link trade mode.
     * Server sends "CLIENT" message when both players are in the room.
     */
    async waitForPeer() {
        this.log("Waiting for another player to join the room...");

        // Send empty message to trigger server to check for pairing
        this.ws.sendRaw(new Uint8Array(0));

        // Capture MSG_BUF for use in closures (arrow functions preserve 'this', but let's be explicit)
        const msgBuf = this.MSG_BUF;

        // ref impl doesn't send "CLIENT", but we know peer is connected when we receive their buffered data
        // Check if we already have peer's data in recvDict (from GSCBufferedNegotiator)
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Timeout waiting for peer"));
            }, 120000); // 2 minute timeout

            // Check immediately if we already received buffered data from peer
            if (this.ws.recvDict[msgBuf]) {
                clearTimeout(timeout);
                this.log(`Peer already connected (received ${msgBuf})! Starting trade...`);
                resolve();
                return;
            }


            // Otherwise, listen for any incoming trade message as peer signal
            const checkMessage = (event) => {
                const data = event.data;
                // String "CLIENT" (old protocol) or any binary trade data indicates peer
                if (typeof data === 'string' && data === 'CLIENT') {
                    clearTimeout(timeout);
                    clearInterval(pollInterval);
                    this.ws.ws.removeEventListener('message', checkMessage);
                    this.log("Peer connected (CLIENT signal)! Starting trade...");
                    resolve();
                } else if (data instanceof Blob || data instanceof ArrayBuffer) {
                    // Binary data = peer is sending trade data, they're connected
                    clearTimeout(timeout);
                    clearInterval(pollInterval);
                    this.ws.ws.removeEventListener('message', checkMessage);
                    this.log("Peer connected (trade data received)! Starting trade...");
                    resolve();
                }
            };

            this.ws.ws.addEventListener('message', checkMessage);

            // ALSO poll for buffered data - ref impl sends it but we need to GET it
            const pollInterval = setInterval(() => {
                this.ws.sendGetData(msgBuf);
                if (this.ws.recvDict[msgBuf]) {
                    clearTimeout(timeout);
                    clearInterval(pollInterval);
                    this.ws.ws.removeEventListener('message', checkMessage);
                    this.log(`Peer already connected (received ${msgBuf})! Starting trade...`);
                    resolve();
                }
            }, 500);
        });
    }


    async start() {
        this.log(`Starting GSC Trade Protocol (${this.tradeType} mode, ${this.isBuffered ? 'buffered' : 'sync'}, sanity checks: ${this.doSanityChecks})...`);

        // Load sanity check data files
        if (this.doSanityChecks) {
            const loaded = await this.checks.load();
            if (!loaded) {
                this.log('[WARN] Could not load sanity check data, continuing without checks');
                this.checks.doSanityChecks = false;
            }
        }

        // Load GSCUtils data files (stats, evolution, names, etc.)
        const utilsLoaded = await GSCUtils.load();
        if (utilsLoaded) {
            this.log('[INFO] Loaded GSCUtils data (stats, evolution, names)');
        }


        // For link trade, set up buffered mode negotiation
        if (this.isLinkTrade) {
            // Send our buffered preference to other player
            // Format: Counter (1) + Buffered value (1): 0=sync, non-zero=buffered
            const bufferedValue = this.isBuffered ? 0x01 : 0x00;
            const bufCounter = 0x00; // Start with counter 0
            this.ws.sendData(this.MSG_BUF, new Uint8Array([bufCounter, bufferedValue]));
            if (this.verbose) this.log(`Sent ${this.MSG_BUF}: ${this.isBuffered ? 'buffered' : 'sync'} mode preference`);

            // Note: waitForPeer() may not be needed if other player is already connected
            // The server starts proxying messages immediately once both are in the room
        }

        await this.enterRoom();
        this.log("Entered Room. Sitting to table...");

        await this.sitToTable();
        this.log("Sat at table. Starting Trade Sequence...");

        await this.tradeStartingSequence();

        this.log("GSC: Ready to trade!");
    }

    async sitToTable() {
        // Similar to enterRoom but for START_TRADING_STATES
        let stateIndex = 0;
        let consecutiveNoData = 0;
        let readFailures = 0;

        while (stateIndex < this.START_TRADING_STATES[0].length && !this.stopTrade) {
            const nextByte = this.START_TRADING_STATES[0][stateIndex];

            await this.usb.writeByte(nextByte);

            let recv;
            try {
                recv = await this.usb.readByte();
                readFailures = 0;
            } catch (e) {
                recv = this.failedRead(e, ++readFailures);
            }

            const expectedStates = this.START_TRADING_STATES[1][stateIndex];
            let matched = false;
            if (Array.isArray(expectedStates)) {
                matched = expectedStates.includes(recv);
            } else {
                matched = (recv === expectedStates);
            }

            if (matched) {
                stateIndex++;
                consecutiveNoData = 0;
                if (this.verbose) this.log(`Sit State advanced to ${stateIndex}. Recv: ${recv.toString(16)}`);
            } else {
                if (recv === this.NO_DATA) {
                    consecutiveNoData++;
                    if (consecutiveNoData > 100) {
                        if (this.verbose) this.log("Too many NO_DATA in sitToTable, retrying...");
                        consecutiveNoData = 0;
                        stateIndex = 0;
                    }
                }
            }
            await this.sleep(5);
        }
    }

    async tradeStartingSequence() {
        // For link trade: Wait for peer and negotiate buffered mode here (after GB sat at table)
        // ref impl runs this in background threads while GB enters room, but we do it lazily here
        // 0. Peer Negotiation is now done in startTrade() before entering the room
        if (this.isLinkTrade) {
            this.log("Link Trade: Checking connection status...");
            if (!this.initialNegotiationDone) {
                this.log("Warning: Peer negotiation not complete?");
            }
        }

        // 1. Version Exchange
        if (this.verbose) this.log("Exchanging Versions...");

        // Wait a bit to ensure connection is stable
        await this.sleep(100);

        // Start with OLD protocol (compat_3_mode = true in ref impl)
        this.useNewProtocol = false;

        const versionData = new Uint8Array([4, 0, 0, 0, 0, 0]);
        this.ws.sendData("VEC2", versionData); // Send our client version

        await this.sleep(100); // Wait between messages

        this.ws.sendGetData("VES2"); // Get server version
        const serverVersion = await this.waitForMessage("VES2");
        if (this.verbose) this.log(`Server Version: ${serverVersion}`);

        // For link trades, check if peer sent their VEC2 - if so, use NEW protocol
        if (this.isLinkTrade) {
            // Wait briefly for peer's VEC2
            await this.sleep(2000);
            const peerVersion = this.ws.recvDict["VEC2"];
            if (peerVersion && peerVersion.length > 0) {
                this.useNewProtocol = true;
                this.log("Peer supports NEW protocol (32-byte SNG2)");
            } else {
                // Default to OLD protocol when negotiation fails
                this.useNewProtocol = false;
                this.log("Peer version not received. Using OLD protocol (7-byte SNG2) for compatibility.");
            }
        }

        // 2. Random Data (RAN2)
        if (this.verbose) this.log("Getting Random Data...");
        this.ws.sendGetData("RAN2"); // RAN2 for Gen 2
        const randomData = await this.waitForMessage("RAN2");
        if (this.verbose) this.log(`Random Data received: ${randomData.length} bytes`);

        let tradeData;
        let isGhostTrade = false; // First pass of buffered trade uses filler data
        let firstBufferedPass = false; // First buffered pass must always send FLL2

        if (this.isLinkTrade) {
            this.log("Link Trade: Skipping POL2 - will exchange data with other player");

            if (this.isBuffered) {
                // BUFFERED MODE: Two-pass trading
                // Pass 1 (Ghost): Use filler data → Collect our GB's party → Send FLL2
                // Pass 2 (Real): Use peer's FLL2 data → Do real trade

                if (!this.bufferedOtherData) {
                    // PASS 1: Ghost trade - we don't have peer's data yet
                    isGhostTrade = true;
                    firstBufferedPass = true;
                    this.log("Buffered Mode: Pass 1 (Ghost Trade) - Collecting our party data...");

                    // Try to get peer's data first (they might have sent it already)
                    this.ws.sendGetData("FLL2");
                    await this.sleep(500);
                    const earlyPeerData = this.ws.recvDict["FLL2"];
                    if (earlyPeerData && earlyPeerData.length > 0) {
                        // Peer already sent their data - use it for better exchange
                        this.log("Peer FLL2 received early, using their data...");
                        delete this.ws.recvDict["FLL2"];
                        this.bufferedOtherData = this.unpackFLL2(earlyPeerData);
                        this.cachedPeerPartyDecoded = false; // FLL data is raw wire form

                        // Fix incompatible nicknames for cross-version JP/INT trades
                        const fixedCount = GSCUtils.fixIncompatibleNicknames(this.bufferedOtherData[1]);
                        if (fixedCount > 0) {
                            this.log(`[JP/INT] Fixed ${fixedCount} incompatible nickname(s)`);
                        }

                        tradeData = {
                            section1: this.bufferedOtherData[1],
                            section2: this.bufferedOtherData[2],
                            section3: this.bufferedOtherData[3]
                        };
                        isGhostTrade = false;
                    } else {
                        // No peer data yet - use filler for ghost trade
                        tradeData = GSCUtils.createDefaultTradingData();
                    }
                } else {
                    // PASS 2+ : Real trade - we have peer's data from previous exchange (or updated after trade)
                    this.log("Buffered Mode: Using cached peer party data (no new FLL2 needed)...");
                    // Debug: Show species list from cached data
                    const speciesList = Array.from(this.bufferedOtherData[1].slice(0x0C, 0x12));
                    if (this.verbose) this.log(`[DEBUG] Cached species list: ${speciesList.map(s => s.toString(16)).join(', ')}`);
                    tradeData = {
                        section1: this.bufferedOtherData[1],
                        section2: this.bufferedOtherData[2],
                        section3: this.bufferedOtherData[3]
                    };
                }
            } else {
                // Sync mode - use default data
                tradeData = GSCUtils.createDefaultTradingData();
            }
        } else {
            // Pool trade: Get Pokemon from pool
            if (this.verbose) this.log("Getting Pool Data...");
            this.ws.sendGetData("POL2");
            const poolData = await this.waitForMessage("POL2");

            // Python kills the trade on the pool-failure reply
            // ([counter, fail_value], length 2) instead of fabricating a mon.
            if (!poolData || poolData.length <= 2) {
                this.log("[ERROR] Pool unavailable (empty pool or server failure). Aborting trade.");
                this.stopTrade = true;
                return;
            }
            if (this.verbose) this.log(`Pool Data received: ${poolData.length} bytes`);

            // === POOL TRADING: EGG CONVERSION ===

            //     mon.party_info.set_id(0, self.utils_class.egg_id)
            //     received_mon[0].set_hatching_cycles()
            //     received_mon[0].faint()
            //     received_mon[0].set_egg_nickname()
            let poolDataToUse = poolData.slice(1);

            if (this.convertToEggs) {
                this.log("[POOL] Convert to Eggs enabled - converting pool Pokemon to egg...");
                poolDataToUse = this.convertPoolPokemonToEgg(poolDataToUse);
            }

            // Construct Trading Data from pool
            tradeData = GSCUtils.createTradingData(poolDataToUse);

            // Set trader name to "POOL" for pool trades
            const poolName = GSCUtils.textToBytes("POOL");
            for (let i = 0; i < poolName.length; i++) {
                tradeData.section1[GSCUtils.trader_name_pos + i] = poolName[i];
            }

            // Cap Pokemon level to maxLevel setting (matches Python reference)
            this.capPoolPokemonLevel(tradeData.section1, GSCUtils);
        }

        // 4. Execute Sections - Exchange data with GB
        // Section 0: Random Data
        await this.readSection(0, randomData);

        // Section 1: Pokemon Data - store received GB party data
        if (this.verbose) this.log("Sending Section 1 (Pokemon Data)...");
        this.gbPartyData = await this.readSection(1, tradeData.section1);

        // Section 2: Patches
        if (this.verbose) this.log("Sending Section 2 (Patches)...");
        const gbPatchData = await this.readSection(2, tradeData.section2);

        // Decode our party: the wire form has 0xFE bytes escaped to 0xFF with
        // the patch section listing their positions (Python apply_patches).
        // Without this, CHC2/MVS2 would send patch-escaped bytes to the peer.
        GSCUtils.applyPatches(this.gbPartyData, gbPatchData, false);

        // === MAIL DETECTION ===
        // ref impl checks party_has_mail() after Section 1+2 to decide if Section 3 needs sync.
        // If neither party has mail OR we're in buffered mode, ref impl uses buffered=True for Section 3,
        // which skips the network sync handshake.
        this.ownPartyHasMail = this.partyHasMail(this.gbPartyData);
        this.peerPartyHasMail = this.partyHasMail(this.peerPartyData);

        const hasAnyMail = this.ownPartyHasMail || this.peerPartyHasMail;
        // Skip sync when: buffered mode OR no mail on either side

        const skipMailSync = this.isBuffered || !hasAnyMail;

        if (!hasAnyMail) {
            if (this.verbose) this.log("[MAIL] Neither party has mail. Using buffered read for Section 3.");
        } else {
            if (this.verbose) this.log(`[MAIL] Mail detected: ours=${this.ownPartyHasMail}, peer=${this.peerPartyHasMail}.`);
        }
        if (skipMailSync) {
            if (this.verbose) this.log("[MAIL] Skipping Section 3 sync bytes (buffered mode or no mail).");
        }

        // Section 3: Mail - skip sync when buffered mode or no mail
        if (this.verbose) this.log(`[DEBUG] About to read Section 3 (Mail). skipMailSync=${skipMailSync}, isBuffered=${this.isBuffered}`);

        // === JAPANESE MAIL CONVERSION (BEFORE sending to device) ===

        let mailDataToSend = tradeData.section3;
        if (this.isJapanese) {
            this.log("[JP] Converting mail data before sending to Game Boy...");
            mailDataToSend = await this.convertMailData(tradeData.section3, true);
        }

        const gbMailData = await this.readSection(3, mailDataToSend, skipMailSync);
        if (this.verbose) this.log(`[DEBUG] Section 3 (Mail) read complete. Got ${gbMailData?.length || 0} bytes`);

        // === JAPANESE MAIL CONVERSION (AFTER receiving from device) ===

        let processedMailData = gbMailData;
        if (this.isJapanese && gbMailData) {
            this.log("[JP] Converting mail data received from Game Boy...");
            processedMailData = await this.convertMailData(gbMailData, false);
        }

        // === CACHE PEER SECTIONS FOR SUBSEQUENT TRADES ===
        // ref impl uses cached other_pokemon data for trade 2+ (trade_starting_sequence with buffered=True)
        // The party is cached DECODED (peer's patches applied) so trade-menu
        // edits happen on real bytes; the wire patch section is regenerated at
        // reuse time. The peer's real patch/mail sections replace the previous
        // mirror-what-we-sent cache. When neither side has mail, the peer's
        // mail section equals our own empty one, so processedMailData is a
        // valid stand-in when no peer mail was captured.
        if (!this.isBuffered && this.peerPartyData) {
            const peerParty = new Uint8Array(this.peerPartyData);
            if (this.peerPatchData) {
                GSCUtils.applyPatches(peerParty, this.peerPatchData, false);
            }
            this.cachedPeerPartyDecoded = !!this.peerPatchData;
            this.bufferedOtherData = [
                randomData,           // Section 0: Random
                peerParty,            // Section 1: Pokemon (decoded)
                this.peerPatchData ? new Uint8Array(this.peerPatchData) : tradeData.section2,
                this.peerMailData ? new Uint8Array(this.peerMailData) : processedMailData
            ];
            if (this.verbose) this.log("[DEBUG] Cached peer sections for subsequent trades");
        }

        // 5. BUFFERED MODE: After collecting our party, exchange FLL2.
        // Sending is UNCONDITIONAL on the first pass (Python send_big_trading_data):
        // when we consumed the peer's early FLL2 they are still blocked waiting
        // for OURS - skipping the send here starved them into a timeout.
        if (this.isBuffered && this.isLinkTrade && firstBufferedPass) {
            this.log("Buffered Mode: Sending our party data via FLL2...");

            // Pack our collected data into FLL2 format
            const ourTradeData = {
                section1: this.gbPartyData,
                section2: gbPatchData,
                section3: processedMailData
            };
            await this.sendBigTradingData(randomData, ourTradeData);

            if (isGhostTrade) {
                // Receive peer's data (they may not have sat down yet - wait
                // at human timescale, like Python's force_receive)
                this.log("Waiting for peer's FLL2...");
                this.onStatus?.('Waiting for the other player…');
                const peerSections = await this.getBigTradingData();
                if (peerSections) {
                    this.bufferedOtherData = peerSections;
                    this.cachedPeerPartyDecoded = false; // FLL data is raw wire form
                    this.log("Buffered Data Exchange Complete. Canceling ghost trade...");

                    // Signal to cancel this trade and return to table
                    // The next iteration will use peer's data for real trade
                    this.cancelCurrentTrade = true;
                } else {
                    this.log("[ERROR] The other player never sent their trade data.");
                    this.stopTrade = true;
                    return;
                }
            }
        }

        // 5. Keep-alive loop for trade menu
        this.log("Entering trade menu loop...");

        // Branch based on trade type
        if (this.isLinkTrade) {
            // === 1462-1463: Reset flags to True BEFORE entering trade menu ===
            // This is critical for resync: if the trade menu exits without completing,
            // both clients will have flags=True and do full exchange on re-entry.
            // The flags are only set to other values inside linkTradeMenuLoop on SUCCESS.
            this.ownBlankTrade = true;
            this.otherBlankTrade = true;
            if (this.verbose) this.log("[DEBUG] Reset blank trade flags to true before entering trade menu");

            // Clean up stale SNG data from section exchange before entering trade menu
            // This prevents leftover sync data from confusing the trade menu logic
            if (!this.isBuffered) {
                delete this.ws.recvDict[this.MSG_SNG];
                if (this.verbose) this.log(`[DEBUG] Cleared stale ${this.MSG_SNG} data before trade menu`);

                // In sync mode, reset peerCounterId to null
                // The BUF2 counters are NOT used for MVS2/CHC2 exchange in sync mode.
                // The trade menu will re-initialize from the first message received.
                this.peerCounterId = null;
                if (this.verbose) this.log("[DEBUG] Reset peerCounterId to null for sync mode trade menu");
            }

            // NOTE: MVS2 exchange is now handled in subsequentTradeSequence() for re-entry
            // On first sit (when this function is called), no MVS2 exchange is needed
            await this.linkTradeMenuLoop();
        } else {
            await this.tradeMenuLoop();
        }
    }

    /**
     * Extracts a single Pokemon's data from the GB party data.
     * Returns the format needed for CHC2: [choice byte, pokemon data (117 bytes)]
     * 
     * Pokemon data structure (0x75 = 117 bytes total):
     * - Core data: 48 bytes (0x30)
     * - OT name: 11 bytes (0x0B)
     * - Nickname: 11 bytes (0x0B)
     * - Mail: 33 bytes (0x21) - zeros if no mail
     * - Sender: 14 bytes (0x0E) - zeros if no mail
     */
    extractSinglePokemon(choiceByte) {
        const SINGLE_POKEMON_DATA_LEN = 0x75; // 117 bytes - what server expects
        const MAIL_LEN = 0x21;   // 33 bytes
        const SENDER_LEN = 0x0E; // 14 bytes

        if (!this.gbPartyData) {
            this.log("[WARN] No GB party data available for extraction");
            return new Uint8Array([choiceByte]); // Just return choice byte if no data
        }

        // Convert choice byte (0x70-0x75) to index (0-5)
        const index = choiceByte - 0x70;
        if (index < 0 || index > 5) {
            this.log(`[WARN] Invalid Pokemon index: ${index}`);
            return new Uint8Array([choiceByte]);
        }

        // Create result array: choice (1) + Pokemon data (117 bytes) + egg flag (1)
        const result = new Uint8Array(1 + SINGLE_POKEMON_DATA_LEN + 1);
        result[0] = choiceByte;

        let offset = 1; // Start after choice byte

        // 1. Core Pokemon data (48 bytes per Pokemon)
        const coreStart = this.TRADING_POKEMON_POS + (index * this.TRADING_POKEMON_LENGTH);
        const coreData = this.gbPartyData.slice(coreStart, coreStart + this.TRADING_POKEMON_LENGTH);
        result.set(coreData, offset);
        offset += this.TRADING_POKEMON_LENGTH; // +48

        // 2. OT name (11 bytes per name)
        const otStart = this.TRADING_POKEMON_OT_POS + (index * this.TRADING_NAME_LENGTH);
        const otData = this.gbPartyData.slice(otStart, otStart + this.TRADING_NAME_LENGTH);
        result.set(otData, offset);
        offset += this.TRADING_NAME_LENGTH; // +11

        // 3. Nickname (11 bytes per name)
        const nickStart = this.TRADING_POKEMON_NICKNAME_POS + (index * this.TRADING_NAME_LENGTH);
        const nickData = this.gbPartyData.slice(nickStart, nickStart + this.TRADING_NAME_LENGTH);
        result.set(nickData, offset);
        offset += this.TRADING_NAME_LENGTH; // +11

        // 4. Mail (33 bytes) - zeros for no mail
        // Note: Mail data is in Section 3 if present, but we don't have it, so send zeros
        offset += MAIL_LEN; // Already zeros from Uint8Array initialization

        // 5. Sender (14 bytes) - zeros for no mail
        offset += SENDER_LEN; // Already zeros

        // 6. Egg flag (1 byte) - at the very end
        // result[offset] already 0 from initialization = not an egg

        this.log(`Extracted Pokemon data for index ${index}: ${result.length} bytes (1 choice + ${SINGLE_POKEMON_DATA_LEN} data + 1 egg)`);
        return result;
    }
    /**
     * Update bufferedOtherData (peer's party) after a trade.
     * Mimics reorder_party + trade_mon behavior:
     * 1. reorder_party: Move traded slot to END of party (shift others up)
     * 2. Replace at LAST position with incoming Pokemon
     * 
     * @param {number} ourChoice - Our choice byte (0x70-0x75)
     * @param {number} peerChoice - Peer's choice byte (0x70-0x75)
     */
    updatePeerPartyAfterTrade(ourChoice, peerChoice) {
        if (!this.bufferedOtherData || !this.bufferedOtherData[1]) {
            this.log("[WARN] No buffered peer data to update");
            return;
        }

        if (!this.gbPartyData) {
            this.log("[WARN] No GB party data to extract from");
            return;
        }

        const ourIndex = ourChoice - 0x70;
        const peerIndex = peerChoice - 0x70;

        if (ourIndex < 0 || ourIndex > 5 || peerIndex < 0 || peerIndex > 5) {
            this.log(`[WARN] Invalid trade indices: our=${ourIndex}, peer=${peerIndex}`);
            return;
        }

        this.log(`Updating peer party: our slot ${ourIndex} -> peer slot ${peerIndex} (will reorder to end)`);

        // Copy of peer's party section (section 1)
        const peerParty = new Uint8Array(this.bufferedOtherData[1]);

        // Party data structure offsets (from ref impl gsc_trading_data_utils.py):
        const TRADING_PARTY_INFO_POS = 0x0B;  // Party count
        const SPECIES_LIST_POS = 0x0C;  // Species IDs (party_info_pos + 1)

        // Get peer's party size
        const partySize = peerParty[TRADING_PARTY_INFO_POS];
        const lastIndex = partySize - 1;

        this.log(`Peer party size: ${partySize}, last index: ${lastIndex}`);

        // === Step 1: Reorder peer's party ===
        // Move traded slot to END, shift others up
        if (peerIndex < lastIndex) {
            // Save the traded slot data
            const tradedSpecies = peerParty[SPECIES_LIST_POS + peerIndex];
            const tradedCoreData = new Uint8Array(this.TRADING_POKEMON_LENGTH);
            const tradedOtName = new Uint8Array(this.TRADING_NAME_LENGTH);
            const tradedNickname = new Uint8Array(this.TRADING_NAME_LENGTH);

            // Copy traded slot data
            for (let i = 0; i < this.TRADING_POKEMON_LENGTH; i++) {
                tradedCoreData[i] = peerParty[this.TRADING_POKEMON_POS + (peerIndex * this.TRADING_POKEMON_LENGTH) + i];
            }
            for (let i = 0; i < this.TRADING_NAME_LENGTH; i++) {
                tradedOtName[i] = peerParty[this.TRADING_POKEMON_OT_POS + (peerIndex * this.TRADING_NAME_LENGTH) + i];
                tradedNickname[i] = peerParty[this.TRADING_POKEMON_NICKNAME_POS + (peerIndex * this.TRADING_NAME_LENGTH) + i];
            }

            // Shift all slots after peerIndex up by one
            for (let i = peerIndex + 1; i < partySize; i++) {
                // Shift species list
                peerParty[SPECIES_LIST_POS + (i - 1)] = peerParty[SPECIES_LIST_POS + i];

                // Shift core data
                for (let j = 0; j < this.TRADING_POKEMON_LENGTH; j++) {
                    peerParty[this.TRADING_POKEMON_POS + ((i - 1) * this.TRADING_POKEMON_LENGTH) + j] =
                        peerParty[this.TRADING_POKEMON_POS + (i * this.TRADING_POKEMON_LENGTH) + j];
                }

                // Shift OT name
                for (let j = 0; j < this.TRADING_NAME_LENGTH; j++) {
                    peerParty[this.TRADING_POKEMON_OT_POS + ((i - 1) * this.TRADING_NAME_LENGTH) + j] =
                        peerParty[this.TRADING_POKEMON_OT_POS + (i * this.TRADING_NAME_LENGTH) + j];
                }

                // Shift nickname
                for (let j = 0; j < this.TRADING_NAME_LENGTH; j++) {
                    peerParty[this.TRADING_POKEMON_NICKNAME_POS + ((i - 1) * this.TRADING_NAME_LENGTH) + j] =
                        peerParty[this.TRADING_POKEMON_NICKNAME_POS + (i * this.TRADING_NAME_LENGTH) + j];
                }
            }

            // Put traded slot data at the END (will be replaced with incoming Pokemon)
            peerParty[SPECIES_LIST_POS + lastIndex] = tradedSpecies;
            for (let i = 0; i < this.TRADING_POKEMON_LENGTH; i++) {
                peerParty[this.TRADING_POKEMON_POS + (lastIndex * this.TRADING_POKEMON_LENGTH) + i] = tradedCoreData[i];
            }
            for (let i = 0; i < this.TRADING_NAME_LENGTH; i++) {
                peerParty[this.TRADING_POKEMON_OT_POS + (lastIndex * this.TRADING_NAME_LENGTH) + i] = tradedOtName[i];
                peerParty[this.TRADING_POKEMON_NICKNAME_POS + (lastIndex * this.TRADING_NAME_LENGTH) + i] = tradedNickname[i];
            }

            this.log(`Reordered peer party: moved slot ${peerIndex} to end (slot ${lastIndex})`);
        }

        // === Step 2: Place our Pokemon at lastIndex (like trade_mon) ===
        const ourSpecies = this.gbPartyData[this.TRADING_POKEMON_POS + (ourIndex * this.TRADING_POKEMON_LENGTH)];
        const oldPeerSpecies = peerParty[SPECIES_LIST_POS + lastIndex];

        // Update species list at lastIndex
        peerParty[SPECIES_LIST_POS + lastIndex] = ourSpecies;
        this.log(`Updated species at slot ${lastIndex}: ${oldPeerSpecies} -> ${ourSpecies}`);

        // Copy our core Pokemon data to lastIndex
        const ourCoreStart = this.TRADING_POKEMON_POS + (ourIndex * this.TRADING_POKEMON_LENGTH);
        const peerCoreStart = this.TRADING_POKEMON_POS + (lastIndex * this.TRADING_POKEMON_LENGTH);
        for (let i = 0; i < this.TRADING_POKEMON_LENGTH; i++) {
            peerParty[peerCoreStart + i] = this.gbPartyData[ourCoreStart + i];
        }

        // Copy our OT name to lastIndex
        const ourOtStart = this.TRADING_POKEMON_OT_POS + (ourIndex * this.TRADING_NAME_LENGTH);
        const peerOtStart = this.TRADING_POKEMON_OT_POS + (lastIndex * this.TRADING_NAME_LENGTH);
        for (let i = 0; i < this.TRADING_NAME_LENGTH; i++) {
            peerParty[peerOtStart + i] = this.gbPartyData[ourOtStart + i];
        }

        // Copy our Nickname to lastIndex
        const ourNickStart = this.TRADING_POKEMON_NICKNAME_POS + (ourIndex * this.TRADING_NAME_LENGTH);
        const peerNickStart = this.TRADING_POKEMON_NICKNAME_POS + (lastIndex * this.TRADING_NAME_LENGTH);
        for (let i = 0; i < this.TRADING_NAME_LENGTH; i++) {
            peerParty[peerNickStart + i] = this.gbPartyData[ourNickStart + i];
        }

        // Update the buffered data with modified party
        this.bufferedOtherData[1] = peerParty;

        // Debug: show new species list
        const speciesList = Array.from(peerParty.slice(SPECIES_LIST_POS, SPECIES_LIST_POS + partySize));
        this.log(`Peer party updated. New species list: ${speciesList.map(s => s.toString(16)).join(', ')}`);
    }

    /**
     * Check if a Pokemon requires user input (matching requires_input).
     * Returns true if:
     * 1. The Pokemon is in the special_mons set (could learn new moves)
     * 2. The Pokemon could have evolved (simplified - we check if species is an evolution target)
     * 
     * @param {Uint8Array} partyData - The party data (section 1)
     * @param {number} slotIndex - The index of the Pokemon in the party
     * @returns {boolean} true if input is required
     */
    requiresInput(partyData, slotIndex) {
        if (!partyData) {
            return false;
        }

        // Get party size
        const partySize = partyData[0x0B];
        if (slotIndex < 0 || slotIndex >= partySize) {
            return false;
        }

        // Get species from species list (at offset 0x0C)
        const species = partyData[0x0C + slotIndex];

        // Check if it's a special mon (Lugia, Moltres, Zapdos, Articuno)
        if (this.SPECIAL_MONS.has(species)) {
            if (this.verbose) this.log(`[DEBUG] requiresInput: Species 0x${species.toString(16)} is special mon - returns true`);
            return true;
        }

        // Simplified evolution check:
        // In ref impl, evolve_mon() actually evolves the Pokemon and returns True if 
        // there are learnable moves that couldn't be auto-learned.
        // For simplicity, we return false here since:
        // 1. We don't have the full learnset data
        // 2. Most Pokemon won't have pending moves after trade evolution
        // 3. The special_mons check covers the important edge cases

        if (this.verbose) this.log(`[DEBUG] requiresInput: Species 0x${species.toString(16)} - returns false (not special)`);
        return false;
    }

    /**
     * Receive MVS2 (move data only) from peer for Trade 2+.
     * MVS2 format: [counter, move1, move2, move3, move4, pp1, pp2, pp3, pp4]
     * This updates the last Pokemon in peer's party with new move/PP data.
     */
    async receiveMVS2() {
        // Clear any stale MVS2 data first
        delete this.ws.recvDict[this.MSG_MVS];

        if (this.verbose) this.log(`[DEBUG] receiveMVS2: Starting. Expected peerCounterId=${this.peerCounterId}`);

        // Request MVS2 from server
        this.ws.sendGetData(this.MSG_MVS);

        const maxRetries = 500; // 500 * 100ms = 50 seconds
        for (let i = 0; i < maxRetries && !this.stopTrade; i++) {
            const mvs2Data = this.ws.recvDict[this.MSG_MVS];
            if (mvs2Data && mvs2Data.length >= 9) {
                const counter = mvs2Data[0];

                if (this.verbose) this.log(`[DEBUG] receiveMVS2: Got data with counter=${counter}, expected=${this.peerCounterId}`);

                // Validate counter - but be lenient if peerCounterId is null
                if (this.peerCounterId === null) {
                    // First message - set the counter
                    this.peerCounterId = counter;
                    if (this.verbose) this.log(`[DEBUG] receiveMVS2: Initialized peerCounterId to ${counter}`);
                } else if (counter !== this.peerCounterId) {
                    // Counter mismatch - could be stale or we're out of sync
                    // Try to accept it anyway if it's close (within 2)
                    const diff = (counter - this.peerCounterId + 256) % 256;
                    if (diff <= 2) {
                        this.log(`[WARN] receiveMVS2: Counter slightly off (got ${counter}, expected ${this.peerCounterId}) - accepting anyway`);
                        this.peerCounterId = counter;
                    } else {
                        if (this.verbose) this.log(`[DEBUG] Rejecting stale MVS2: counter=${counter}, expected=${this.peerCounterId}`);
                        delete this.ws.recvDict[this.MSG_MVS];
                        this.ws.sendGetData(this.MSG_MVS);
                        await this.sleep(100);
                        continue;
                    }
                }

                // Extract move data (8 bytes: 4 moves + 4 PP)
                let moveData = mvs2Data.slice(1, 9);

                // Apply sanity checks to move data
                if (this.doSanityChecks && this.checks.loaded) {
                    // Format for movesChecksMap: [species, m1, m2, m3, m4, pp1, pp2, pp3, pp4]
                    // We need to prepend a species byte (use 0 as placeholder since we're only checking moves)
                    const fullMoveData = [0, ...moveData];
                    const cleanedData = this.checks.cleanMoves(fullMoveData);
                    moveData = cleanedData.slice(1); // Remove species byte
                    this.log(`[CHECKS] Applied sanity checks to MVS2 move data`);
                }

                this.log(`Received MVS2 (Counter: ${counter}): moves=[${moveData.slice(0, 4).join(',')}] pp=[${moveData.slice(4, 8).join(',')}]`);

                // Increment peer counter for next message
                this.peerCounterId = (this.peerCounterId + 1) % 256;
                if (this.verbose) this.log(`[DEBUG] receiveMVS2: Incremented peerCounterId to ${this.peerCounterId}`);

                // Update the last Pokemon in peer's buffered party with these moves/PP
                if (this.bufferedOtherData && this.bufferedOtherData[1]) {
                    const peerParty = this.bufferedOtherData[1];
                    const partySize = peerParty[0x0B]; // TRADING_PARTY_INFO_POS
                    const lastIndex = partySize - 1;

                    // Update moves and PP in the last Pokemon's core data
                    const coreStart = this.TRADING_POKEMON_POS + (lastIndex * this.TRADING_POKEMON_LENGTH);

                    // Moves are at offset 2-5 in core data
                    for (let j = 0; j < 4; j++) {
                        peerParty[coreStart + 2 + j] = moveData[j]; // moves
                    }
                    // PP is at offset 0x17 (23) in core data
                    for (let j = 0; j < 4; j++) {
                        peerParty[coreStart + 0x17 + j] = moveData[4 + j]; // PP
                    }

                    this.log(`Updated peer's last Pokemon (slot ${lastIndex}) with new moves/PP`);
                }

                // Clear the received data
                delete this.ws.recvDict[this.MSG_MVS];
                return true;
            }

            if (i % 50 === 0 && i > 0) {
                if (this.verbose) this.log(`[DEBUG] receiveMVS2: Still waiting... (${i * 100}ms elapsed)`);
            }

            await this.sleep(100);
            this.ws.sendGetData(this.MSG_MVS);
        }

        this.log("[WARN] Timeout waiting for MVS2 - assuming peer sent it anyway");
        // IMPORTANT: Even if we timeout, ref impl has likely sent MVS2.
        // We must increment peerCounterId to stay in sync.
        if (this.peerCounterId !== null) {
            if (this.verbose) this.log(`[DEBUG] Incrementing peerCounterId from ${this.peerCounterId} to ${(this.peerCounterId + 1) % 256} (compensating for missed MVS2)`);
            this.peerCounterId = (this.peerCounterId + 1) % 256;
        }
        return false;
    }

    /**
     * Send MVS2 (move data only) to peer for Trade 2+.
     * Extracts moves and PP from our last Pokemon and sends to peer.
     */
    async sendMVS2() {
        if (this.verbose) this.log(`[DEBUG] sendMVS2: Starting. ownCounterId=${this.ownCounterId}`);

        if (!this.gbPartyData) {
            this.log("[WARN] sendMVS2: No GB party data - cannot send MVS2");
            // Still need to increment counter to stay in sync with what peer expects
            this.ownCounterId = (this.ownCounterId + 1) % 256;
            if (this.verbose) this.log(`[DEBUG] sendMVS2: Incremented ownCounterId to ${this.ownCounterId} (even though no data)`);
            return;
        }

        // Get party size and find last Pokemon
        const partySize = this.gbPartyData[0x0B]; // TRADING_PARTY_INFO_POS
        const lastIndex = partySize - 1;
        if (this.verbose) this.log(`[DEBUG] sendMVS2: Party size=${partySize}, lastIndex=${lastIndex}`);

        // Extract moves and PP from last Pokemon's core data
        const coreStart = this.TRADING_POKEMON_POS + (lastIndex * this.TRADING_POKEMON_LENGTH);

        const moveData = new Uint8Array(8);
        // Moves are at offset 2-5 in core data
        for (let j = 0; j < 4; j++) {
            moveData[j] = this.gbPartyData[coreStart + 2 + j];
        }
        // PP is at offset 0x17 (23) in core data
        for (let j = 0; j < 4; j++) {
            moveData[4 + j] = this.gbPartyData[coreStart + 0x17 + j];
        }

        // Create MVS2 payload: [counter] + [8 bytes move/PP data]
        const mvs2Payload = new Uint8Array(9);
        mvs2Payload[0] = this.ownCounterId;
        mvs2Payload.set(moveData, 1);

        this.ws.sendData(this.MSG_MVS, mvs2Payload);
        this.log(`Sent MVS2 (Counter: ${this.ownCounterId}): moves=[${moveData.slice(0, 4).join(',')}] pp=[${moveData.slice(4, 8).join(',')}]`);

        // Increment our counter
        this.ownCounterId = (this.ownCounterId + 1) % 256;
        if (this.verbose) this.log(`[DEBUG] sendMVS2: Incremented ownCounterId to ${this.ownCounterId}`);
    }

    async tradeMenuLoop() {
        // Trade menu flow:
        // 1. Wait for GB to send a valid choice (0x70-0x7F range)
        // 2. Confirm the choice (send NO_INPUT repeatedly until stable)
        // 3. For pool trade, server auto-selects, so just get server's choice
        // 4. Send server's choice to GB
        // 5. Wait for GB accept/decline
        // 6. Send to server, get server response
        // 7. Send back to GB
        // 8. Handle trade completion or loop back

        // NOTE: Counter must NOT reset - it must increment continuously across all trades
        // Trade 1: CHC2(0), ACP2(1), SUC2(2)
        // Trade 2: CHC2(3), ACP2(4), SUC2(5), etc.
        // Server uses last_success check to detect new trades

        const FIRST_TRADE_INDEX = 0x70;
        const STOP_TRADE = 0x7F;
        const ACCEPT_TRADE = 0x72;
        const DECLINE_TRADE = 0x71;
        const POSSIBLE_INDEXES = new Set();
        for (let i = 0x70; i < 0x80; i++) {
            POSSIBLE_INDEXES.add(i);
        }

        this.log("Waiting for Pokémon selection...");

        while (!this.stopTrade) {
            // 1. Wait for a valid choice from GB
            this.onStatus?.('Pick a Pokémon on your Game Boy');

            // This waits for 10 CONSECUTIVE reads of the same value for stability
            if (this.verbose) this.log("[DEBUG] Starting selection wait (using waitForChoice)");
            const choice = await this.waitForChoice(this.NO_INPUT, POSSIBLE_INDEXES, 10);

            if (this.verbose) this.log(`[DEBUG] waitForChoice returned: 0x${choice.toString(16)}, stopTrade=${this.stopTrade}`);

            if (this.stopTrade) break;

            // choice is already confirmed by waitForChoice (10 consecutive reads)
            this.log(`GB selected: 0x${choice.toString(16)} (Index: ${choice - FIRST_TRADE_INDEX})`);

            // Check for STOP_TRADE (cancel) BEFORE sending data to server
            if (choice === STOP_TRADE) {
                this.log("Trade cancelled by player. Performing end_trade handshake...");
                // ref impl end_trade: Send 0x7F until GB responds 0x7F, then wait for 0
                await this.endTrade(STOP_TRADE);
                this.log("End trade handshake complete. Returning to trade room...");

                // For pool trades: reconnect WebSocket to get fresh Pokemon from server
                if (!this.isLinkTrade) {
                    this.bufferedOtherData = null;
                    delete this.ws.recvDict["POL2"];

                    // Reconnect WebSocket to get new Pokemon from pool
                    this.log("Pool: Reconnecting to get fresh Pokemon...");
                    const serverUrl = this.ws.url;
                    this.ws.disconnect();
                    await this.sleep(500);
                    await this.ws.connect(serverUrl);
                    this.log("Pool: Reconnected! Will get new Pokemon on re-entry");
                }
                break;
            }

            // Notify server of GB's choice with full Pokemon data
            const pokemonData = this.extractSinglePokemon(choice);
            // Format: Counter (1 byte) + Pokemon data (choice + core + OT + nickname + egg)
            const chc2Payload = new Uint8Array(1 + pokemonData.length);
            chc2Payload[0] = this.tradeCounter; // Use incrementing counter
            chc2Payload.set(pokemonData, 1);
            this.ws.sendData("CHC2", chc2Payload);
            this.tradeCounter = (this.tradeCounter + 1) & 0xFF; // Increment and wrap at 256
            this.log(`Sent CHC2 with Pokemon data: ${chc2Payload.length} bytes, counter=${chc2Payload[0]}`);

            // Note: GET CHC2 is NOT supported in pool mode - pool Pokemon comes from GET POL2

            if (this.verbose) this.log("[DEBUG] Proceeding with trade");
            // 3. For pool trade, server auto-selects the pool Pokémon (always index 0 = 0x70)
            // The actual server choice is in serverChoiceData[1] but we know it's always 0x70
            const serverChoice = FIRST_TRADE_INDEX;
            this.log(`Server auto-selected: 0x${serverChoice.toString(16)} (Index: 0)`);

            // 4. Send server's choice to GB
            let next = await this.exchangeByte(serverChoice);
            this.log(`Sent server choice to GB, recv: 0x${next.toString(16)}`);

            // Wait for NO_DATA then NO_INPUT transition
            // This allows the GB to process and transition to accept/decline state
            // Use NO LIMIT (0) to ensure we ALWAYS wait until GB acknowledges with NO_DATA
            // If we proceed without NO_DATA, we'll send ACCEPT while GB is still in selection phase!
            next = await this.waitForNoData(next, serverChoice, 20);
            if (this.verbose) this.log(`After wait_for_no_data, recv: 0x${next.toString(16)}`);

            // After getting NO_DATA, wait for NO_INPUT
            if (next === this.NO_DATA) next = await this.waitForNoInput(next);
            this.log(`After wait_for_no_input, recv: 0x${next.toString(16)}`);

            // 5. Wait for GB's accept/decline decision
            // Use waitForAcceptDecline which matches wait_for_accept_decline
            // This waits for a STABLE value (10 consecutive reads) to filter out glitches
            this.onStatus?.('Confirm the trade on your Game Boy');
            const gbAccept = await this.waitForAcceptDecline(next);

            if (this.stopTrade) break;

            this.log(`GB decision: ${gbAccept === ACCEPT_TRADE ? 'ACCEPT' : 'DECLINE'}`);

            // Notify server of GB's accept/decline decision
            const acp2Counter = this.tradeCounter;
            this.ws.sendData("ACP2", new Uint8Array([acp2Counter, gbAccept])); // Counter + Accept byte
            this.tradeCounter = (this.tradeCounter + 1) & 0xFF;
            this.log(`Sent ACP2 with counter=${acp2Counter}`);

            // Get server's accept response (triggers handle_get_accepted on server)
            const serverAcceptData = await this.getServerData("ACP2");
            this.log(`Server accept response: ${serverAcceptData ? serverAcceptData.length : 0} bytes`);

            // 6. Use the server's REAL decision ([counter, accept/decline]); the
            // server declines when the offered mon fails its sanity checks, and
            // forcing an accept makes it commit garbage into the shared pool.
            let serverAccept;
            if (serverAcceptData && serverAcceptData.length >= 2) {
                serverAccept = serverAcceptData[1];
                this.log(`Server decision: ${serverAccept === ACCEPT_TRADE ? 'ACCEPT' : 'DECLINE'}`);
            } else {
                this.log("[WARN] No server accept received, declining");
                serverAccept = DECLINE_TRADE;
            }

            // 7. Send server's decision to GB
            next = await this.exchangeByte(serverAccept);
            this.log(`Sent server decision to GB, recv: 0x${next.toString(16)}`);

            // After sending accept, do the same synchronization as after sending choice
            // Increase limitResends to ensure we clear the echo (use 0 for no limit)
            next = await this.waitForNoData(next, serverAccept, 20);
            if (this.verbose) this.log(`After accept wait_for_no_data, recv: 0x${next.toString(16)}`);

            if (next === this.NO_DATA) next = await this.waitForNoInput(next);
            this.log(`After accept wait_for_no_input, recv: 0x${next.toString(16)}`);

            if (gbAccept === ACCEPT_TRADE && serverAccept === ACCEPT_TRADE) {
                // 8. Trade accepted! NOW wait for GB to send success byte (after animation)
                this.log("Trade accepted by both parties!");
                this.onStatus?.('Trading…');
                this.log("Waiting for trade success confirmation from GB...");

                // Define Success Bytes
                // 0x90-0x9F: Standard success
                // 0x70-0x7F: Game Boy moved straight to next selection (implicit success)
                // 0x00-0x0F: Possible reset? (Adding just in case)
                const SUCCESS_BYTES = new Set();
                for (let i = 0x90; i < 0xA0; i++) SUCCESS_BYTES.add(i);
                for (let i = 0x70; i < 0x80; i++) SUCCESS_BYTES.add(i); // Re-selection range

                // Use waitForChoice to ensure we get a SUSTAINED value
                const successByte = await this.waitForChoice(next, SUCCESS_BYTES, 10);
                this.log(`Trade success! Final byte: 0x${successByte.toString(16)}`);

                if (!this.stopTrade) {
                    // Send success byte back
                    next = await this.exchangeByte(successByte);

                    // Post-trade cleanup synchronization
                    // This allows GB to complete trade and reset for next trade
                    // Keep sending the SUCCESS BYTE until we receive NO_DATA (No Limit)
                    next = await this.waitForNoData(next, successByte, 20);
                    if (this.verbose) this.log(`After post-trade wait_for_no_data, recv: 0x${next.toString(16)}`);

                    if (next === this.NO_DATA) next = await this.waitForNoInput(next);
                    this.log(`After post-trade wait_for_no_input, recv: 0x${next.toString(16)}`);

                    // Clear buffers - ensure we're in a clean state before next trade
                    // Send NO_INPUT until we get stable NO_INPUT back
                    let stableCount = 0;
                    while (stableCount < 5 && !this.stopTrade) {
                        const recv = await this.exchangeByte(this.NO_INPUT);
                        if (recv === this.NO_INPUT) {
                            stableCount++;
                        } else {
                            stableCount = 0;
                        }
                        await this.sleep(20);
                    }

                    // Notify server that trade completed successfully
                    // This tells the server to update the pool with the traded Pokemon
                    this.log("Notifying server of trade success...");
                    const suc2Counter = this.tradeCounter;
                    this.ws.sendData("SUC2", new Uint8Array([suc2Counter, 0x91])); // Counter + Success value
                    this.tradeCounter = (this.tradeCounter + 1) & 0xFF;
                    this.log(`Sent SUC2 with counter=${suc2Counter}`);

                    // GET SUC2 triggers handle_get_success which actually updates the pool!
                    const successData = await this.getServerData("SUC2");
                    this.log(`Server success response: ${successData ? successData.length : 0} bytes (pool updated)`);

                    // === PROTOCOL check_reset_trade() for pool trades (to_server=True) ===
                    // ref impl line 1165-1169: For pool trades, check_reset_trade calls reset_trade()
                    // reset_trade() sets other_pokemon = None (line 1159)
                    // This forces the next trade to fetch fresh POL2 from server (line 1485-1487)
                    // We must do the same - clear cached data so fresh pool data is fetched
                    this.bufferedOtherData = null;
                    this.peerPartyData = null;
                    if (this.verbose) this.log("[DEBUG] Cleared cached peer data for fresh POL2 fetch (pool trade reset)");

                    this.log("Trade round completed successfully!");
                    this.onStatus?.('Trade complete!', 'success');
                    this.log("Preparing for next trade - re-synchronizing data...");

                    // Exit trade menu loop to restart sequence (but skip sitToTable in startTrade)
                    break;
                }
            } else {
                this.log("Trade declined. Returning to selection...");
                this.onStatus?.('Trade declined — pick another Pokémon');
                // Loop back to selection
            }
        }

        this.log("Trade menu loop ended.");
    }

    async waitForChoice(initialValue, validSet, threshold = 10) {
        // Confirm that we received a stable value
        // ref impl logic: update foundVal with EVERY read, but only count consecutive reads
        // when the value is in validSet AND matches foundVal
        // ADAPTATION: Ignore NO_INPUT (0xFE) to handle noisy connection (alternating 0x72/0xFE)
        if (this.verbose) this.log(`[DEBUG] waitForChoice started with initialValue=0x${initialValue.toString(16)}, threshold=${threshold}`);
        let foundVal = initialValue;
        let consecutiveReads = 0;

        while (consecutiveReads < threshold && !this.stopTrade) {
            const next = await this.exchangeByte(this.NO_INPUT);

            if (next === this.NO_INPUT || next === this.NO_DATA) {
                // Ignore NO_INPUT (0xFE) and NO_DATA (0x00)
                // Do NOT reset consecutiveReads, do NOT update foundVal
                await this.sleep(15);
                continue;
            }

            // Check if in valid set
            if (validSet.has(next)) {
                if (next === foundVal) {
                    consecutiveReads++;
                } else {
                    consecutiveReads = 1; // Start new count
                    foundVal = next;      // Update foundVal
                }
            } else {
                consecutiveReads = 0;
                foundVal = next;
            }

            if (consecutiveReads > 0 && consecutiveReads % 5 === 0) {
                if (this.verbose) this.log(`[DEBUG] waitForChoice progress: ${consecutiveReads}/${threshold}, foundVal=0x${foundVal.toString(16)}`);
            }

            await this.sleep(15);
        }

        if (this.verbose) this.log(`[DEBUG] waitForChoice returning: 0x${foundVal.toString(16)}`);
        return foundVal;
    }

    async waitForAcceptDecline(initialValue) {
        const validSet = new Set([0x72, 0x71]); // ACCEPT, DECLINE
        return await this.waitForChoice(initialValue, validSet);
    }

    /**
     * Force close an open trade menu by sending STOP_TRADE until confirmed.
     * Sends 0x7F until GB responds 0x7F, then waits for 0.
     */
    async endTrade(stopTradeValue) {
        let next = 0;
        let target = stopTradeValue;
        let iterations = 0;
        const maxIterations = 100; // Safety limit

        // Phase 1: Send 0x7F until GB responds with 0x7F
        while (next !== target && iterations < maxIterations && !this.stopTrade) {
            next = await this.exchangeByte(stopTradeValue);
            if (target === stopTradeValue && next === target) {
                // GB confirmed STOP_TRADE, now wait for 0
                target = 0;
            }
            iterations++;
            await this.sleep(5);
        }

        // Phase 2: Send 0x7F until we get 0 (or timeout)
        iterations = 0;
        while (next !== 0 && iterations < maxIterations && !this.stopTrade) {
            next = await this.exchangeByte(stopTradeValue);
            iterations++;
            await this.sleep(5);
        }

        this.log(`endTrade completed after ${iterations} iterations, final: 0x${next.toString(16)}`);
    }

    // ==================== LINK TRADE HELPER METHODS ====================

    /**
     * Get the other player's Pokemon choice via GET CHC2.
     * Polls repeatedly until data is received, keeping GB clock alive.
     * Validates counter to reject stale messages (mirrors get_with_counter).
     * Returns [choice, pokemonData, isValid] or null.
     */
    async getChosenMon() {
        const FIRST_TRADE_INDEX = 0x70;
        const STOP_TRADE = 0x7F;

        this.log("Waiting for peer's Pokemon selection...");

        while (!this.stopTrade) {
            // Send GET request
            this.ws.sendGetData("CHC2");

            // Keep GB clock alive while waiting
            await this.exchangeByte(this.NO_INPUT);
            await this.sleep(50);

            // Check if we received data
            const data = this.ws.recvDict["CHC2"];
            if (data && data.length > 0) {
                // Format: Counter (1) + Choice (1) + Pokemon data (117) + Egg (1)
                const counter = data[0];
                const choice = data[1];

                // Validate counter like get_with_counter
                if (this.verbose) this.log(`[DEBUG] CHC2 validation: counter=${counter}, peerCounterId=${this.peerCounterId}`);
                if (this.peerCounterId === null) {
                    // First message - set expected counter
                    this.peerCounterId = counter;
                    if (this.verbose) this.log(`[DEBUG] Set initial peerCounterId=${counter}`);
                } else {
                    // Check if message is stale (counter < expected, accounting for wraparound)
                    // Messages with counter >= expected are fresh (peer may have sent extra messages)
                    const diff = (counter - this.peerCounterId + 256) % 256;
                    if (diff > 128) {
                        // Counter is behind (stale message) - reject
                        if (this.verbose) this.log(`[DEBUG] Rejecting stale CHC2: counter=${counter}, expected=${this.peerCounterId}`);
                        delete this.ws.recvDict["CHC2"];
                        continue;
                    }
                    // Counter is ahead or equal - sync to this counter
                    if (counter !== this.peerCounterId) {
                        if (this.verbose) this.log(`[DEBUG] Syncing peerCounterId: ${this.peerCounterId} -> ${counter}`);
                        this.peerCounterId = counter;
                    }
                }

                // Counter matched/synced - increment expected for next message
                this.peerCounterId = (this.peerCounterId + 1) % 256;

                // Clear received data to avoid re-reading
                delete this.ws.recvDict["CHC2"];

                this.log(`Peer selected: 0x${choice.toString(16)} (Counter: ${counter})`);

                if (choice === STOP_TRADE) {
                    return [STOP_TRADE, null, true];
                }

                // Extract Pokemon data if present
                let pokemonData = data.slice(2);
                let isValid = pokemonData.length > 0;

                // Apply sanity checks to incoming Pokemon data
                if (isValid && this.doSanityChecks && this.checks.loaded) {
                    const cleanedData = this.checks.cleanSinglePokemon(pokemonData);
                    pokemonData = new Uint8Array(cleanedData);
                    this.log(`[CHECKS] Applied sanity checks to CHC2 Pokemon data`);
                }

                return [choice, pokemonData, isValid];
            }
        }
        return null;
    }

    /**
     * Get the other player's accept/decline decision via GET ACP2.
     * Validates counter to reject stale messages.
     */
    async getAccepted() {
        this.log("Waiting for peer's accept/decline...");

        while (!this.stopTrade) {
            this.ws.sendGetData("ACP2");
            await this.exchangeByte(this.NO_INPUT);
            await this.sleep(50);

            const data = this.ws.recvDict["ACP2"];
            if (data && data.length > 0) {
                const counter = data[0];
                const accepted = data[1];

                // Validate counter (accept counter >= expected, reject stale)
                if (this.peerCounterId !== null) {
                    const diff = (counter - this.peerCounterId + 256) % 256;
                    if (diff > 128) {
                        if (this.verbose) this.log(`[DEBUG] Rejecting stale ACP2: counter=${counter}, expected=${this.peerCounterId}`);
                        delete this.ws.recvDict["ACP2"];
                        continue;
                    }
                    if (counter !== this.peerCounterId) {
                        if (this.verbose) this.log(`[DEBUG] Syncing peerCounterId: ${this.peerCounterId} -> ${counter}`);
                        this.peerCounterId = counter;
                    }
                } else {
                    this.peerCounterId = counter;
                }
                this.peerCounterId = (this.peerCounterId + 1) % 256;
                delete this.ws.recvDict["ACP2"];

                this.log(`Peer's decision: 0x${accepted.toString(16)} (Counter: ${counter})`);
                return accepted;
            }
        }
        return null;
    }

    /**
     * Get the other player's success confirmation via GET SUC2.
     * Validates counter to reject stale messages.
     */
    async getSuccess() {
        this.log("Waiting for peer's success confirmation...");

        while (!this.stopTrade) {
            this.ws.sendGetData("SUC2");
            await this.exchangeByte(this.NO_INPUT);
            await this.sleep(50);

            const data = this.ws.recvDict["SUC2"];
            if (data && data.length > 0) {
                const counter = data[0];
                const success = data[1];

                // Validate counter (accept counter >= expected, reject stale)
                if (this.peerCounterId !== null) {
                    const diff = (counter - this.peerCounterId + 256) % 256;
                    if (diff > 128) {
                        if (this.verbose) this.log(`[DEBUG] Rejecting stale SUC2: counter=${counter}, expected=${this.peerCounterId}`);
                        delete this.ws.recvDict["SUC2"];
                        continue;
                    }
                    if (counter !== this.peerCounterId) {
                        if (this.verbose) this.log(`[DEBUG] Syncing peerCounterId: ${this.peerCounterId} -> ${counter}`);
                        this.peerCounterId = counter;
                    }
                } else {
                    this.peerCounterId = counter;
                }
                this.peerCounterId = (this.peerCounterId + 1) % 256;
                delete this.ws.recvDict["SUC2"];

                this.log(`Peer's success: 0x${success.toString(16)} (Counter: ${counter})`);
                return success;
            }
        }
        return null;
    }

    /**
     * Link Trade Menu Loop - Handles bidirectional trading with another player.
     * Both players send/receive CHC2, ACP2, SUC2 via the proxy server.
     */
    async linkTradeMenuLoop() {
        const FIRST_TRADE_INDEX = 0x70;
        const STOP_TRADE = 0x7F;
        const ACCEPT_TRADE = 0x72;
        const DECLINE_TRADE = 0x71;
        const POSSIBLE_INDEXES = new Set();
        for (let i = 0x70; i < 0x80; i++) {
            POSSIBLE_INDEXES.add(i);
        }

        this.log("Link Trade: Waiting for Pokémon selection...");

        // BUFFERED MODE: If this is a ghost trade (Pass 1), wait for user to cancel
        if (this.cancelCurrentTrade) {
            this.log("=== BUFFERED MODE: Ghost Trade Complete ===");
            this.log("You should now select CANCEL TRADE on your Game Boy.");
            this.log("Waiting for you to exit the trade menu...");
            this.onStatus?.('Select CANCEL TRADE on your Game Boy');
            this.cancelCurrentTrade = false;

            // Wait for the user to cancel on the GB (they select CANCEL TRADE)
            // The GB will send STOP_TRADE (0x7F) when they cancel
            const ourChoice = await this.waitForChoice(this.NO_INPUT, POSSIBLE_INDEXES, 10);

            if (ourChoice === STOP_TRADE) {
                this.log("Ghost trade cancelled. Returning to table for real trade...");
                await this.endTrade(STOP_TRADE);
                return; // Exit loop - startTrade will sit at table again
            } else {
                // User selected a Pokemon instead of canceling - this shouldn't happen in ghost trade
                this.log(`Warning: User selected ${ourChoice.toString(16)} instead of canceling. Treating as cancel.`);
                await this.endTrade(STOP_TRADE);
                return;
            }
        }

        while (!this.stopTrade) {
            // 1. Wait for our GB's selection
            this.onStatus?.('Pick a Pokémon on your Game Boy');
            const ourChoice = await this.waitForChoice(this.NO_INPUT, POSSIBLE_INDEXES, 10);

            if (this.stopTrade) break;

            this.log(`Our GB selected: 0x${ourChoice.toString(16)} (Index: ${ourChoice - FIRST_TRADE_INDEX})`);

            // 2. Check for STOP_TRADE (cancel)
            if (ourChoice === STOP_TRADE) {
                this.log("Trade cancelled by us. Sending cancel to peer...");
                // Send cancel to peer
                const cancelPayload = new Uint8Array([this.ownCounterId, STOP_TRADE]);
                this.ws.sendData("CHC2", cancelPayload);
                this.ownCounterId = (this.ownCounterId + 1) % 256;

                // === CRITICAL: Still receive peer's CHC2 to keep counters in sync ===
                // ref impl always calls force_receive(get_mon_function) even during cancel.
                // If we don't consume peer's response, its stale CHC2 remains in the buffer
                // and will be incorrectly accepted on re-entry (counter will match!).
                this.log("Waiting for peer's response to sync counters...");
                const peerResponse = await this.getChosenMon();
                if (peerResponse) {
                    this.log(`Peer responded with: 0x${peerResponse[0].toString(16)} (consumed for counter sync)`);
                    // peerCounterId was already incremented inside getPeerSelection()
                } else {
                    // Timeout - peer may have also cancelled, increment counter anyway
                    this.log("[WARN] No peer response received, incrementing peerCounterId to stay in sync");
                    if (this.peerCounterId !== null) {
                        this.peerCounterId = (this.peerCounterId + 1) % 256;
                    }
                }

                await this.endTrade(STOP_TRADE);
                break;
            }

            // 3. Send our choice + Pokemon data to server (proxied to peer)
            const pokemonData = this.extractSinglePokemon(ourChoice);
            const chc2Payload = new Uint8Array(1 + pokemonData.length);
            if (this.verbose) this.log(`[DEBUG] Before CHC2: ownCounterId=${this.ownCounterId}`);
            chc2Payload[0] = this.ownCounterId;
            chc2Payload.set(pokemonData, 1);
            this.ws.sendData("CHC2", chc2Payload);
            this.ownCounterId = (this.ownCounterId + 1) % 256;
            this.log(`Sent CHC2: ${chc2Payload.length} bytes, counter=${chc2Payload[0]}, next counter will be ${this.ownCounterId}`);

            // 4. Get peer's choice via GET CHC2
            this.onStatus?.("Waiting for the other player's choice…");
            const peerData = await this.getChosenMon();
            if (!peerData) {
                this.log("Failed to get peer's selection");
                continue;
            }

            const [peerChoice, peerPokemon, peerValid] = peerData;

            // 5. Handle peer cancel
            if (peerChoice === STOP_TRADE) {
                this.log("Trade cancelled by peer.");
                await this.endTrade(STOP_TRADE);
                break;
            }

            // 6. Send peer's choice to our GB
            let next = await this.exchangeByte(peerChoice);
            this.log(`Sent peer choice to GB, recv: 0x${next.toString(16)}`);

            next = await this.waitForNoData(next, peerChoice, 20);
            if (next === this.NO_DATA) next = await this.waitForNoInput(next);

            // 7. Wait for our GB's accept/decline
            this.onStatus?.('Confirm the trade on your Game Boy');
            const ourAccept = await this.waitForAcceptDecline(next);
            this.log(`Our GB decision: ${ourAccept === ACCEPT_TRADE ? 'ACCEPT' : 'DECLINE'}`);

            // 8. Send our accept to peer
            const acp2Payload = new Uint8Array([this.ownCounterId, ourAccept]);
            this.ws.sendData("ACP2", acp2Payload);
            this.ownCounterId = (this.ownCounterId + 1) % 256;
            this.log(`Sent ACP2 with counter=${acp2Payload[0]}`);

            // 9. Get peer's accept/decline
            this.onStatus?.('Waiting for the other player to confirm…');
            const peerAccept = await this.getAccepted();
            if (peerAccept === null) {
                this.log("Failed to get peer's accept decision");
                continue;
            }
            this.log(`Peer decision: ${peerAccept === ACCEPT_TRADE ? 'ACCEPT' : 'DECLINE'}`);

            // 10. Send peer's accept to our GB
            next = await this.exchangeByte(peerAccept);
            next = await this.waitForNoData(next, peerAccept, 20);
            if (next === this.NO_DATA) next = await this.waitForNoInput(next);

            // 11. Handle trade outcome
            if (ourAccept === ACCEPT_TRADE && peerAccept === ACCEPT_TRADE) {
                this.log("Trade accepted by both parties!");
                this.onStatus?.('Trading…');

                // === Exchange need_data (NED2/ASK2) after trade ===
                // This is CRITICAL for synchronization!
                // Each client tells the other if they need to send MVS2 on re-entry.
                //
                // ref impl sets flags based on requires_input BEFORE this exchange:
                //   own_blank_trade = own_pokemon.requires_input(last_mon) <- mon WE received
                //   other_blank_trade = other_pokemon.requires_input(last_mon) <- mon PEER received
                //
                // Then:
                //   send_need_data(other_blank_trade)  # Tell peer if they need to send us MVS2
                //   own_blank_trade = get_need_data()  # Peer tells us if we need to send them MVS2

                const NEED_DATA_VALUE = 0x72;
                const NOT_NEED_DATA_VALUE = 0x43;

                // Calculate species of traded Pokemon
                // peerPokemon[0] = species of Pokemon WE received (from peer)
                const peerTradedSpecies = peerPokemon && peerPokemon.length > 0 ? peerPokemon[0] : 0;
                // Our traded Pokemon species (what peer received)
                const ourIndex = ourChoice - FIRST_TRADE_INDEX;
                const ourTradedSpecies = this.gbPartyData ?
                    this.gbPartyData[this.TRADING_POKEMON_POS + (ourIndex * this.TRADING_POKEMON_LENGTH)] : 0;

                // Check if traded Pokemon are special mons (require MVS2)
                const peerNeedsMVS2 = this.SPECIAL_MONS.has(peerTradedSpecies); // mon WE received
                const weNeedMVS2FromPeer = this.SPECIAL_MONS.has(ourTradedSpecies); // mon PEER received

                if (this.verbose) this.log(`[DEBUG] Traded species: we received=0x${peerTradedSpecies.toString(16)}, peer received=0x${ourTradedSpecies.toString(16)}`);

                // Send our need_data to peer (tell them if they need to send us MVS2)
                const ourNeedDataValue = weNeedMVS2FromPeer ? NEED_DATA_VALUE : NOT_NEED_DATA_VALUE;
                const ask2Payload = new Uint8Array([this.ownCounterId, ourNeedDataValue]);
                this.ws.sendData(this.MSG_ASK, ask2Payload);
                this.ownCounterId = (this.ownCounterId + 1) % 256;
                this.log(`Sent ${this.MSG_ASK} (need_data): 0x${ourNeedDataValue.toString(16)}`);

                // Get peer's ASK response (they tell us if we need to send them MVS)
                await this.sleep(300);
                this.ws.sendGetData(this.MSG_ASK);
                const peerAsk2 = await this.waitForMessage(this.MSG_ASK);
                if (peerAsk2 && peerAsk2.length >= 2) {
                    const peerCounter = peerAsk2[0];
                    const peerValue = peerAsk2[1];
                    this.log(`Peer ASK2: counter=${peerCounter}, value=0x${peerValue.toString(16)}`);

                    // peerValue tells us if WE need to send THEM MVS2
                    this.ownBlankTrade = (peerValue === NEED_DATA_VALUE);
                    this.peerCounterId = (peerCounter + 1) % 256;
                } else {
                    this.log(`[WARN] Failed to receive ${this.MSG_ASK}, using calculated value`);
                    this.ownBlankTrade = peerNeedsMVS2;
                }

                // otherBlankTrade = whether peer needs to send us MVS2
                this.otherBlankTrade = weNeedMVS2FromPeer;
                if (this.verbose) this.log(`[DEBUG] Blank trade flags set: ownBlankTrade=${this.ownBlankTrade}, otherBlankTrade=${this.otherBlankTrade}`);

                // Wait for success confirmation from GB
                const SUCCESS_BYTES = new Set();
                for (let i = 0x90; i < 0xA0; i++) SUCCESS_BYTES.add(i);
                for (let i = 0x70; i < 0x80; i++) SUCCESS_BYTES.add(i);

                const ourSuccess = await this.waitForChoice(next, SUCCESS_BYTES, 10);
                this.log(`Our success byte: 0x${ourSuccess.toString(16)}`);

                // Send success to peer
                const suc2Payload = new Uint8Array([this.ownCounterId, ourSuccess]);
                this.ws.sendData("SUC2", suc2Payload);
                this.ownCounterId = (this.ownCounterId + 1) % 256;

                // Get peer's success
                const peerSuccess = await this.getSuccess();
                this.log(`Peer success: 0x${(peerSuccess || 0).toString(16)}`);

                // Send OUR success byte back to GB to confirm trade
                // ref impl uses success_list[0] which is the local expected success (0x70 for normal trades)
                next = await this.exchangeByte(ourSuccess);
                next = await this.waitForNoData(next, ourSuccess, 20);
                if (next === this.NO_DATA) next = await this.waitForNoInput(next);

                this.log("Trade completed successfully!");
                this.onStatus?.('Trade complete!', 'success');

                // Clear buffers for next trade
                let stableCount = 0;
                while (stableCount < 5 && !this.stopTrade) {
                    const recv = await this.exchangeByte(this.NO_INPUT);
                    if (recv === this.NO_INPUT) {
                        stableCount++;
                    } else {
                        stableCount = 0;
                    }
                    await this.sleep(20);
                }

                this.log("Trade round completed! Preparing for next trade...");

                // Increment completed trades counter (for MVS2 logic)
                this.completedTradeCount++;
                if (this.verbose) this.log(`[DEBUG] Real trades completed: ${this.completedTradeCount}`);

                // Update peer's cached party data with our traded Pokemon
                // This mimics trade_mon - no need for new FLL2 exchange
                this.updatePeerPartyAfterTrade(ourChoice, peerChoice);

                // Clear gbPartyData so next trade reads fresh data from GB
                // (GB has already updated its party internally)
                this.gbPartyData = null;

                // Blank trade flags are already set correctly by ASK2 exchange (lines 1586/1594)
                // DO NOT override them here - subsequentTradeSequence needs these values

                // NOTE: ref impl also updates party data LOCALLY (trade_mon) and does NOT
                // re-send FLL2 after each trade. The server buffer contains STALE FLL2
                // from the ghost trade phase. We must use our locally updated cache only.
                this.log("Using locally updated cached data for next trade.");
                if (this.verbose) this.log(`[DEBUG] Trade complete: ownCounterId=${this.ownCounterId} (should carry to next trade)`);

                // Exit loop to restart trade sequence (like pool trade does)
                break;
            } else {
                this.log("Trade declined.");
                this.onStatus?.('Trade declined — pick another Pokémon');
            }
        }

        this.log("Link trade menu loop ended.");
    }

    // ==================== BUFFERED MODE NEGOTIATION ====================

    /**
     * Negotiate buffered/synchronous mode with the other player.
     * Following GSCBufferedNegotiator.choose_if_buffered() pattern.
     */
    async negotiateBufferedMode() {
        // ref impl protocol: send_with_counter sends [counter, value]
        // Counter starts random, then increments
        if (this.ownCounterId === undefined) {
            this.ownCounterId = Math.floor(Math.random() * 256);
        }

        // 1. Send our buffered preference with counter
        const ourMode = this.isBuffered ? 0x85 : 0x12;
        const bufPacket = new Uint8Array([this.ownCounterId, ourMode]);
        this.ws.sendData(this.MSG_BUF, bufPacket);
        if (this.verbose) this.log(`Sent ${this.MSG_BUF}: ${this.isBuffered ? 'Buffered (0x85)' : 'Sync (0x12)'} [Counter: ${this.ownCounterId}]`);
        this.ownCounterId = (this.ownCounterId + 1) % 256;

        // 2. Wait and get peer's preference
        await this.sleep(500);
        this.ws.sendGetData(this.MSG_BUF);
        const peerBuf = await this.waitForMessage(this.MSG_BUF);

        let peerMode = 0x12; // Default to Sync
        let peerCounter = 0;
        if (peerBuf && peerBuf.length >= 2) {
            peerCounter = peerBuf[0];
            peerMode = peerBuf[1];
        }

        const ourBuffered = this.isBuffered;
        const peerBuffered = (peerMode === 0x85);

        // Initialize peerCounterId from buffered message
        // The next message from peer will be peerCounter+1
        this.peerCounterId = (peerCounter + 1) % 256;
        if (this.verbose) this.log(`Peer ${this.MSG_BUF}: ${peerBuffered ? 'Buffered (0x85)' : 'Sync (0x12)'} [Counter: ${peerCounter}]`);
        if (this.verbose) this.log(`[DEBUG] Initialized peerCounterId=${this.peerCounterId} (next expected from peer)`);

        // Track last peer buffered counter to detect new messages
        this.lastPeerBufCounter = peerCounter;

        // 3. Check if modes match
        if (ourBuffered === peerBuffered) {
            this.log(`Modes match: ${ourBuffered ? 'Buffered' : 'Sync'}`);
            return;
        }

        // 4. Modes differ - need to negotiate via negotiation message
        this.log(`Modes differ! Negotiating via ${this.MSG_NEG}...`);

        let weAdapt = null; // null = undetermined, true = we adapt, false = peer adapts
        let attempts = 0;
        const MAX_ATTEMPTS = 10;

        // Step 1: Exchange negotiation values until one wins (like while change_buffered is None)
        while (weAdapt === null && attempts < MAX_ATTEMPTS && !this.stopTrade) {
            // Send random value
            const ourNegValue = Math.floor(Math.random() * 256);
            const negPacket = new Uint8Array([this.ownCounterId, ourNegValue]);
            this.ws.sendData(this.MSG_NEG, negPacket);
            this.log(`Sent ${this.MSG_NEG}: ${ourNegValue} [Counter: ${this.ownCounterId}]`);
            this.ownCounterId = (this.ownCounterId + 1) % 256;

            // Get peer's random value
            await this.sleep(200);
            this.ws.sendGetData(this.MSG_NEG);
            const peerNeg = await this.waitForMessage(this.MSG_NEG);

            if (peerNeg && peerNeg.length > 0) {
                const peerNegValue = peerNeg.length >= 2 ? peerNeg[1] : peerNeg[0];
                this.log(`Peer ${this.MSG_NEG}: ${peerNegValue}`);

                if (peerNegValue > ourNegValue) {
                    // We lost - we must adapt to peer's mode
                    weAdapt = true;
                    this.log(`${this.MSG_NEG} result: We adapt to peer's mode`);
                } else if (peerNegValue < ourNegValue) {
                    // We won - peer must adapt to our mode
                    weAdapt = false;
                    this.log(`${this.MSG_NEG} result: Peer adapts to our mode`);
                }
                // If equal, try again
            }
            attempts++;
        }

        if (weAdapt === null) {
            // Fallback to sync as safe default
            this.isBuffered = false;
            this.log("Negotiation failed (no winner), falling back to Sync mode");
            return;
        }

        // Step 2: Sync modes (like while buffered != other_buffered loop)
        // weAdapt alternates each round until modes match
        let currentMode = ourBuffered;
        let peerCurrentMode = peerBuffered;

        while (currentMode !== peerCurrentMode && !this.stopTrade) {
            if (weAdapt) {
                // We lost this round - prompt user if callback available
                let shouldSwitch = true; // Default to auto-accept

                if (this.negotiationPrompt) {
                    // Prompt user: "Other player wants X mode, switch?"
                    const peerModeStr = peerCurrentMode ? 'Buffered' : 'Synchronous';
                    shouldSwitch = await this.negotiationPrompt(peerModeStr);
                }

                if (shouldSwitch) {
                    // User agreed to switch
                    currentMode = peerCurrentMode;
                    this.isBuffered = currentMode;
                    this.log(`Switched to ${this.isBuffered ? 'Buffered' : 'Sync'} mode`);
                } else {
                    // User refused, keep our mode
                    this.log(`Keeping ${currentMode ? 'Buffered' : 'Sync'} mode, asking peer to switch...`);
                }

                // Send our (possibly unchanged) mode
                const newModeValue = this.isBuffered ? 0x85 : 0x12;
                const updatePacket = new Uint8Array([this.ownCounterId, newModeValue]);
                this.ws.sendData(this.MSG_BUF, updatePacket);
                if (this.verbose) this.log(`Sent ${this.MSG_BUF}: ${this.isBuffered ? 'Buffered' : 'Sync'} [Counter: ${this.ownCounterId}]`);
                this.ownCounterId = (this.ownCounterId + 1) % 256;

                // Update our tracked mode
                currentMode = this.isBuffered;
            } else {
                // Peer's turn to decide - wait for their NEW buffered message
                this.log("Waiting for other player's decision...");

                // force_receive keeps polling for our negotiation message.
                // We must keep resending it so ref impl can determine who won.
                // Store the last negotiation message we sent so we can resend it.
                const lastNegPacket = this.ws.sendDict[this.MSG_NEG];

                // Clear cached buffered message so we wait for a new one
                if (this.ws.recvDict && this.ws.recvDict[this.MSG_BUF]) {
                    delete this.ws.recvDict[this.MSG_BUF];
                }

                // Poll until we get peer's response
                let gotResponse = false;
                const startTime = Date.now();
                const timeout = 30000; // 30 second timeout

                while (!gotResponse && !this.stopTrade && (Date.now() - startTime < timeout)) {
                    await this.sleep(500);

                    // Keep negotiation message available for ref impl to GET (it polls repeatedly)
                    if (lastNegPacket) {
                        this.ws.sendData(this.MSG_NEG, lastNegPacket);
                    }

                    // Also keep our buffered message available - ref impl alternates between
                    // polling for negotiation (to determine winner) and buffered (to get decisions)
                    const ourBuf = this.ws.sendDict[this.MSG_BUF];
                    if (ourBuf) {
                        this.ws.sendData(this.MSG_BUF, ourBuf);
                    }

                    this.ws.sendGetData(this.MSG_BUF);
                    const updatedBuf = await this.waitForMessage(this.MSG_BUF, 2000);

                    if (updatedBuf && updatedBuf.length >= 2) {
                        const newPeerCounter = updatedBuf[0];
                        // Check if this is a NEW message (counter changed)
                        if (newPeerCounter !== this.lastPeerBufCounter) {
                            this.lastPeerBufCounter = newPeerCounter;
                            peerCurrentMode = (updatedBuf[1] === 0x85);
                            this.log(`Other player chose: ${peerCurrentMode ? 'Buffered' : 'Sync'} [Counter: ${newPeerCounter}]`);
                            gotResponse = true;
                        }
                    }
                }

                if (!gotResponse) {
                    this.log("Timeout waiting for peer's response - auto-accepting peer's mode");
                    // Auto-accept peer's mode to ensure trade can proceed
                    currentMode = peerCurrentMode;
                    this.isBuffered = currentMode;
                }
            }
            // Alternate turns (like change_buffered = not change_buffered)
            weAdapt = !weAdapt;
        }

        this.log(`Final mode: ${this.isBuffered ? 'Buffered' : 'Sync'}`);
    }


    // ==================== JAPANESE MAIL CONVERSION ====================

    /**
     * Convert mail data between Japanese and International formats.
     * Only applies when isJapanese is true.
     * 
     * @param {Uint8Array} data - Mail data to convert
     * @param {boolean} toDevice - true when sending TO Game Boy, false when receiving FROM Game Boy
     * @returns {Uint8Array} - Converted mail data (or original if not Japanese)
     */
    async convertMailData(data, toDevice) {
        if (!this.isJapanese || !data || data.length === 0) {
            return data;
        }

        // Ensure converter is loaded
        if (!this.jpMailConverter.isLoaded()) {
            await this.jpMailConverter.load();
        }

        if (toDevice) {
            // Sending TO Japanese Game Boy:
            // 1. Apply International mail patches
            // 2. Convert to Japanese format
            // 3. Create Japanese mail patches
            this.log('[JP] Converting mail: International → Japanese');
            GSCUtils.applyPatches(data, data, true, false); // isMail=true, isJapanese=false
            const jpData = this.jpMailConverter.convertToJp(data);
            GSCUtils.createPatchesData(jpData, jpData, true, true); // isMail=true, isJapanese=true
            return jpData;
        } else {
            // Receiving FROM Japanese Game Boy:
            // 1. Apply Japanese mail patches
            // 2. Convert to International format
            // 3. Create International mail patches
            this.log('[JP] Converting mail: Japanese → International');
            GSCUtils.applyPatches(data, data, true, true); // isMail=true, isJapanese=true
            const intData = this.jpMailConverter.convertToInt(data);
            GSCUtils.createPatchesData(intData, intData, true, false); // isMail=true, isJapanese=false
            return intData;
        }
    }

    /**
     * Convert pool Pokemon data to an egg.
     * Only used for pool trading when convertToEggs option is enabled.
     * 
     * ref impl equivalent in get_trading_data():
     *   mon.party_info.set_id(0, self.utils_class.egg_id)
     *   received_mon[0].set_hatching_cycles()
     *   received_mon[0].faint()
     *   received_mon[0].set_egg_nickname()
     * 
     * @param {Uint8Array} poolData - Single Pokemon data from pool (after slicing first byte)
     * @returns {Uint8Array} - Modified data with egg properties
     */
    convertPoolPokemonToEgg(poolData) {
        // Pool data layout (Python single_mon_to_data, no header byte):
        // [0-47] core struct (species at 0, cycles at 0x1B, status at 0x20,
        // HP at 0x22-0x23), [48-58] OT name, [59-69] nickname, then mail/sender
        // and a trailing egg-flag byte (0x38 = egg). Egg-ness is signaled via
        // that flag; the real species byte stays untouched.
        const data = new Uint8Array(poolData);

        // 1. Hatching cycles (Python set_hatching_cycles default = 1)
        data[0x1B] = 1;

        // 2. Faint the Pokemon (Python faint(): HP = 0, status = 0)
        data[0x20] = 0;
        data[0x22] = 0;
        data[0x23] = 0;

        // 3. Set nickname to "EGG" (offset 48 + 11 = 59, after OT name)
        const NICKNAME_OFFSET = 0x30 + 0x0B;
        // EGG in Game Boy encoding: E=0x84, G=0x86, G=0x86, terminated with 0x50
        const EGG_NICKNAME = [0x84, 0x86, 0x86, 0x50, 0x50, 0x50, 0x50, 0x50, 0x50, 0x50, 0x50];
        for (let i = 0; i < 11; i++) {
            data[NICKNAME_OFFSET + i] = EGG_NICKNAME[i];
        }

        // 4. Trailing egg flag: createTradingData turns this into the party-list
        // EGG_ID (0xFD)
        const EGG_FLAG_OFFSET = 0x75; // 48 + 11 + 11 + 33 + 14
        if (data.length > EGG_FLAG_OFFSET) {
            data[EGG_FLAG_OFFSET] = GSCUtils.EGG_VALUE;
        }
        this.log(`[POOL-EGG] Converted pool Pokemon to egg (cycles=1, fainted, EGG nickname)`);

        return data;
    }

    /**
     * Cap pool Pokemon level to maxLevel setting.
     * Based on Python reference (gsc_trading.py lines 324-325):
     *   if received_mon[0].get_level() > self.trader.max_level:
     *       received_mon[0].set_level(self.trader.max_level)
     * 
     * @param {Uint8Array} section1 - The party data section
     * @param {Object} utilsClass - GSCUtils or RBYUtils for position constants
     */
    capPoolPokemonLevel(section1, utilsClass) {
        if (!this.maxLevel || this.maxLevel >= 100) return;

        // Level is at trading_pokemon_pos + level_pos within section1
        // GSC: level_pos = 0x1F, RBY: level_pos = 0x21
        const levelOffset = utilsClass.trading_pokemon_pos + utilsClass.level_pos;

        if (levelOffset < section1.length) {
            const currentLevel = section1[levelOffset];
            if (currentLevel > this.maxLevel) {
                if (this.verbose) this.log(`[POOL] Capping Pokemon level from ${currentLevel} to ${this.maxLevel}`);
                section1[levelOffset] = this.maxLevel;
            }
        }
    }

    /**
     * Complete buffered mode negotiation after buffered message was already sent.
     * Receives peer's buffered response and handles negotiation if modes differ.
     */
    async completeBufferedNegotiation() {
        // Get peer's buffered response (may already be cached)
        this.ws.sendGetData(this.MSG_BUF);
        const peerBuf = await this.waitForMessage(this.MSG_BUF);

        let peerMode = 0x12; // Default to Sync
        let peerCounter = 0;
        if (peerBuf && peerBuf.length >= 2) {
            peerCounter = peerBuf[0];
            peerMode = peerBuf[1];
        }

        const ourBuffered = this.isBuffered;
        const peerBuffered = (peerMode === 0x85);

        // Initialize peerCounterId from buffered message
        this.peerCounterId = (peerCounter + 1) % 256;
        if (this.verbose) this.log(`Peer ${this.MSG_BUF}: ${peerBuffered ? 'Buffered (0x85)' : 'Sync (0x12)'} [Counter: ${peerCounter}]`);
        if (this.verbose) this.log(`[DEBUG] Initialized peerCounterId=${this.peerCounterId}`);

        // Track last peer buffered counter to detect new messages
        this.lastPeerBufCounter = peerCounter;

        // Check if modes match
        if (ourBuffered === peerBuffered) {
            this.log(`Modes match: ${ourBuffered ? 'Buffered' : 'Sync'}`);
            return;
        }

        // Modes differ - negotiate via negotiation message (same logic as negotiateBufferedMode)
        this.log(`Modes differ! Negotiating via ${this.MSG_NEG}...`);

        let weAdapt = null;
        let attempts = 0;
        const MAX_ATTEMPTS = 10;

        // Step 1: Exchange negotiation values until one wins
        while (weAdapt === null && attempts < MAX_ATTEMPTS && !this.stopTrade) {
            const ourNegValue = Math.floor(Math.random() * 256);
            const negPacket = new Uint8Array([this.ownCounterId, ourNegValue]);
            this.ws.sendData(this.MSG_NEG, negPacket);
            this.log(`Sent ${this.MSG_NEG}: ${ourNegValue} [Counter: ${this.ownCounterId}]`);
            this.ownCounterId = (this.ownCounterId + 1) % 256;

            await this.sleep(200);
            this.ws.sendGetData(this.MSG_NEG);
            const peerNeg = await this.waitForMessage(this.MSG_NEG);

            if (peerNeg && peerNeg.length > 0) {
                const peerNegValue = peerNeg.length >= 2 ? peerNeg[1] : peerNeg[0];
                this.log(`Peer ${this.MSG_NEG}: ${peerNegValue}`);

                if (peerNegValue > ourNegValue) {
                    weAdapt = true;
                    this.log(`${this.MSG_NEG} result: We adapt to peer's mode`);
                } else if (peerNegValue < ourNegValue) {
                    weAdapt = false;
                    this.log(`${this.MSG_NEG} result: Peer adapts to our mode`);
                }
            }
            attempts++;
        }

        if (weAdapt === null) {
            this.isBuffered = false;
            this.log("Negotiation failed (no winner), falling back to Sync mode");
            return;
        }

        // Step 2: Sync modes via updated buffered exchange
        let currentMode = ourBuffered;
        let peerCurrentMode = peerBuffered;

        while (currentMode !== peerCurrentMode && !this.stopTrade) {
            if (weAdapt) {
                // We lost this round - prompt user if callback available
                let shouldSwitch = true; // Default to auto-accept

                if (this.negotiationPrompt) {
                    const peerModeStr = peerCurrentMode ? 'Buffered' : 'Synchronous';
                    shouldSwitch = await this.negotiationPrompt(peerModeStr);
                }

                if (shouldSwitch) {
                    currentMode = peerCurrentMode;
                    this.isBuffered = currentMode;
                    this.log(`Switched to ${this.isBuffered ? 'Buffered' : 'Sync'} mode`);
                } else {
                    this.log(`Keeping ${currentMode ? 'Buffered' : 'Sync'} mode, asking peer to switch...`);
                }

                const newModeValue = this.isBuffered ? 0x85 : 0x12;
                const updatePacket = new Uint8Array([this.ownCounterId, newModeValue]);
                this.ws.sendData(this.MSG_BUF, updatePacket);
                if (this.verbose) this.log(`Sent ${this.MSG_BUF}: ${this.isBuffered ? 'Buffered' : 'Sync'} [Counter: ${this.ownCounterId}]`);
                this.ownCounterId = (this.ownCounterId + 1) % 256;
                currentMode = this.isBuffered;
            } else {
                // Peer's turn to decide - wait for their NEW buffered message
                this.log("Waiting for other player's decision...");

                // Clear cached buffered message so we wait for a new one
                if (this.ws.recvDict && this.ws.recvDict[this.MSG_BUF]) {
                    delete this.ws.recvDict[this.MSG_BUF];
                }

                // Poll until we get peer's response
                let gotResponse = false;
                const startTime = Date.now();
                const timeout = 30000;

                while (!gotResponse && !this.stopTrade && (Date.now() - startTime < timeout)) {
                    await this.sleep(500);
                    this.ws.sendGetData(this.MSG_BUF);
                    const updatedBuf = await this.waitForMessage(this.MSG_BUF, 2000);

                    if (updatedBuf && updatedBuf.length >= 2) {
                        const newPeerCounter = updatedBuf[0];
                        if (newPeerCounter !== this.lastPeerBufCounter) {
                            this.lastPeerBufCounter = newPeerCounter;
                            peerCurrentMode = (updatedBuf[1] === 0x85);
                            this.log(`Other player chose: ${peerCurrentMode ? 'Buffered' : 'Sync'} [Counter: ${newPeerCounter}]`);
                            gotResponse = true;
                        }
                    }
                }

                if (!gotResponse) {
                    this.log("Timeout waiting for peer's response - auto-accepting peer's mode");
                    // Auto-accept peer's mode to ensure trade can proceed
                    currentMode = peerCurrentMode;
                    this.isBuffered = currentMode;
                }
            }
            weAdapt = !weAdapt;
        }

        this.log(`Final mode: ${this.isBuffered ? 'Buffered' : 'Sync'}`);
    }


    async startTrade() {
        // First, enter the room (only done once at the very beginning)
        this.log(`Starting GSC Trade Protocol (${this.tradeType} mode, ${this.isBuffered ? 'buffered' : 'sync'})...`);

        // Load default party data (ZUBAT) for ghost trades
        // IMPORTANT: Always load for link trades even if initially sync mode,
        // because negotiation may switch us to buffered mode later!
        if (this.isLinkTrade && !GSCUtils.defaultPartyData) {
            await GSCUtils.loadDefaultPartyData();
        }

        // Load Pokemon names for potential cross-version nickname replacement
        await GSCUtils.loadPokemonNames();

        // Initialize blank trade flags for data exchange tracking
        this.ownBlankTrade = true;
        this.otherBlankTrade = true;

        // === CRITICAL: Pre-populate buffered response for background negotiator ===
        // GSCBufferedNegotiator sends GET immediately upon connection.
        // We MUST have data ready to respond, otherwise ref impl hangs waiting for it.
        if (this.ownCounterId === undefined) {
            this.ownCounterId = Math.floor(Math.random() * 256);
        }
        const ourMode = this.isBuffered ? 0x85 : 0x12; // 0x85 = Buffered, 0x12 = Sync
        const bufPacket = new Uint8Array([this.ownCounterId, ourMode]);
        this.ws.sendDict[this.MSG_BUF] = bufPacket; // Pre-populate for GET requests
        if (this.verbose) this.log(`Pre-populated ${this.MSG_BUF} for negotiator: ${this.isBuffered ? 'Buffered' : 'Sync'} [Counter: ${this.ownCounterId}]`);        // === PROTOCOL BEHAVIOR: Start buffered negotiation IMMEDIATELY (before enter_room) ===
        // GSCBufferedNegotiator.start() runs in background from the start
        // It sends buffered data immediately while the main thread continues to enter_room and sit_to_table
        // We'll create a background promise that runs negotiation in parallel
        let negotiationPromise = null;

        if (this.isLinkTrade && !this.initialNegotiationDone) {
            // Initialize counter if not set
            if (this.ownCounterId === undefined) {
                this.ownCounterId = Math.floor(Math.random() * 256);
            }
            // Send buffered data IMMEDIATELY (like background thread)
            const ourMode = this.isBuffered ? 0x85 : 0x12;
            const bufPacket = new Uint8Array([this.ownCounterId, ourMode]);
            this.ws.sendData(this.MSG_BUF, bufPacket);
            if (this.verbose) this.log(`Sent ${this.MSG_BUF} early (like ref impl): ${this.isBuffered ? 'Buffered (0x85)' : 'Sync (0x12)'} [Counter: ${this.ownCounterId}]`);
            this.ownCounterId = (this.ownCounterId + 1) % 256;

            // === START NEGOTIATION IN BACKGROUND (like thread) ===
            // This promise runs in parallel while user sits at table
            this.log("Starting background negotiation (like thread)...");
            negotiationPromise = (async () => {
                // Wait for peer to connect (polls for their buffered data)
                await this.waitForPeer();
                // Complete the full negotiation
                await this.completeBufferedNegotiation();
                this.initialNegotiationDone = true;
                return this.isBuffered;
            })();
        }


        // Enter room - don't wait for peer (like ref impl does)
        await this.enterRoom();
        this.log("Entered Room.");

        // Outer loop for continuous trading - while True: loop
        while (!this.stopTrade) {
            if (this.verbose) this.log(`[DEBUG] startTrade loop start. ownBlankTrade=${this.ownBlankTrade}, otherBlankTrade=${this.otherBlankTrade}`);
            try {
                // START VEC2 FLOOD: Ensure ref impl receives VEC2 regardless of timing (Sit vs Negotiate)
                this.startVEC2Flood();

                // Sit at table - GB returns to this state after each trade
                this.log("Sitting at table...");
                const sitResult = await this.sitToTableWithTimeout();
                if (!sitResult) {
                    this.log("Player left trading room. Exiting...");
                    this.stopVEC2Flood();
                    break;
                }

                if (this.stopTrade) {
                    this.stopVEC2Flood();
                    break;
                }
                this.log("Sat at table. Starting Trade Sequence...");

                // For link trade: wait for background negotiation to complete (like force_receive)
                if (this.isLinkTrade && negotiationPromise) {
                    this.log("Link Trade: Waiting for background negotiation to complete...");
                    const pendingNegotiation = negotiationPromise;
                    negotiationPromise = null; // Only wait once - even if it throws
                    await pendingNegotiation;
                    this.log(`Link Trade: Negotiation complete. Mode: ${this.isBuffered ? 'Buffered' : 'Sync'}`);
                }

                // === PROTOCOL LOGIC: Different behavior for first vs subsequent trades ===
                // synchronous_trade() at line 1379:
                //   if self.other_pokemon is None:
                //       data, data_other = self.trade_starting_sequence(False)
                //   return True  # Otherwise skips sync!
                // So ref impl skips sync when it has cached data, regardless of flags.
                // We must match this: use cached path if bufferedOtherData exists.
                const hasCachedPeerData = this.bufferedOtherData && this.bufferedOtherData[1];

                if ((this.ownBlankTrade && this.otherBlankTrade) && !hasCachedPeerData) {
                    // FIRST TRADE: No cached data, do full sync exchange
                    this.log("Full trade sequence (first sit or after reset)...");
                    await this.tradeStartingSequence();
                } else {
                    // SUBSEQUENT/RE-ENTRY: Have cached data, reuse it
                    this.log("Subsequent trade sequence (reusing cached data)...");
                    await this.subsequentTradeSequence();
                }

                // Stop flood after negotiation completes
                this.stopVEC2Flood();

                // Flag reset is now handled INSIDE the sequence functions, BEFORE linkTradeMenuLoop
                // This matches placement at lines 1462-1463 (before do_trade)
                if (this.verbose) this.log(`[DEBUG] startTrade loop: trade sequence returned. ownBlankTrade=${this.ownBlankTrade}, otherBlankTrade=${this.otherBlankTrade}`);
            } catch (error) {
                this.log(`[ERROR] Exception in startTrade loop: ${error.message}`);
                console.error(error);
                // Pause briefly to avoid tight loop on error
                await this.sleep(1000);
            }
        }

        this.log("GSC trading session ended.");
    }

    /**
     * Sit to table with timeout detection.
     * Returns true if successfully sat, false if player left.
     * Matches sit_to_table() with die_on_no_data=True behavior.
     */
    async sitToTableWithTimeout() {
        const sitStates = [[0x75, 0x75, 0x76], [new Set([0x75]), new Set([0]), new Set([0xFD])]];
        let sitState = 0;
        let consecutiveNoData = 0;
        const MAX_NO_DATA = 256;

        while (sitState < sitStates[0].length && !this.stopTrade) {
            const recv = await this.exchangeByte(sitStates[0][sitState]);
            if (sitStates[1][sitState].has(recv)) {
                if (this.verbose) this.log(`Sit State advanced to ${sitState + 1}. Recv: ${recv.toString(16)}`);
                sitState++;
                consecutiveNoData = 0;
            } else if (sitState === 0) {
                // Only check for NO_DATA timeout on first state
                if (recv === this.NO_DATA) {
                    consecutiveNoData++;
                    if (consecutiveNoData >= MAX_NO_DATA) {
                        this.log("Timeout waiting at table - player left trading room");
                        return false;
                    }
                } else {
                    consecutiveNoData = 0;
                }
            }
            await this.sleep(5);
        }
        return true;
    }

    /**
     * Subsequent trade sequence - used when returning to table after a trade.
     * Only exchanges MVS2 (move data) and reuses cached party data.
     * Matches behavior when own_blank_trade or other_blank_trade is False.
     */
    async subsequentTradeSequence() {
        if (this.verbose) this.log(`[DEBUG] subsequentTradeSequence: Starting. ownCounterId=${this.ownCounterId}, peerCounterId=${this.peerCounterId}`);
        if (this.verbose) this.log(`[DEBUG] subsequentTradeSequence: ownBlankTrade=${this.ownBlankTrade}, otherBlankTrade=${this.otherBlankTrade}`);

        // === CLEAR STALE CACHED MESSAGES FROM PREVIOUS TRADE ===
        // Like buffered mode, we must clear cached messages to avoid counter sync issues
        // Old CHC, ACP, ASK, SUC, MVS from first trade would have wrong counters
        delete this.ws.recvDict["CHC2"];
        delete this.ws.recvDict["ACP2"];
        delete this.ws.recvDict[this.MSG_ASK];
        delete this.ws.recvDict["SUC2"];
        delete this.ws.recvDict[this.MSG_MVS];
        delete this.ws.recvDict[this.MSG_SNG];
        if (this.verbose) this.log("[DEBUG] Cleared stale cached messages for subsequent trade");

        if (!this.isLinkTrade) {
            // Pool trade doesn't support re-entry, just do full sequence
            await this.tradeStartingSequence();
            return;
        }

        // === MVS2 LOGIC: Depends on scenario ===
        // Scenario A: Normal subsequent trade (flags False) - exchange MVS2 with peer
        // Scenario B: Re-entry after STOP_TRADE (flags True but has cached data) - ref impl skips everything!
        //   synchronous_trade() at line 1379: if other_pokemon is cached, just returns.
        //   No MVS2 sent or received. We must match this.
        const isReEntryWithCachedData = this.ownBlankTrade && this.otherBlankTrade;

        if (isReEntryWithCachedData) {
            // === RE-ENTRY AFTER STOP_TRADE ===
            // synchronous_trade() does NOTHING when other_pokemon is cached.
            // Just go straight to trade menu.
            this.log("Re-entry with cached data: Skipping MVS2 exchange");
        } else {
            // === NORMAL SUBSEQUENT TRADE ===
            // Matching Python gsc_trading.py lines 1441-1460
            //
            // Flag semantics (from ref impl):
            // - other_blank_trade = what PEER now owns (what I sent) needs input
            //   -> If true, PEER will evolve/learn moves, then send me MVS2
            //   -> So I should RECEIVE MVS2 from peer BEFORE section exchange
            //
            // Step 1: Conditionally receive MVS2 BEFORE section exchange
            if (this.otherBlankTrade) {
                // Peer received a special mon (from me) -> peer sends me updated moves
                this.log("Receiving peer's MVS2 (move data) before sections...");
                await this.receiveMVS2();
            } else {
                // Increment counter if not receiving (to match ref impl)
                if (this.peerCounterId !== null) {
                    this.peerCounterId = (this.peerCounterId + 1) % 256;
                    if (this.verbose) this.log(`[DEBUG] Incremented peerCounterId to ${this.peerCounterId} (not receiving MVS2)`);
                }
            }
        }

        // Reuse cached peer data for section exchange
        // ref impl line 1455: trade_starting_sequence(True, send_data=...)
        if (!this.bufferedOtherData) {
            this.log("[WARN] No cached peer data for subsequent trade - falling back to full sequence");
            await this.tradeStartingSequence();
            return;
        }

        this.log("Using cached peer party data for trade...");
        let sendParty = this.bufferedOtherData[1];
        let sendPatches = this.bufferedOtherData[2];
        if (this.cachedPeerPartyDecoded) {
            // The cached party is decoded: re-escape 0xFE bytes and rebuild the
            // patch section (createPatchesData edits the party clone in place),
            // like Python create_trading_data does for every re-send.
            sendParty = new Uint8Array(this.bufferedOtherData[1]);
            sendPatches = new Uint8Array(this.bufferedOtherData[2]);
            GSCUtils.createPatchesData(sendParty, sendPatches, false);
        }
        const tradeData = {
            section1: sendParty,
            section2: sendPatches,
            section3: this.bufferedOtherData[3]
        };

        // Get fresh random data from server (cached from first trade)
        this.ws.sendGetData("RAN2");
        const randomData = await this.waitForMessage("RAN2");
        if (this.verbose) this.log(`Random Data received: ${randomData.length} bytes`);

        // === EXCHANGE SECTIONS WITH BUFFERED MODE (skipSync=true) ===
        // ref impl uses trade_starting_sequence(buffered=True) for subsequent trades
        // This means NO network sync, just exchange data with GB using cached peer data
        const skipSync = true; // Buffered mode - no peer sync needed

        await this.readSection(0, randomData, skipSync);
        this.gbPartyData = await this.readSection(1, tradeData.section1, skipSync);
        await this.readSection(2, tradeData.section2, skipSync);

        // === MAIL DETECTION (same as first trade) ===
        this.ownPartyHasMail = this.partyHasMail(this.gbPartyData);
        this.peerPartyHasMail = this.partyHasMail(this.peerPartyData);
        const needMailSection = this.ownPartyHasMail || this.peerPartyHasMail;
        if (!needMailSection) {
            if (this.verbose) this.log("[MAIL] Neither party has mail. Skipping Section 3 sync.");
        }

        await this.readSection(3, tradeData.section3, skipSync);

        // === Step 2: ALWAYS SEND MVS2 AFTER section exchange ===
        // ref impl line 1460: self.comms.send_move_data_only() (unconditional)
        // This sends my updated move data to peer after GB interaction
        this.log("Sending MVS2 (move data) to peer...");
        await this.sendMVS2();

        // === 1462-1463: Reset flags to True BEFORE entering trade menu ===
        // This is critical for resync: if the trade menu exits without completing,
        // both clients will have flags=True and do full exchange on re-entry.
        // The flags are only set to other values inside linkTradeMenuLoop on SUCCESS.
        this.ownBlankTrade = true;
        this.otherBlankTrade = true;
        if (this.verbose) this.log("[DEBUG] Reset blank trade flags to true before entering trade menu");

        // Enter trade menu
        this.log("Entering trade menu loop...");
        await this.linkTradeMenuLoop();
    }

    async waitForNoData(next, resentByte, limitResends = 20) {
        // Keep sending resentByte until we receive NO_DATA (0x00)
        let resends = 0;
        while (next !== this.NO_DATA && !this.stopTrade) {
            next = await this.exchangeByte(resentByte);
            if (limitResends > 0) {
                resends++;
                if (resends >= limitResends) {
                    break;
                }
            }
            await this.sleep(5);
        }
        return next;
    }

    async waitForNoInput(next) {
        // Keep sending NO_INPUT until we receive NO_INPUT (0xFE)
        while (next !== this.NO_INPUT && !this.stopTrade) {
            next = await this.exchangeByte(this.NO_INPUT);
            await this.sleep(5);
        }
        return next;
    }

    // ==================== SNG2 SYNC PROTOCOL HELPERS (NEW FORMAT) ====================
    // NEW format: 32 bytes = 8 entries × 4 bytes each
    // Each entry: [flags, pos_lo, val, extra_val] 
    // flags = (pos_hi & 0x01) | (extra_bits << 1) | (is_filler << 7)

    TOTAL_SEND_BUF_NEW_BYTES = 8;
    BYTES_PER_SEND_BUF_NEW_BYTE = 4;

    /**
     * Write a single SNG2 NEW entry (4 bytes)
     * data = [pos, val, extra_val, is_filler, extra_bits]
     */
    writeSyncDataNew(data) {
        const pos = data[0];
        const val = data[1];
        const extraVal = data[2] || 0;
        const isFiller = data[3] ? 1 : 0;
        const extraBits = data[4] || 0;

        const flags = ((pos >> 8) & 0x01) | ((extraBits & 0x3F) << 1) | (isFiller << 7);
        return [flags, pos & 0xFF, val, extraVal];
    }

    /**
     * Read a single SNG2 NEW entry (4 bytes)
     * Returns [pos, val, extra_val, is_filler, extra_bits]
     */
    readSyncDataNew(data, pos) {
        if (!data || data.length < pos + 4) return null;

        const flags = data[pos];
        const posLo = data[pos + 1];
        const val = data[pos + 2];
        const extraVal = data[pos + 3];

        let fullPos = ((flags & 0x01) << 8) + posLo;
        const isFiller = (flags >> 7) === 1;
        const extraBits = (flags >> 1) & 0x3F;

        // 0x1FF marker means 0xFFFF (sync marker)
        if (fullPos === 0x1FF) {
            fullPos = 0xFFFF;
        }

        return [fullPos, val, extraVal, isFiller, extraBits];
    }

    /**
     * Write full SNG2 NEW packet (32 bytes = 8 entries × 4 bytes)
     * sendBuf = array of 8 entries, each [pos, val, extra_val, is_filler, extra_bits]
     */
    writeEntireDataNew(sendBuf) {
        const result = [];
        for (let i = 0; i < this.TOTAL_SEND_BUF_NEW_BYTES; i++) {
            const entry = sendBuf[i] || [0xFFFF, 0xFF, 0, false, 0];
            result.push(...this.writeSyncDataNew(entry));
        }
        return new Uint8Array(result);
    }

    /**
     * Read full SNG2 NEW packet (32 bytes)
     * Returns array of 8 entries, each [pos, val, extra_val, is_filler, extra_bits]
     */
    readEntireDataNew(data) {
        if (!data || data.length < 32) return null;

        const result = [];
        for (let i = 0; i < this.TOTAL_SEND_BUF_NEW_BYTES; i++) {
            result.push(this.readSyncDataNew(data, i * this.BYTES_PER_SEND_BUF_NEW_BYTE));
        }
        return result;
    }

    /**
     * Extract available byte positions from received SNG2 NEW packet.
     * Returns map of {position: value}
     */
    getSwappableBytesNew(recvBuf, length, index) {
        const ret = {};
        if (!recvBuf) return ret;

        // Mirrors Python prepare_single_entry_new: an entry for a LATER section
        // means the peer moved on (treat as our completion); only entries for
        // THIS section are consumable; earlier-section stragglers are ignored.
        for (let i = 0; i < this.TOTAL_SEND_BUF_NEW_BYTES; i++) {
            const entry = recvBuf[i];
            if (!entry) continue;
            if (entry[0] === 0xFFFF) continue; // sync marker, not data
            if (entry[2] > index) {
                ret[length] = 0;
            } else if (entry[2] === index && entry[0] <= length) {
                if (entry[3]) {
                    // Filler entry: expands to extra_bits repeated bytes
                    for (let j = 0; j < entry[4]; j++) {
                        ret[entry[0] + j] = entry[1];
                    }
                } else {
                    ret[entry[0]] = entry[1];
                }
            }
        }
        return ret;
    }

    // ==================== SNG2 OLD FORMAT HELPERS ====================
    // OLD format: 7 bytes = 2 entries × 3 bytes + 1 index byte
    // Entry: [pos_hi, pos_lo, val]

    TOTAL_SEND_BUF_OLD_BYTES = 2;
    BYTES_PER_SEND_BUF_OLD_BYTE = 3;

    /**
     * Write OLD format packet (7 bytes = 2 entries × 3 bytes + 1 index)
     * sendBuf = [[pos0, val0], [pos1, val1], [index]]
     * Wire format: [pos_hi, pos_lo, val] for each entry
     */
    writeEntireDataOld(data) {
        return new Uint8Array([
            (data[0][0] >> 8) & 0xFF, data[0][0] & 0xFF, data[0][1],  // pos0 (big-endian), val0
            (data[1][0] >> 8) & 0xFF, data[1][0] & 0xFF, data[1][1],  // pos1 (big-endian), val1
            data[2][0]                                                 // index
        ]);
    }

    /**
     * Read OLD format packet (7 bytes)
     * Returns [[pos0, val0], [pos1, val1], [index]]
     * Wire format: [pos_hi, pos_lo, val] for each entry
     */
    readEntireDataOld(data) {
        if (!data || data.length < 7) return null;
        return [
            [(data[0] << 8) + data[1], data[2]],   // pos0 (big-endian), val0
            [(data[3] << 8) + data[4], data[5]],   // pos1 (big-endian), val1
            [data[6]]                               // index
        ];
    }

    /**
     * Extract bytes from OLD format packet
     */
    getSwappableBytesOld(recvBuf, length, index) {
        const ret = {};
        if (!recvBuf) return ret;

        for (let i = 0; i < 2; i++) {
            if (recvBuf[i] && recvBuf[i][0] !== 0xFFFF) {
                // prepare_single_entry logic:
                // 1. If recv_buf[2] >= (index + 1), treat as completion (ret[length] = 0)
                // 2. If byte_num <= length, accept the byte
                const recvIndex = recvBuf[2] ? recvBuf[2][0] : 0;

                if (recvIndex >= (index + 1)) {
                    // Peer has moved to next section - treat as completion
                    ret[length] = 0;
                } else if (recvIndex === index) {
                    const pos = recvBuf[i][0];
                    const val = recvBuf[i][1];
                    // ref impl uses byte_num <= length (includes completion position)
                    if (pos <= length) {
                        ret[pos] = val;
                    }
                }
            }
        }
        return ret;
    }

    // ==================== AUTO-SWITCHING PROTOCOL METHODS ====================

    /**
     * Poll for SNG2 trading data from peer.
     * Returns parsed packet or null if not available.
     */
    async getTradeData() {
        const data = this.ws.recvDict[this.MSG_SNG];
        if (!data) {
            // Pull-based recovery like Python's recv_data: when nothing has
            // arrived, ask the peer's stored send buffer for its latest packet.
            const now = Date.now();
            if (!this._lastSngGet || now - this._lastSngGet > 100) {
                this._lastSngGet = now;
                this.ws.sendGetData(this.MSG_SNG);
            }
            return null;
        }
        // Consume-once, matching Python's recv_dict pop: a stale packet must
        // never be re-parsed across polls, sections, or trades.
        delete this.ws.recvDict[this.MSG_SNG];

        // Auto-detect protocol from packet size
        if (data.length >= 32) {
            // NEW protocol packet (32 bytes)
            if (!this.useNewProtocol) {
                this.log("[PROTOCOL] Auto-detected NEW protocol from 32-byte packet");
                this.useNewProtocol = true;
            }
            return this.readEntireDataNew(data);
        } else if (data.length >= 7) {
            // OLD protocol packet (7 bytes)
            if (this.useNewProtocol) {
                this.log("[PROTOCOL] Auto-detected OLD protocol from 7-byte packet - switching!");
                this.useNewProtocol = false;
            }
            return this.readEntireDataOld(data);
        }
        return null;
    }

    /**
     * Send SNG2 trading data to peer.
     */
    sendTradeData(sendBuf) {
        let packet;
        if (this.useNewProtocol) {
            packet = this.writeEntireDataNew(sendBuf);
        } else {
            // Convert to OLD format: [[pos, val], [pos, val], [index]]
            const oldBuf = [
                [sendBuf[0] ? sendBuf[0][0] : 0xFFFF, sendBuf[0] ? sendBuf[0][1] : 0xFF],
                [sendBuf[1] ? sendBuf[1][0] : 0xFFFF, sendBuf[1] ? sendBuf[1][1] : 0xFF],
                [sendBuf[0] ? sendBuf[0][2] : 0]  // index from first entry's extra_val
            ];
            packet = this.writeEntireDataOld(oldBuf);
        }
        this.ws.sendData(this.MSG_SNG, packet);
        this.ws.sendDict[this.MSG_SNG] = packet;
    }

    /**
     * Create sync marker packet (8 entries, each with 0xFFFF marker)
     * Matches ref impl format: 0xFFFF marker, val=0xFF, extra_val=index
     */
    createSyncPacket(index) {
        const sendBuf = [];
        for (let i = 0; i < this.TOTAL_SEND_BUF_NEW_BYTES; i++) {
            // [pos, val, extra_val, is_filler, extra_bits]
            // 0xFFFF is sync marker, val = 0xFF (not index!), extra_val = section index
            sendBuf.push([0xFFFF, 0xFF, index, false, 0]);
        }
        return sendBuf;
    }

    /**
     * Create data packet with current position data
     */
    createDataPacket(sendBufData, index = 0) {
        const sendBuf = [];
        for (let i = 0; i < this.TOTAL_SEND_BUF_NEW_BYTES; i++) {
            if (sendBufData[i]) {
                sendBuf.push(sendBufData[i]);
            } else {
                // Filler entries must carry the section index: Python peers read
                // slot 7's extra_val as the sync-marker section and kill the
                // trade as "incompatible" if it doesn't match.
                sendBuf.push([0xFFFF, 0xFF, index, false, 0]);
            }
        }
        return sendBuf;
    }

    /**
     * Synchronous handshake: Wait for both clients to be ready for a section.
     */
    async synchSynchSection(index) {
        // Send sync marker packet
        const sendBuf = this.createSyncPacket(index);
        this.sendTradeData(sendBuf);

        this.log(`Sync Section ${index}: Waiting for peer synchronization...`);
        this.onStatus?.('Waiting for the other player…');

        let found = false;
        let wrongIndexMarkers = 0;
        let waitIterations = 0;
        const MAX_SYNC_WAIT_ITERATIONS = 3000; // * ~100ms = ~5 minutes
        while (!found && !this.stopTrade) {
            if (++waitIterations > MAX_SYNC_WAIT_ITERATIONS) {
                this.log(`[ERROR] Sync Section ${index}: Other player never synchronized. Aborting trade.`);
                this.stopTrade = true;
                return;
            }

            // Poll for peer's sync marker (getTradeData pulls via GET when empty)
            const recvBuf = await this.getTradeData();
            if (recvBuf) {
                // Debug log content periodically
                if (Math.random() < 0.05) {
                    if (this.useNewProtocol) {
                        const lastEntry = recvBuf[this.TOTAL_SEND_BUF_NEW_BYTES - 1];
                        if (this.verbose) this.log(`[DEBUG] Sync Check (NEW): Entry=${lastEntry ? lastEntry.join(',') : 'null'}, Index=${index}`);
                    } else {
                        // OLD format: [[pos0, val0], [pos1, val1], [index]]
                        if (this.verbose) this.log(`[DEBUG] Sync Check (OLD): recvBuf[0]=${recvBuf[0]?.join(',')}, recvBuf[2]=${recvBuf[2]?.join(',')}, Index=${index}`);
                    }
                }

                if (this.useNewProtocol) {
                    // NEW PROTOCOL: Check if last entry (index 7) has 0xFFFF marker with our section index
                    const lastEntry = recvBuf[this.TOTAL_SEND_BUF_NEW_BYTES - 1];
                    if (lastEntry && lastEntry[0] === 0xFFFF && lastEntry[2] === index) {
                        found = true;
                        this.log(`Sync Section ${index}: Peer synchronized!`);
                    } else if (lastEntry && lastEntry[0] === 0xFFFF &&
                               lastEntry[2] !== index && lastEntry[2] !== index - 1) {
                        // Python kills the trade when the peer's sync marker is
                        // for an unrelated section (incompatible trade states).
                        // A marker for the PREVIOUS section is just a straggler.
                        if (++wrongIndexMarkers >= 5) {
                            this.log(`[ERROR] Sync Section ${index}: Other player is at section ${lastEntry[2]} - incompatible trade state. Aborting.`);
                            this.stopTrade = true;
                            return;
                        }
                    } else {
                        // Check if peer already sending valid data (implicit sync)
                        const hasValidData = recvBuf.some(e => e[0] !== 0xFFFF && e[2] === index);
                        if (hasValidData) {
                            found = true;
                            this.log(`Sync Section ${index}: Peer already sending data (Implicit Sync)`);
                        }
                    }
                } else {
                    // OLD PROTOCOL: Format is [[pos0, val0], [pos1, val1], [index]]
                    // Sync marker: pos0 = 0xFFFF, and recvBuf[2][0] = section index
                    const pos0 = recvBuf[0] ? recvBuf[0][0] : null;
                    const peerIndex = recvBuf[2] ? recvBuf[2][0] : null;

                    if (pos0 === 0xFFFF && peerIndex === index) {
                        found = true;
                        this.log(`Sync Section ${index}: Peer synchronized!`);
                    } else if (pos0 !== null && pos0 !== 0xFFFF && peerIndex === index) {
                        // Peer already sending valid data (implicit sync)
                        found = true;
                        this.log(`Sync Section ${index}: Peer already sending data (Implicit Sync)`);
                    }
                }
            }

            if (!found) {
                // Keep GB clock alive while waiting
                try {
                    await this.exchangeByte(this.NO_INPUT);
                } catch (e) {
                    this.log(`[ERROR] USB Error in Sync Loop: ${e.message}`);
                    this.stopTrade = true;
                    return;
                }

                // Slow down polling to prevent flood
                await this.sleep(100);
            }
        }
        await this.sleep(100);

        // Re-send our sync marker
        this.sendTradeData(sendBuf);
    }

    /**
     * Synchronous section exchange: Interleave GB and WebSocket I/O.
     */
    async synchExchangeSection(index, length, firstByte) {
        // Our data from GB + Peer's data to send to GB
        const buf = [firstByte];      // Our GB's data
        const otherBuf = [];          // Peer's data to send to our GB

        // Send buffer data: track positions (8 for NEW, 2 for OLD protocol)
        // Entry format: [pos, val, extra_val, is_filler, extra_bits]
        const sendBufData = {};
        sendBufData[0] = [0, firstByte, index, false, 0];
        let sendIndex = 1;
        let recvData = {};

        this.log(`Sync Exchange Section ${index}: Starting (${length} bytes)`);

        if (this.useNewProtocol) {
            // Faithful port of Python synch_exchange_section_new: the GB streams
            // its section at its own paced cadence (posSend advances on every
            // transfer) while peer data is fed to it lagging behind (iFeed <=
            // posRecv), within a small tolerance window. Network latency adds
            // LAG, not per-byte cost, so a section takes ~length * pacing
            // instead of length * round-trips. A starved forced transfer feeds
            // NO_INPUT to the GB and counts as a dropped byte (bytesOffset),
            // exactly like Python; the section tail absorbs the slack.
            const MAX_TOLERANCE_BYTES = 3;
            const SAFETY_AMOUNT = MAX_TOLERANCE_BYTES - 2;
            const WAIT_POLL_MS = 4; // poll cadence while waiting on network data
            const MAX_MS_BETWEEN_TRANSFERS = 800; // Python max_seconds_between_transfers
            let posSend = 1;   // next position for our GB's bytes (0 = firstByte)
            let posRecv = 0;   // contiguous peer bytes buffered into otherBuf
            let iFeed = 0;     // next peer byte to feed the GB
            let bytesOffset = 1;
            const bytesOffsetTarget = MAX_TOLERANCE_BYTES;
            let lastTransfer = Date.now();

            this.sendTradeData(this.createDataPacket(sendBufData, index));

            while (iFeed < (length - MAX_TOLERANCE_BYTES) && !this.stopTrade) {
                const recvBuf = await this.getTradeData();
                if (recvBuf) {
                    Object.assign(recvData, this.getSwappableBytesNew(recvBuf, length, index));
                    while (recvData[posRecv] !== undefined && posRecv < length) {
                        const raw = recvData[posRecv] & 0xFF;
                        // Python prevent_no_input: the receiver converts the
                        // NO_INPUT control code to 0xFF before it can reach the GB
                        otherBuf.push(raw === 0xFE ? 0xFF : raw);
                        posRecv++;
                    }
                }

                let byteToConsole = this.NO_INPUT;
                let schedule = false;
                if (Date.now() - lastTransfer >= MAX_MS_BETWEEN_TRANSFERS) schedule = true;
                if (bytesOffset < bytesOffsetTarget) {
                    schedule = true;
                } else if (posRecv > iFeed) {
                    byteToConsole = otherBuf[iFeed];
                    if (posRecv > (iFeed + SAFETY_AMOUNT)) schedule = true;
                    if (schedule) iFeed++;
                }

                if (schedule) {
                    if (byteToConsole === this.NO_INPUT) {
                        bytesOffset++;
                        if (bytesOffset > bytesOffsetTarget) {
                            // Python act_on_bad_data: a real byte was dropped
                            if (this.crashOnSyncDrop) {
                                this.log(`[ERROR] Section ${index}: no data from the other player - byte dropped. Aborting trade.`);
                                this.stopTrade = true;
                                throw new Error(`Section ${index} byte drop (fed ${iFeed}/${length})`);
                            }
                            this.log(`[WARN] Section ${index}: dropped byte (${bytesOffset - bytesOffsetTarget})`);
                            if (bytesOffset > bytesOffsetTarget + 20) {
                                this.log(`[ERROR] Section ${index}: other player stopped sending data. Aborting trade.`);
                                this.stopTrade = true;
                                throw new Error(`Section ${index} starved (fed ${iFeed}/${length})`);
                            }
                        }
                    }
                    const nextByte = await this.exchangeByte(byteToConsole);
                    buf.push(nextByte);
                    sendBufData[sendIndex % this.TOTAL_SEND_BUF_NEW_BYTES] = [posSend, nextByte, index, false, 0];
                    sendIndex++;
                    posSend++;
                    this.sendTradeData(this.createDataPacket(sendBufData, index));
                    lastTransfer = Date.now();
                    this.onProgress?.(index, posSend, length);
                    if (this.verbose && posSend % 50 === 0) {
                        this.log(`Sync Section ${index}: sent ${posSend}/${length}, fed ${iFeed}, received ${posRecv}`);
                    }
                }

                // Burst scheduling: a data-carrying transfer needs no pacing -
                // the USB round trip itself is the pacing, and buffered mode
                // proves the game streams section data at that rate. Sleep
                // only while waiting on network data or after a
                // filler/keep-alive exchange.
                if (!schedule || byteToConsole === this.NO_INPUT) {
                    await this.sleep(WAIT_POLL_MS);
                }
            }

            // Tail: Python feeds NO_DATA for the remaining offset slack
            while (iFeed < (length - bytesOffset) && !this.stopTrade) {
                const nextByte = await this.exchangeByte(this.NO_DATA);
                buf.push(nextByte);
                sendBufData[sendIndex % this.TOTAL_SEND_BUF_NEW_BYTES] = [posSend, nextByte, index, false, 0];
                sendIndex++;
                posSend++;
                this.sendTradeData(this.createDataPacket(sendBufData, index));
                iFeed++;
                await this.sleep(WAIT_POLL_MS);
            }

            // Python pads both buffers to the section length
            while (buf.length < length) buf.push(this.NO_DATA);
            while (otherBuf.length < length) otherBuf.push(this.NO_DATA);
        } else {
            // OLD protocol (7-byte packets, Python compat-3 mode) is strict
            // per-byte lockstep, matching Python synch_exchange_section_old.
            const RESEND_INTERVAL_MS = 300; // loss-recovery re-send while waiting
            let lastResend = 0;
            let i = 0;

            while (i < length && !this.stopTrade) {
                // Send our current bytes to peer (once per new position; the peer
                // pulls via GET if this packet is lost)
                const sendBuf = this.createDataPacket(sendBufData, index);
                this.sendTradeData(sendBuf);
                lastResend = Date.now();

                // Poll for peer's data until we have byte i
                let pollCount = 0;
                const MAX_POLL_COUNT = 1000; // 1000 * 10ms = 10 seconds max per position
                while (!(i in recvData) && !this.stopTrade && pollCount < MAX_POLL_COUNT) {
                    const recvBuf = await this.getTradeData();
                    if (recvBuf) {
                        Object.assign(recvData, this.getSwappableBytesOld(recvBuf, length, index));
                    }

                    if (!(i in recvData)) {
                        if (Date.now() - lastResend > RESEND_INTERVAL_MS) {
                            this.sendTradeData(sendBuf);
                            lastResend = Date.now();
                        }
                        await this.sleep(10);
                        pollCount++;
                    }
                }

                if (pollCount >= MAX_POLL_COUNT) {
                    // Python kills the trade on a desynced exchange; continuing with
                    // a truncated section previously let one side walk to the trade
                    // menu alone with corrupt data.
                    this.log(`[ERROR] Section ${index}: Timeout waiting for position ${i} from the other player. Aborting trade.`);
                    this.stopTrade = true;
                    throw new Error(`Section ${index} exchange timeout at position ${i}`);
                }

                if (i in recvData && i < length) {
                    const peerByte = recvData[i] & 0xFF;

                    // Python prevent_no_input semantics: the peer's GB sends its
                    // bytes raw; the receiver converts 0xFE (NO_INPUT control code)
                    // to 0xFF before feeding the GB.
                    const cleanByte = (peerByte === 0xFE) ? 0xFF : peerByte;

                    // Exchange with GB: send peer's byte, receive our next byte
                    const nextByte = await this.exchangeByte(cleanByte);
                    this.onProgress?.(index, i + 1, length);

                    const nextI = i + 1;

                    // Update our buffers
                    otherBuf.push(cleanByte);
                    buf.push(nextByte);  // Store original from GB

                    // OLD protocol slot: (nextI) & 1 matches ref impl send_buf[(next_i)&1]
                    sendBufData[nextI & 1] = [nextI, nextByte, index, false, 0];
                    sendIndex++;

                    if (this.verbose && (i < 10 || i % 50 === 0)) {
                        this.log(`Sync Section ${index} Byte ${i}: PeerSend=${cleanByte.toString(16)}, OurRecv=${nextByte.toString(16)}, nextI=${nextI}`);
                    }

                    i++;
                }
            }
        }

        // IMPORTANT: Send our current data immediately after main loop exits
        // This ensures ref impl receives the last position we added before we enter the handshake
        if (!this.stopTrade) {
            const preFinalBuf = this.createDataPacket(sendBufData, index);
            this.sendTradeData(preFinalBuf);
            if (this.verbose) this.log(`Sync Section ${index}: Sent pre-final packet after main loop`);
        }

        // Final handshake: loop is `while i < (length + 1)` so it waits for position 'length'
        // Both sides must send AND receive the completion marker before continuing
        if (!this.stopTrade) {
            // Add completion marker at position 'length' (e.g., 444 for Section 2)
            // Use the last byte we got from GB as the value for the completion marker
            const lastByte = buf.length > 0 ? buf[buf.length - 1] : 0;

            // For OLD protocol: Set BOTH slots to the completion marker
            // This ensures ref impl definitely sees position 'length' regardless of which slot it reads
            if (!this.useNewProtocol) {
                sendBufData[0] = [length, lastByte, index, false, 0];
                sendBufData[1] = [length, lastByte, index, false, 0];
            } else {
                const bufferSize = this.TOTAL_SEND_BUF_NEW_BYTES;
                const slotIndex = sendIndex % bufferSize;
                sendBufData[slotIndex] = [length, lastByte, index, false, 0];
            }

            this.log(`Sync Section ${index}: Sending completion marker (pos=${length})...`);

            // Wait for completion marker while sending ours
            let peerCompleted = false;
            let attempts = 0;
            const MAX_HANDSHAKE_ATTEMPTS = 200; // 200 * 50ms = 10 seconds max
            let lastMarkerSend = 0;

            while (!peerCompleted && !this.stopTrade && attempts < MAX_HANDSHAKE_ATTEMPTS) {
                // Send our completion marker (throttled; peer pulls via GET too)
                if (Date.now() - lastMarkerSend > 300) {
                    const finalSendBuf = this.createDataPacket(sendBufData, index);
                    this.sendTradeData(finalSendBuf);
                    lastMarkerSend = Date.now();
                }

                // Check for completion marker
                const recvBuf = await this.getTradeData();
                if (recvBuf) {
                    // Extract peer's positions - check if any position >= length
                    const peerPositions = this.useNewProtocol
                        ? this.getSwappableBytesNew(recvBuf, length + 1, index)  // Allow length as valid
                        : this.getSwappableBytesOld(recvBuf, length + 1, index); // Allow length as valid

                    // Check if peer sent completion (position >= length)
                    for (const posStr in peerPositions) {
                        const pos = parseInt(posStr);
                        if (pos >= length) {
                            peerCompleted = true;
                            this.log(`Sync Section ${index}: Received peer completion marker (pos=${pos})`);
                            break;
                        }
                    }
                }

                if (!peerCompleted) {
                    await this.sleep(50);
                    attempts++;
                }
            }

            if (!peerCompleted && !this.stopTrade) {
                // Advancing without the peer previously let one side reach the
                // trade menu alone; abort both sides cleanly instead.
                this.log(`[ERROR] Sync Section ${index}: Other player never confirmed completion. Aborting trade.`);
                this.stopTrade = true;
                throw new Error(`Section ${index} completion handshake timeout`);
            }
        }

        this.log(`Sync Exchange Section ${index}: Complete`);
        return [buf, otherBuf];
    }

    // ==================== BUFFERED MODE (ASYNC) ====================

    /**
     * Sends the entire trade data (Random + Party + Patch + Mail) in one FLL2 packet.
     */
    async sendBigTradingData(randomData, tradeData) {
        // Construct single byte array
        // Order: [Random(10), Party(0x1BC), Patch(0x1BC), Mail(0x1BC)]
        // NOTE: ref impl create_trading_data returns [random, party, mail]. 
        // But send_big_trading_data takes [random, party, data_mail, mail_data_other?].
        // Wait, send_big_trading_data just iterates the list it gets.
        // And buffered_trade calls: coms.send_big_trading_data(own_pokemon.create_trading_data())
        // create_trading_data returns [random, party, mail].
        // So the list has 3 elements?
        // Let's look at special_sections_len: [10, 444, 444, 444].
        // So we should send 3 or 4 sections?
        // Logic in gsc_trading.py: "send_data[3] = self.convert_mail_data(send_data[3], True)"
        // If create_trading_data returns 3 items, but special_sections_len has 4...
        // We need to match what ref impl expects.
        // get_big_trading_data splits by lengths.

        const totalSize = this.SPECIAL_SECTIONS_LEN.reduce((a, b) => a + b, 0);
        const fullData = new Uint8Array(totalSize);
        let offset = 0;

        // 1. Random Data (10 bytes)
        fullData.set(randomData, offset);
        offset += this.SPECIAL_SECTIONS_LEN[0];

        // 2. Party Data (0x1BC)
        fullData.set(tradeData.section1, offset);
        offset += this.SPECIAL_SECTIONS_LEN[1];

        // 3. Patch Data (0x1BC)
        fullData.set(tradeData.section2, offset);
        offset += this.SPECIAL_SECTIONS_LEN[2];

        // 4. Mail Data (0x1BC)
        // If we don't have it, fill with 0
        if (tradeData.section3) {
            fullData.set(tradeData.section3, offset);
        }

        this.log(`Sending FLL2 Data: ${fullData.length} bytes`);
        this.ws.sendData("FLL2", fullData);
    }

    async getBigTradingData() {
        this.log("Waiting for FLL2 (Full Trade Data)...");
        this.ws.sendGetData("FLL2");
        // The other player may not have sat down yet - wait at human timescale
        const data = await this.waitForMessage("FLL2", 300000);

        if (!data) return null;

        this.log(`Received FLL2 Data: ${data.length} bytes`);

        // Unpack
        const sections = [];
        let offset = 0;
        for (let len of this.SPECIAL_SECTIONS_LEN) {
            sections.push(data.slice(offset, offset + len));
            offset += len;
        }

        return sections;
    }

    /**
     * Unpack raw FLL2 data (Uint8Array) into sections array.
     */
    unpackFLL2(data) {
        const sections = [];
        let offset = 0;
        for (let len of this.SPECIAL_SECTIONS_LEN) {
            sections.push(data.slice(offset, offset + len));
            offset += len;
        }
        return sections;
    }

    // ==================== READ SECTION (HANDLES BOTH MODES) ====================

    async readSection(index, dataToSend, skipSync = false) {
        const length = this.SPECIAL_SECTIONS_LEN[index];

        // ==================== 1. BUFFERED MODE (ASYNC) ====================
        // Only use buffered mode if we HAVE the peer's data (Pass 2)
        // During ghost trade (Pass 1), we do normal exchange to collect our party
        const useBufferedRead = this.isBuffered && this.bufferedOtherData && this.bufferedOtherData[index];

        if (useBufferedRead) {

            this.log(`Buffered Read Section ${index}: Using local data from FLL2 buffer.`);
            const receivedData = new Uint8Array(length);
            const peerSectionData = this.bufferedOtherData[index];

            // In buffered mode, valid data is clean (no fillers/sync bytes).
            // We feed it to the GB byte-by-byte.

            // Initial Byte (GB sends something, we ignore/store it, and send peer's first byte)
            // ref impl 'read_section' logic for buffered:
            // It sends 'send_data[i]' to GB.

            // Start the loop. We need to wake it up?
            // "if buffered... buf = [next]" (where next is what GB sent).

            // Note: Buffered mode in ref impl handles preamble implicitly or explicitly?
            // `read_section`:
            // `if self.is_buffered: ...`
            // It does NOT do the preamble 0xFD loop if using the generic `read_section` implementation?
            // Wait, `read_section` calls `synch_synch_section` ONLY if `not buffered`.
            // But does it do Preamble?
            // Yes, preamble is generic (lines 1326-1335 in gsc_trading.py).
            // "while next != starter..." and "while next == starter..."
            // SO PREAMBLE MUST HAPPEN IN BUFFERED MODE TOO!

            // Let's implement Preamble for Buffered Mode too.
        }

        // ==================== SHARED PREAMBLE (Wake up GB) ====================

        // next_section = 0xFD, mail_next_section = 0x20
        const SECTION_STARTERS = [0xFD, 0xFD, 0xFD, 0x20]; // Sections 0-2 use 0xFD, Section 3 (Mail) uses 0x20
        const starter = SECTION_STARTERS[index] ?? 0xFD;

        // 1. Network Sync (Handshake) - SYNC MODE ONLY
        // Must happen BEFORE Preamble to match ref impl
        // IMPORTANT: skipSync=true means ref impl uses buffered=True internally for this section
        // (e.g., mail section when neither party has mail), so we skip the network handshake
        const useSyncForSection = this.isLinkTrade && !this.isBuffered && !skipSync &&
            (this.useNewProtocol ? index > 0 : true);


        if (useSyncForSection) {
            await this.synchSynchSection(index);
        }

        // 2. Preamble Stage 1: Wait for Starter (0xFD)
        // Python (gsc_trading.py read_section): synced sections clock the GB
        // with NO_INPUT while waiting — sending the starter early can release
        // the GB through its preamble before we are watching for it. Exchanges
        // are paced to the GB's per-frame cadence; hammering faster reads
        // NO_DATA between frames.
        const SPECIAL_SECTIONS_SYNC = [true, true, true, false];
        const PREAMBLE_PACING_MS = 20;
        const MAX_PREAMBLE_ITERATIONS = 1500; // * 20ms = 30s per stage
        const stage1Byte = SPECIAL_SECTIONS_SYNC[index] ? this.NO_INPUT : starter;
        // Python initializes recv = next (the stage-1 byte). For the mail
        // section that equals the starter, so stage 1 is SKIPPED entirely -
        // the game never echoes 0x20; the master simply starts sending it.
        // Waiting here for a 0x20 echo hangs every Gen 2 no-mail trade.
        let recv = stage1Byte;
        let preambleIterations = 0;

        while (recv !== starter && !this.stopTrade) {
            await this.sleep(PREAMBLE_PACING_MS);
            recv = await this.exchangeByte(stage1Byte);
            if (++preambleIterations > MAX_PREAMBLE_ITERATIONS) {
                this.log(`[ERROR] Section ${index}: Game Boy never presented the section starter`);
                this.stopTrade = true;
                throw new Error(`Section ${index} preamble timeout (stage 1)`);
            }
        }

        // 3. Preamble Stage 2: Sync with Device (Wait for Data Start)
        // NO_DATA (0x00) means "no fresh byte from the GB", never real data,
        // for the party and patch sections (their first byte is never 0) —
        // accepting it here previously desynced the two players at section 2.
        let next = starter;
        preambleIterations = 0;
        if (index === 0 && !useSyncForSection) {
            // Python counts the random section's preamble instead of scanning
            // for a non-starter byte: the first random byte can be 0xFD.
            for (let k = 0; k < this.SPECIAL_SECTIONS_PREAMBLE_LEN[0] + 1 && !this.stopTrade; k++) {
                await this.sleep(PREAMBLE_PACING_MS);
                next = await this.exchangeByte(starter);
                if (next !== starter) break;
            }
        } else {
            while ((next === starter ||
                    (next === this.NO_DATA && (index === 1 || index === 2))) && !this.stopTrade) {
                await this.sleep(PREAMBLE_PACING_MS);
                next = await this.exchangeByte(starter);
                if (++preambleIterations > MAX_PREAMBLE_ITERATIONS) {
                    this.log(`[ERROR] Section ${index}: Game Boy stuck in preamble`);
                    this.stopTrade = true;
                    throw new Error(`Section ${index} preamble timeout (stage 2)`);
                }
            }
        }

        // 'next' is the first byte (Byte 0) from the GB
        if (this.verbose) this.log(`Section ${index} Synced. First Byte Recv: ${next.toString(16)}`);

        // ==================== 2. DATA EXCHANGE ====================

        // A. BUFFERED MODE EXECUTION (Only when we have peer's data - Pass 2)
        if (useBufferedRead) {
            const receivedData = new Uint8Array(length);
            const peerSectionData = this.bufferedOtherData[index];

            receivedData[0] = next; // Store first byte from GB

            // Loop for the rest
            for (let i = 0; i < length - 1; i++) {
                // Send peer's byte (from our buffer) to GB.
                // 0xFE is the "no input" control code and never legal section
                // data - Python prevent_no_input escapes it to 0xFF.
                let sendByte = peerSectionData[i]; // Send Byte 0 now (for the NEXT exchange)
                if (sendByte === this.NO_INPUT) sendByte = 0xFF;
                const recvByte = await this.exchangeByte(sendByte);
                receivedData[i + 1] = recvByte;
                this.onProgress?.(index, i + 2, length);

                if (i < 10) {
                    this.log(`Buf Byte ${i}: Send=${sendByte.toString(16)}, Recv=${recvByte.toString(16)}`);
                }
            }
            return receivedData;
        }

        // B. SYNC MODE EXECUTION
        if (useSyncForSection) {
            const [gbData, peerData] = await this.synchExchangeSection(index, length, next);
            // gbData is what GB sent us.
            // peerData is what peer sent us via network (their GB's data).

            // Store peer sections: party for mail detection, patches/mail so the
            // subsequent-trade cache holds the peer's REAL data (Python keeps the
            // full other_pokemon, not a mirror of what we sent).
            if (index === 1 && peerData) {
                this.peerPartyData = new Uint8Array(peerData);
                if (this.verbose) this.log(`[DEBUG] Stored peer party data: ${this.peerPartyData.length} bytes`);
            } else if (index === 2 && peerData) {
                this.peerPatchData = new Uint8Array(peerData);
            } else if (index === 3 && peerData) {
                this.peerMailData = new Uint8Array(peerData);
            }

            const data = new Uint8Array(gbData);
            return data;
        }


        // C. POOL / SIMPLE MODE EXECUTION
        const receivedData = new Uint8Array(length);
        receivedData[0] = next;

        for (let i = 0; i < length - 1; i++) {
            let val = 0x00;
            if (dataToSend && i < dataToSend.length) {
                val = dataToSend[i]; // Send byte i (starts at 0)
                // Python prevent_no_input: 0xFE is never legal device-bound data
                if (val === this.NO_INPUT) val = 0xFF;
            }

            const recvByte = await this.exchangeByte(val);
            receivedData[i + 1] = recvByte;
            this.onProgress?.(index, i + 2, length);
        }


        // This is critical - without it GB receives incomplete data!
        if (dataToSend && dataToSend.length >= length) {
            let lastVal = dataToSend[length - 1];
            if (lastVal === this.NO_INPUT) lastVal = 0xFF;
            await this.exchangeByte(lastVal);
        } else {
            await this.exchangeByte(0x00);
        }

        return receivedData;
    }

    async waitForMessage(type, timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        let lastGet = 0;
        while (!this.stopTrade) {
            const data = this.ws.recvDict[type];
            if (data) {
                delete this.ws.recvDict[type]; // consume-once, like Python's pop
                return data;
            }
            if (Date.now() >= deadline) {
                this.log(`[WARN] Timed out waiting for ${type}`);
                return null;
            }
            // Re-request periodically in case the original GET or push was lost
            if (Date.now() - lastGet > 500) {
                this.ws.sendGetData(type);
                lastGet = Date.now();
            }
            await this.sleep(100);
        }
        return null;
    }

    /**
     * Send a GET request and wait for server response.
     * Returns the data payload from the server.
     */
    async getServerData(type) {
        return new Promise((resolve, reject) => {
            // Set up listener before sending GET
            this.ws.registerListener(type, (data) => {
                resolve(data);
            });

            // Send GET request
            this.ws.sendGetData(type);

            // Timeout after 5 seconds
            setTimeout(() => {
                resolve(null);
            }, 5000);
        });
    }

    startVEC2Flood() {
        if (this.vec2FloodInterval) return;
        if (this.verbose) this.log(`Starting VEC Flood (${this.MSG_VEC}) to ensure ref impl sees Version...`);
        const versionData = new Uint8Array([4, 0, 0, 0, 0, 0]);
        const msgTag = this.MSG_VEC; // Capture for closure
        this.vec2FloodInterval = setInterval(() => {
            if (this.ws && this.ws.isConnected) {
                this.ws.sendData(msgTag, versionData);
            }
        }, 200);
    }

    stopVEC2Flood() {
        if (this.vec2FloodInterval) {
            clearInterval(this.vec2FloodInterval);
            this.vec2FloodInterval = null;
            if (this.verbose) this.log("Stopped VEC2 Flood.");
        }
    }
}

