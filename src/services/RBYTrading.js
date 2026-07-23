/**
 * RBYTrading.js - Gen 1 (Red/Blue/Yellow) Trading Protocol
 * Extends GSCTrading with RBY-specific constants and logic.
 * 
 * Key differences from GSC:
 * - 3 sections instead of 4 (no mail)
 * - Different byte values (0x60-0x6F range for indexes)
 * - Smaller Pokemon data (44 bytes vs 48)
 * - No eggs, no mail
 */

import { GSCTrading } from './GSCTrading.js';
import { RBYUtils } from './RBYUtils.js';
import { RBYTradingData, RBYChecks } from './RBYTradingDataUtils.js';

export class RBYTrading extends GSCTrading {
    constructor(usb, ws, logger, tradeType = 'pool', isBuffered = false, doSanityChecks = true, options = {}) {
        super(usb, ws, logger, tradeType, isBuffered, doSanityChecks, options);

        // Override Gen 2 specific features - disable for Gen 1
        this.convertToEggs = false;  // No eggs in Gen 1
        this.isJapanese = options.isJapanese ?? false;  // JP versions exist but simpler

        // No mail converter needed for Gen 1
        this.jpMailConverter = null;

        // ==================== RBY BYTE CONSTANTS ====================
        // Override GSC constants with RBY values

        // Enter room state machine (different bytes for Gen 1)
        this.ENTER_ROOM_STATES = [
            [0x01, 0x60, 0xD0, 0xD4],
            [
                new Set([0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x6F]),
                new Set([0xD0, 0xD1, 0xD2, 0xD3, 0xD4]),
                new Set([0xD0, 0xD1, 0xD2, 0xD3, 0xD4]),
                new Set([0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x6F])
            ]
        ];

        // Start trading states (sit at table)
        this.START_TRADING_STATES = [
            [0x60, 0x60],
            [
                new Set([0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x6F]),
                new Set([0xFD])
            ]
        ];

        // Section lengths: [Random, Pokemon, Patches] - NO MAIL
        // IMPORTANT: Must override SPECIAL_SECTIONS_LEN as that's what readSection() uses
        this.SECTION_LENGTHS = [0x0A, 0x1A2, 0xC5];
        this.SPECIAL_SECTIONS_LEN = [0x0A, 0x1A2, 0xC5];
        this.SECTION_PREAMBLE_LEN = [7, 6, 3];
        this.SPECIAL_SECTIONS_PREAMBLE_LEN = [7, 6, 3]; // Also override this for consistency

        // Trade menu byte values (0x60 range vs 0x70 range)
        this.STOP_TRADE = 0x6F;
        this.FIRST_TRADE_INDEX = 0x60;
        this.ACCEPT_TRADE = 0x62;
        this.DECLINE_TRADE = 0x61;

        // Success values
        this.SUCCESS_BASE_VALUE = 0x60;
        this.SUCCESS_VALUES = new Set();
        for (let i = 0x60; i < 0x70; i++) {
            this.SUCCESS_VALUES.add(i);
        }

        // Possible selection indexes
        this.POSSIBLE_INDEXES = new Set();
        for (let i = 0x60; i < 0x70; i++) {
            this.POSSIBLE_INDEXES.add(i);
        }

        // Section transition bytes (same as GSC)
        this.NEXT_SECTION = 0xFD;
        this.NO_INPUT = 0xFE;
        this.NO_INPUT_ALTERNATIVE = 0xFF; // Used to replace 0xFE in data to avoid protocol confusion

        // Special Pokemon (Gen 1 legendary birds)
        this.SPECIAL_MONS = new Set([73, 74, 75]); // Moltres, Articuno, Zapdos

        // Override checks with RBY-specific checks
        this.checks = new RBYChecks(this.SECTION_LENGTHS, doSanityChecks);

        // No mail item IDs in Gen 1
        this.MAIL_ITEM_IDS = new Set(); // Empty set

        // ==================== JP FILLER SUPPORT ====================
        // Japanese Gen 1 names are 6 characters (vs 11 for International)
        // Need to pad with 0x50 (END_OF_LINE) to match INT format
        this.END_OF_LINE = 0x50;
        this.SINGLE_TEXT_LEN = 0x0B;           // 11 bytes
        this.END_OF_PLAYER_NAME_POS = 6;       // Position where player name ends in JP
        this.END_OF_RBY_DATA_POS = 0x121;      // Position where OT names start in section 1
        this.PLAYER_NAME_LEN_DIFF = 5;         // 11 - 6 = 5 bytes difference
        this.POKEMON_NAME_LEN_DIFF = 5;        // Same for Pokemon nicknames

        // JP Fillers: positions in section data where padding is needed
        // Format: { position: [fillLength, fillByte] }
        // Section 0: no fillers
        // Section 1: player name + 6 OT names + 6 nicknames
        // Section 2: no fillers (patches)
        if (this.isJapanese) {
            this.JP_FILLERS = [
                {}, // Section 0: Random - no fillers
                {   // Section 1: Pokemon data
                    // Player name at position 6
                    [this.END_OF_PLAYER_NAME_POS]: [this.PLAYER_NAME_LEN_DIFF, this.END_OF_LINE],
                    // 6 OT names (each 11 bytes apart starting at 0x121)
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 0)]: [this.PLAYER_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 1)]: [this.PLAYER_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 2)]: [this.PLAYER_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 3)]: [this.PLAYER_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 4)]: [this.PLAYER_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 5)]: [this.PLAYER_NAME_LEN_DIFF, this.END_OF_LINE],
                    // 6 Nicknames (following OT names)
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 6)]: [this.POKEMON_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 7)]: [this.POKEMON_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 8)]: [this.POKEMON_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 9)]: [this.POKEMON_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 10)]: [this.POKEMON_NAME_LEN_DIFF, this.END_OF_LINE],
                    [this.END_OF_RBY_DATA_POS + (this.SINGLE_TEXT_LEN * 11)]: [this.POKEMON_NAME_LEN_DIFF, this.END_OF_LINE]
                },
                {}  // Section 2: Patches - no fillers
            ];
            this.log("[RBY-JP] Japanese mode enabled with text fillers");
        } else {
            this.JP_FILLERS = [{}, {}, {}]; // No fillers for INT versions
        }
    }

    // ==================== START TRADE OVERRIDE ====================
    // Must override to use RBY message tags (BUF1, VEC1, etc.) instead of GSC's hardcoded BUF2/VEC2

    async startTrade() {
        this.log(`Starting RBY Trade Protocol (${this.tradeType} mode, ${this.isBuffered ? 'buffered' : 'sync'})...`);

        // Load base.bin template for proper trading data structure
        // ref impl uses this pre-baked template to ensure correct party format
        if (!RBYUtils.basePoolData) {
            this.log("[RBY] Loading base.bin template...");
            const loaded = await RBYUtils.loadBasePoolData();
            if (!loaded) {
                this.log("[RBY] WARNING: Failed to load base.bin, using manual construction!");
            }
        }

        // Load default party data for ghost trades in buffered mode
        // IMPORTANT: Always load for link trades even if initially sync mode,
        // because negotiation may switch us to buffered mode later.
        if (this.isLinkTrade && !RBYUtils.defaultPartyData) {
            this.log("[RBY] Loading default party data for ghost trades...");
            await RBYUtils.loadDefaultPartyData();
        }

        // Initialize blank trade flags
        this.ownBlankTrade = true;
        this.otherBlankTrade = true;

        // Pre-populate BUF1 response for negotiator (if link trade)
        if (this.ownCounterId === undefined) {
            this.ownCounterId = Math.floor(Math.random() * 256);
        }
        const ourMode = this.isBuffered ? 0x85 : 0x12;
        const bufPacket = new Uint8Array([this.ownCounterId, ourMode]);
        this.ws.sendDict[this.MSG_BUF] = bufPacket;
        this.log(`Pre-populated ${this.MSG_BUF} for negotiator: ${this.isBuffered ? 'Buffered' : 'Sync'} [Counter: ${this.ownCounterId}]`);

        // Enter room FIRST
        await this.enterRoom();
        this.log("Entered Room.");

        // For link trades: Start BUF1 negotiation immediately after enter_room
        let negotiationPromise = null;
        if (this.isLinkTrade && !this.initialNegotiationDone) {
            if (this.ownCounterId === undefined) {
                this.ownCounterId = Math.floor(Math.random() * 256);
            }
            const bufPacket = new Uint8Array([this.ownCounterId, ourMode]);
            this.ws.sendData(this.MSG_BUF, bufPacket);
            this.log(`Sent ${this.MSG_BUF} early: ${this.isBuffered ? 'Buffered (0x85)' : 'Sync (0x12)'} [Counter: ${this.ownCounterId}]`);
            this.ownCounterId = (this.ownCounterId + 1) % 256;

            this.log("Starting background negotiation...");
            negotiationPromise = (async () => {
                await this.waitForPeer();
                await this.completeBufferedNegotiation();
                this.initialNegotiationDone = true;
                return this.isBuffered;
            })();
        }

        // Main trading loop
        while (!this.stopTrade) {
            if (this.verbose) this.log(`[DEBUG] RBY startTrade loop. ownBlankTrade=${this.ownBlankTrade}, otherBlankTrade=${this.otherBlankTrade}`);
            try {
                // Start VEC1 flood for version exchange
                this.startVEC2Flood(); // Uses MSG_VEC getter internally

                // Sit at table
                await this.sitToTable();

                // Stop VEC1 flood
                this.stopVEC2Flood();

                // Wait for negotiation to complete if link trade
                if (negotiationPromise) {
                    this.log("Waiting for negotiation to complete...");
                    await negotiationPromise;
                    negotiationPromise = null;
                }

                // === PROTOCOL LOGIC: Different behavior for first vs subsequent trades ===
                // Match GSCTrading: use cached path if bufferedOtherData exists
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

                // Trade menu - all the real trading action
                await this.tradeMenuLoop();

            } catch (error) {
                this.log(`RBY Trade error: ${error}`);
                if (error.message?.includes('stop') || this.stopTrade) {
                    break;
                }
                await this.sleep(1000);
            }
        }

        this.log("RBY Trade ended.");
    }

    // ==================== MESSAGE TAG OVERRIDES ====================
    // Gen 1 uses different message tags (ending in 1 instead of 2)

    get MSG_FLL() { return "FLL1"; }
    get MSG_SNG() { return "SNG1"; }
    get MSG_POL() { return "POL1"; }
    get MSG_MVS() { return "MVS1"; }
    get MSG_CHC() { return "CHC1"; }
    get MSG_ACP() { return "ACP1"; }
    get MSG_SUC() { return "SUC1"; }
    get MSG_BUF() { return "BUF1"; }
    get MSG_NEG() { return "NEG1"; }
    get MSG_VEC() { return "VEC1"; }
    get MSG_VES() { return "VES1"; }
    get MSG_RAN() { return "RAN1"; }
    get MSG_ASK() { return "ASK1"; }

    // ==================== OVERRIDE METHODS ====================

    /**
     * Override enterRoom to handle Set objects in ENTER_ROOM_STATES
     * Simplified to match send_predefined_section - just loop and retry
     */
    async enterRoom() {
        this.log("RBY: Entering room...");
        let stateIndex = 0;
        let retryCount = 0;
        let readFailures = 0;

        while (stateIndex < this.ENTER_ROOM_STATES[0].length && !this.stopTrade) {
            const nextByte = this.ENTER_ROOM_STATES[0][stateIndex];
            await this.usb.writeByte(nextByte);

            let recv;
            try {
                recv = await this.usb.readByte();
                readFailures = 0;
            } catch (e) {
                recv = this.failedRead(e, ++readFailures);
            }

            const expectedStates = this.ENTER_ROOM_STATES[1][stateIndex];
            let matched = false;
            if (expectedStates instanceof Set) {
                matched = expectedStates.has(recv);
            } else if (Array.isArray(expectedStates)) {
                matched = expectedStates.includes(recv);
            } else {
                matched = (recv === expectedStates);
            }

            if (matched) {
                stateIndex++;
                retryCount = 0;
                if (this.verbose) this.log(`RBY State advanced to ${stateIndex}. Recv: ${recv.toString(16)}`);
            } else {
                retryCount++;
                if (this.verbose && retryCount % 50 === 0) {
                    this.log(`RBY: Waiting for sync... State: ${stateIndex}, Recv: ${recv.toString(16)}`);
                }
            }

            // Reduced sleep to 1ms - 15ms was likely too slow for handshake
            await this.sleep(1);
        }

        this.log("RBY: Entered Room!");
        return true;
    }

    /**
     * Override sitToTable to handle Set objects in START_TRADING_STATES
     * Gen 1 uses different byte ranges (0x60s) than Gen 2 (0x70s)
     * Simplified to match logic and handle 0xFE
     */
    async sitToTable() {
        this.log("RBY: Sitting at table...");
        if (this.verbose) this.log(`RBY: START_TRADING_STATES = ${JSON.stringify(this.START_TRADING_STATES[0])}`);
        let stateIndex = 0;
        let retryCount = 0;
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
            if (expectedStates instanceof Set) {
                matched = expectedStates.has(recv);
            } else if (Array.isArray(expectedStates)) {
                matched = expectedStates.includes(recv);
            } else {
                matched = (recv === expectedStates);
            }

            if (matched) {
                stateIndex++;
                retryCount = 0;
                if (this.verbose) this.log(`RBY Sit State ${stateIndex}/${this.START_TRADING_STATES[0].length}: Sent=0x${nextByte.toString(16).padStart(2, '0')}, Recv=0x${recv.toString(16).padStart(2, '0')} ✓`);
            } else {
                retryCount++;
                if (this.verbose && (retryCount % 100 === 0 || retryCount < 5)) {
                    this.log(`RBY sitToTable: State=${stateIndex}, Sent=0x${nextByte.toString(16).padStart(2, '0')}, Recv=0x${recv.toString(16).padStart(2, '0')} (expected: ${[...expectedStates].map(x => '0x' + x.toString(16)).join(',')})`);
                }

                // Handle No Data (0x00) OR No Input (0xFE) - just keep trying
                // DO NOT reset stateIndex - Python reference never resets once advanced
            }
            await this.sleep(1);
        }
        this.log("RBY: Sat at table!");
    }

    /**
     * Check if party has mail - always false for Gen 1
     */
    partyHasMail(partyData) {
        return false;
    }

    /**
     * Override waitForAcceptDecline to use RBY byte values
     * RBY: ACCEPT=0x62, DECLINE=0x61 (vs GSC: 0x72, 0x71)
     */
    async waitForAcceptDecline(initialValue) {
        const validSet = new Set([this.ACCEPT_TRADE, this.DECLINE_TRADE]); // 0x62, 0x61
        if (this.verbose) this.log(`[DEBUG] RBY waitForAcceptDecline: looking for 0x${this.ACCEPT_TRADE.toString(16)} or 0x${this.DECLINE_TRADE.toString(16)}`);
        return await this.waitForChoice(initialValue, validSet);
    }

    /**
     * Trade starting sequence - simplified for Gen 1 (3 sections, no mail)
     */
    async tradeStartingSequence() {
        this.log("RBY Trade: Starting sequence (3 sections, no mail)...");

        // 1. Version Exchange
        if (this.verbose) this.log("Exchanging Versions...");
        await this.sleep(100);

        this.useNewProtocol = false;
        const versionData = new Uint8Array([4, 0, 0, 0, 0, 0]);
        this.ws.sendData(this.MSG_VEC, versionData);

        await this.sleep(100);
        this.ws.sendGetData(this.MSG_VES);
        const serverVersion = await this.waitForMessage(this.MSG_VES);
        if (this.verbose) this.log(`Server Version: ${serverVersion}`);

        // Check for peer version in link trade
        if (this.isLinkTrade) {
            await this.sleep(2000);
            const peerVersion = this.ws.recvDict[this.MSG_VEC];
            if (peerVersion && peerVersion.length > 0) {
                this.useNewProtocol = true;
                this.log("Peer supports NEW protocol");
            } else {
                this.useNewProtocol = false;
                this.log("Using OLD protocol for compatibility");
            }
        }

        // 2. Random Data
        if (this.verbose) this.log("Getting Random Data...");
        this.ws.sendGetData(this.MSG_RAN);
        const randomData = await this.waitForMessage(this.MSG_RAN);
        if (!randomData) {
            this.log("[ERROR] Server never sent random data. Aborting trade.");
            this.stopTrade = true;
            return;
        }
        if (this.verbose) this.log(`Random Data received: ${randomData.length} bytes`);

        let tradeData;
        let isGhostTrade = false;

        if (this.isLinkTrade) {
            this.log("RBY Link Trade: Skipping POL1 - will exchange data with other player");

            if (this.isBuffered) {
                if (!this.bufferedOtherData) {
                    isGhostTrade = true;
                    this.log("Buffered Mode: Pass 1 (Ghost Trade) - Collecting our party data...");
                    tradeData = RBYUtils.createDefaultTradingData();
                } else {
                    this.log("Buffered Mode: Using cached peer party data...");
                    tradeData = {
                        section1: this.bufferedOtherData[1],
                        section2: this.bufferedOtherData[2]
                    };
                }
            } else {
                tradeData = RBYUtils.createDefaultTradingData();
            }
        } else {
            // Pool trade: Get Pokemon from pool
            if (this.verbose) this.log("Getting Pool Data (POL1)...");
            this.ws.sendGetData(this.MSG_POL);
            const poolData = await this.waitForMessage(this.MSG_POL);

            // Python kills the trade on the pool-failure reply
            // ([counter, fail_value], length 2) instead of fabricating a mon.
            if (!poolData || poolData.length <= 2) {
                this.log("[ERROR] Pool unavailable (empty pool or server failure). Aborting trade.");
                this.stopTrade = true;
                return;
            }
            if (this.verbose) this.log(`Pool Data received: ${poolData.length} bytes`);

            // Create trading data from pool (no egg conversion in Gen 1)
            tradeData = RBYUtils.createTradingData(poolData.slice(1));

            // Set trader name to "POOL" for pool trades
            const poolName = RBYUtils.textToBytes("POOL");
            for (let i = 0; i < poolName.length; i++) {
                tradeData.section1[RBYUtils.trader_name_pos + i] = poolName[i];
            }

            // Cap Pokemon level to maxLevel setting (matches Python reference)
            this.capPoolPokemonLevel(tradeData.section1, RBYUtils);
        }

        // 3. Execute Sections (only 3 for RBY)
        // Section 0: Random Data
        await this.readSection(0, randomData);

        // Section 1: Pokemon Data
        if (this.verbose) this.log("Sending Section 1 (Pokemon Data)...");
        this.gbPartyData = await this.readSection(1, tradeData.section1);

        // Section 2: Patches
        if (this.verbose) this.log("Sending Section 2 (Patches)...");
        const gbPatchData = await this.readSection(2, tradeData.section2);

        // NO Section 3 (Mail) in Gen 1!

        // Apply patches
        RBYUtils.applyPatches(this.gbPartyData, gbPatchData, false);

        // Cache peer sections for subsequent trades.
        // The party is cached DECODED (peer's patches applied) so trade-menu
        // edits (MVS1, updatePeerPartyAfterTrade) happen on real bytes; the
        // wire patch section is regenerated at reuse time. Previously this
        // cached the un-patched party plus OUR OWN patch section.
        if (!this.isBuffered && this.peerPartyData) {
            const peerParty = new Uint8Array(this.peerPartyData);
            if (this.peerPatchData) {
                RBYUtils.applyPatches(peerParty, this.peerPatchData, false);
            }
            this.cachedPeerPartyDecoded = !!this.peerPatchData;
            this.bufferedOtherData = [
                randomData,
                peerParty,
                this.peerPatchData ? new Uint8Array(this.peerPatchData) : tradeData.section2
                // No mail section
            ];
            if (this.verbose) this.log("[DEBUG] Cached peer sections for subsequent trades (RBY - no mail)");
        }

        // Buffered mode: exchange FLL1
        if (this.isBuffered && this.isLinkTrade && isGhostTrade) {
            this.log("Buffered Mode: Sending our party data via FLL1...");

            const ourTradeData = {
                section1: this.gbPartyData,
                section2: gbPatchData
            };
            await this.sendBigTradingDataRBY(randomData, ourTradeData);

            this.log("Waiting for peer's FLL1...");
            const peerSections = await this.getBigTradingDataRBY();
            if (peerSections) {
                this.peerPartyData = peerSections[1];
                this.bufferedOtherData = peerSections;
                this.cachedPeerPartyDecoded = false; // FLL data is raw wire form
                this.log("Received peer's FLL1 data!");
            }
        }

        this.log("RBY Trade: Starting sequence complete!");
    }

    /**
     * RBY override: Subsequent trade sequence using cached peer data.
     * Skips full section exchange, just exchanges sections with GB using cached data.
     * Also handles MVS1 receive/send for move updates.
     */
    async subsequentTradeSequence() {
        if (this.verbose) this.log(`[DEBUG] RBY subsequentTradeSequence: Starting. ownCounterId=${this.ownCounterId}, peerCounterId=${this.peerCounterId}`);
        if (this.verbose) this.log(`[DEBUG] RBY subsequentTradeSequence: ownBlankTrade=${this.ownBlankTrade}, otherBlankTrade=${this.otherBlankTrade}`);

        // Clear stale cached messages from previous trade
        delete this.ws.recvDict[this.MSG_CHC];
        delete this.ws.recvDict[this.MSG_ACP];
        delete this.ws.recvDict[this.MSG_ASK];
        delete this.ws.recvDict[this.MSG_SUC];
        delete this.ws.recvDict[this.MSG_MVS];
        delete this.ws.recvDict[this.MSG_SNG];
        if (this.verbose) this.log("[DEBUG] Cleared stale cached messages for subsequent trade");

        if (!this.isLinkTrade) {
            // Pool trade doesn't support re-entry, just do full sequence
            await this.tradeStartingSequence();
            return;
        }

        // MVS logic for subsequent trades
        const isReEntryWithCachedData = this.ownBlankTrade && this.otherBlankTrade;

        if (isReEntryWithCachedData) {
            // Re-entry after STOP_TRADE: skip MVS exchange
            this.log("Re-entry with cached data: Skipping MVS exchange");
        } else {
            // Normal subsequent trade: conditionally receive MVS
            if (this.otherBlankTrade) {
                // Peer received a special mon (from me) -> peer sends me updated moves
                this.log(`Receiving peer's ${this.MSG_MVS} (move data) before sections...`);
                await this.receiveMVS2(); // Uses this.MSG_MVS internally
            } else {
                // Increment counter if not receiving (to match ref impl)
                if (this.peerCounterId !== null) {
                    this.peerCounterId = (this.peerCounterId + 1) % 256;
                    if (this.verbose) this.log(`[DEBUG] Incremented peerCounterId to ${this.peerCounterId} (not receiving MVS)`);
                }
            }
        }

        // Reuse cached peer data for section exchange
        if (!this.bufferedOtherData) {
            this.log("[WARN] No cached peer data for subsequent trade - falling back to full sequence");
            await this.tradeStartingSequence();
            return;
        }

        this.log("Using cached peer party data for trade...");
        let sendParty = this.bufferedOtherData[1];
        let sendPatches = this.bufferedOtherData[2];
        if (this.cachedPeerPartyDecoded) {
            // Re-escape 0xFE bytes and rebuild the patch section from the
            // decoded cached party (createPatchesData edits the clone in place).
            sendParty = new Uint8Array(this.bufferedOtherData[1]);
            sendPatches = new Uint8Array(this.bufferedOtherData[2]);
            RBYUtils.createPatchesData(sendParty, sendPatches, false);
        }
        const tradeData = {
            section1: sendParty,
            section2: sendPatches
            // RBY has NO section3 (mail)
        };

        // Get fresh random data from server
        this.ws.sendGetData(this.MSG_RAN);
        const randomData = await this.waitForMessage(this.MSG_RAN);
        if (this.verbose) this.log(`Random Data received: ${randomData.length} bytes`);

        // Exchange sections with GB using cached peer data (skipSync mode)
        const skipSync = true;
        await this.readSection(0, randomData, skipSync);
        this.gbPartyData = await this.readSection(1, tradeData.section1, skipSync);
        const gbPatchData = await this.readSection(2, tradeData.section2, skipSync);

        // Apply patches
        RBYUtils.applyPatches(this.gbPartyData, gbPatchData, false);

        // ALWAYS send MVS after section exchange (unconditional, per ref impl)
        this.log(`Sending ${this.MSG_MVS} (move data) to peer...`);
        await this.sendMVS2(); // Uses this.MSG_MVS internally

        // Reset blank trade flags before entering trade menu
        this.ownBlankTrade = true;
        this.otherBlankTrade = true;
        if (this.verbose) this.log("[DEBUG] Reset blank trade flags to true before entering trade menu");

        this.log("RBY Trade: Subsequent sequence complete!");
    }

    /**
     * RBY override: Send MVS1 (move data only) to peer.
     * Uses Gen1 offsets: moves at offset 8, PP at offset 0x1D.
     */
    async sendMVS2() {
        if (this.verbose) this.log(`[DEBUG] RBY sendMVS1: Starting. ownCounterId=${this.ownCounterId}`);

        if (!this.gbPartyData) {
            this.log("[WARN] RBY sendMVS1: No GB party data - cannot send MVS1");
            this.ownCounterId = (this.ownCounterId + 1) % 256;
            return;
        }

        // Get party size and find last Pokemon
        const partySize = this.gbPartyData[RBYUtils.trading_party_info_pos];
        const lastIndex = partySize - 1;
        if (this.verbose) this.log(`[DEBUG] RBY sendMVS1: Party size=${partySize}, lastIndex=${lastIndex}`);

        // Extract species, moves and PP from last Pokemon's core data (RBY offsets)
        const coreStart = RBYUtils.trading_pokemon_pos + (lastIndex * RBYUtils.trading_pokemon_length);

        // Python RBY send_move_data_only payload: [species, moves*4, pp*4]
        const moveData = new Uint8Array(9);
        moveData[0] = this.gbPartyData[coreStart];
        // RBY: Moves are at offset 8 in core data
        for (let j = 0; j < 4; j++) {
            moveData[1 + j] = this.gbPartyData[coreStart + RBYUtils.moves_pos + j];
        }
        // RBY: PP is at offset 0x1D (29) in core data
        for (let j = 0; j < 4; j++) {
            moveData[5 + j] = this.gbPartyData[coreStart + RBYUtils.pps_pos + j];
        }

        // Create MVS1 payload: [counter] + [species] + [8 bytes move/PP data]
        const mvsPayload = new Uint8Array(10);
        mvsPayload[0] = this.ownCounterId;
        mvsPayload.set(moveData, 1);

        this.ws.sendData(this.MSG_MVS, mvsPayload);
        this.log(`Sent ${this.MSG_MVS} (Counter: ${this.ownCounterId}): species=${moveData[0]} moves=[${moveData.slice(1, 5).join(',')}] pp=[${moveData.slice(5, 9).join(',')}]`);

        this.ownCounterId = (this.ownCounterId + 1) % 256;
    }

    /**
     * RBY override: Receive MVS1 (move data only) from peer.
     * Updates last Pokemon in peer's party with new moves/PP using Gen1 offsets.
     */
    async receiveMVS2() {
        // Clear any stale MVS1 data first
        delete this.ws.recvDict[this.MSG_MVS];

        if (this.verbose) this.log(`[DEBUG] RBY receiveMVS1: Starting. Expected peerCounterId=${this.peerCounterId}`);

        this.ws.sendGetData(this.MSG_MVS);

        const maxRetries = 500;
        for (let i = 0; i < maxRetries && !this.stopTrade; i++) {
            const mvsData = this.ws.recvDict[this.MSG_MVS];
            if (mvsData && mvsData.length >= 10) {
                const counter = mvsData[0];

                if (this.peerCounterId === null) {
                    this.peerCounterId = counter;
                } else if (counter !== this.peerCounterId) {
                    const diff = (counter - this.peerCounterId + 256) % 256;
                    if (diff <= 2) {
                        this.peerCounterId = counter;
                    } else {
                        delete this.ws.recvDict[this.MSG_MVS];
                        this.ws.sendGetData(this.MSG_MVS);
                        await this.sleep(100);
                        continue;
                    }
                }

                // Python RBY payload: [counter, species, moves*4, pp*4]
                const species = mvsData[1];
                const moveData = mvsData.slice(2, 10);
                this.log(`Received ${this.MSG_MVS} (Counter: ${counter}): species=${species} moves=[${moveData.slice(0, 4).join(',')}] pp=[${moveData.slice(4, 8).join(',')}]`);

                this.peerCounterId = (this.peerCounterId + 1) % 256;

                // Update last Pokemon in peer's buffered party (RBY offsets)
                if (this.bufferedOtherData && this.bufferedOtherData[1]) {
                    const peerParty = this.bufferedOtherData[1];
                    const partySize = peerParty[RBYUtils.trading_party_info_pos];
                    const lastIndex = partySize - 1;

                    const coreStart = RBYUtils.trading_pokemon_pos + (lastIndex * RBYUtils.trading_pokemon_length);

                    // RBY: Moves at offset 8
                    for (let j = 0; j < 4; j++) {
                        peerParty[coreStart + RBYUtils.moves_pos + j] = moveData[j];
                    }
                    // RBY: PP at offset 0x1D
                    for (let j = 0; j < 4; j++) {
                        peerParty[coreStart + RBYUtils.pps_pos + j] = moveData[4 + j];
                    }
                    // Trade evolution: update species in the struct and the
                    // party list (Python evolution_procedure; the receiving
                    // game recalculates stats itself).
                    if (species !== 0 && species !== peerParty[coreStart]) {
                        peerParty[coreStart] = species;
                        peerParty[RBYUtils.trading_party_info_pos + 1 + lastIndex] = species;
                        this.log(`Peer's last Pokemon evolved (species ${species})`);
                    }

                    this.log(`Updated peer's last Pokemon (slot ${lastIndex}) with new moves/PP`);
                }

                delete this.ws.recvDict[this.MSG_MVS];
                return true;
            }

            await this.sleep(100);
            this.ws.sendGetData(this.MSG_MVS);
        }

        this.log(`[WARN] Timeout waiting for ${this.MSG_MVS}`);
        if (this.peerCounterId !== null) {
            this.peerCounterId = (this.peerCounterId + 1) % 256;
        }
        return false;
    }

    /**
     * Extract single Pokemon for CHC1 (RBY format - smaller size)
     */
    extractSinglePokemon(choiceByte) {
        const slotIndex = choiceByte - this.FIRST_TRADE_INDEX;

        if (slotIndex < 0 || slotIndex > 5 || !this.gbPartyData) {
            this.log(`Invalid slot index: ${slotIndex}`);
            return new Uint8Array([choiceByte, 0]);
        }

        // RBY single Pokemon format:
        // [choice] + [pokemon data 44 bytes] + [OT 11 bytes] + [nickname 11 bytes]
        // Total: 1 + 44 + 11 + 11 = 67 bytes
        const POKEMON_DATA_LEN = 0x2C;  // 44 bytes
        const NAME_LEN = 0x0B;          // 11 bytes
        const RESULT_LEN = 1 + POKEMON_DATA_LEN + NAME_LEN + NAME_LEN; // 67 bytes

        const result = new Uint8Array(RESULT_LEN);
        result[0] = choiceByte;

        // Copy Pokemon data (44 bytes)
        const pokemonStart = RBYUtils.trading_pokemon_pos + slotIndex * POKEMON_DATA_LEN;
        for (let i = 0; i < POKEMON_DATA_LEN; i++) {
            result[1 + i] = this.gbPartyData[pokemonStart + i] ?? 0;
        }

        // Copy OT name (11 bytes)
        const otStart = RBYUtils.trading_pokemon_ot_pos + slotIndex * NAME_LEN;
        for (let i = 0; i < NAME_LEN; i++) {
            result[1 + POKEMON_DATA_LEN + i] = this.gbPartyData[otStart + i] ?? 0;
        }

        // Copy Nickname (11 bytes)
        const nickStart = RBYUtils.trading_pokemon_nickname_pos + slotIndex * NAME_LEN;
        for (let i = 0; i < NAME_LEN; i++) {
            result[1 + POKEMON_DATA_LEN + NAME_LEN + i] = this.gbPartyData[nickStart + i] ?? 0;
        }

        return result;
    }

    /**
     * Send big trading data for RBY (3 sections)
     */
    async sendBigTradingDataRBY(randomData, tradeData) {
        // FLL1 format: random + section1 + section2 (no section3)
        const totalLen = this.SECTION_LENGTHS[0] + this.SECTION_LENGTHS[1] + this.SECTION_LENGTHS[2];
        const fllData = new Uint8Array(totalLen);

        let offset = 0;
        fllData.set(randomData.slice(0, this.SECTION_LENGTHS[0]), offset);
        offset += this.SECTION_LENGTHS[0];
        fllData.set(tradeData.section1.slice(0, this.SECTION_LENGTHS[1]), offset);
        offset += this.SECTION_LENGTHS[1];
        fllData.set(tradeData.section2.slice(0, this.SECTION_LENGTHS[2]), offset);

        this.ws.sendData(this.MSG_FLL, fllData);
        this.log(`Sent FLL1: ${fllData.length} bytes`);
    }

    /**
     * Get big trading data for RBY (3 sections)
     */
    async getBigTradingDataRBY() {
        this.ws.sendGetData(this.MSG_FLL);
        const fllData = await this.waitForMessage(this.MSG_FLL, 30000);

        if (!fllData || fllData.length === 0) {
            this.log("No FLL1 data received");
            return null;
        }

        // Parse into 3 sections
        const sections = [];
        let offset = 0;

        sections[0] = fllData.slice(offset, offset + this.SECTION_LENGTHS[0]);
        offset += this.SECTION_LENGTHS[0];
        sections[1] = fllData.slice(offset, offset + this.SECTION_LENGTHS[1]);
        offset += this.SECTION_LENGTHS[1];
        sections[2] = fllData.slice(offset, offset + this.SECTION_LENGTHS[2]);

        this.log(`Received FLL1: ${fllData.length} bytes, parsed into 3 sections`);
        return sections;
    }

    /**
     * Trade menu loop - RBY version with different byte values
     */
    async tradeMenuLoop() {
        this.log("RBY Trade Menu Loop starting...");

        const POSSIBLE_INDEXES = this.POSSIBLE_INDEXES;

        while (!this.stopTrade) {
            // Drop last round's outgoing menu messages so a peer GET can never
            // be answered with a stale CHC1/ACP1/SUC1 from a previous round.
            delete this.ws.sendDict[this.MSG_CHC];
            delete this.ws.sendDict[this.MSG_ACP];
            delete this.ws.sendDict[this.MSG_SUC];

            if (this.verbose) this.log("[DEBUG] RBY: Waiting for Pokemon selection...");
            const choice = await this.waitForChoice(this.NO_INPUT, POSSIBLE_INDEXES, 10);

            if (this.stopTrade) break;

            this.log(`RBY: GB selected: 0x${choice.toString(16)} (Index: ${choice - this.FIRST_TRADE_INDEX})`);

            // Check for STOP_TRADE (pool: Python's to_server autoclose - end at once.
            // Link: Python sends the stop to the peer and awaits their answer.)
            if (choice === this.STOP_TRADE && !this.isLinkTrade) {
                this.log("RBY: Trade cancelled by player");
                await this.endTrade(this.STOP_TRADE);

                // For pool trades: reconnect WebSocket to get fresh Pokemon from server
                this.bufferedOtherData = null;
                delete this.ws.recvDict[this.MSG_POL];

                // Reconnect WebSocket to get new Pokemon from pool
                this.log("RBY Pool: Reconnecting to get fresh Pokemon...");
                const serverUrl = this.ws.url; // Store current URL before disconnect
                this.ws.disconnect();
                await this.sleep(500); // Brief delay for clean disconnect
                await this.ws.connect(serverUrl);
                this.log("RBY Pool: Reconnected! Will get new Pokemon on re-entry");
                break;
            }

            // Send CHC1: full Pokemon data for a choice, the short
            // [counter, stop] form when our player cancelled (Python
            // send_chosen_mon handles both the same way).
            const pokemonData = (choice === this.STOP_TRADE)
                ? new Uint8Array([choice])
                : this.extractSinglePokemon(choice);
            const chc1Payload = new Uint8Array(1 + pokemonData.length);
            chc1Payload[0] = this.tradeCounter;
            chc1Payload.set(pokemonData, 1);
            this.ws.sendData(this.MSG_CHC, chc1Payload);
            this.tradeCounter = (this.tradeCounter + 1) & 0xFF;
            this.log(`Sent CHC1 with Pokemon data: ${chc1Payload.length} bytes`);

            // Get peer's/server's Pokemon selection
            let serverChoice;
            if (!this.isLinkTrade) {
                // Pool trade: server auto-selects the pool Pokemon (always first slot)
                serverChoice = this.FIRST_TRADE_INDEX;
                this.log(`Pool: Server auto-selected: 0x${serverChoice.toString(16)}`);
            } else {
                // Link trade: GET CHC1 from peer to receive their actual selection
                // IMPORTANT: Clear any stale CHC1 from previous trade first!
                delete this.ws.recvDict[this.MSG_CHC];
                this.log("Link: Waiting for peer's Pokemon selection (CHC1)...");
                this.ws.sendGetData(this.MSG_CHC);
                // The peer is a human picking a mon - wait generously (Python
                // waits forever); never fabricate a choice on their behalf.
                const peerChoiceData = await this.waitForMessage(this.MSG_CHC, 600000);
                if (peerChoiceData && peerChoiceData.length >= 2) {
                    // CHC1 format: Counter (1) + Choice (1) + Pokemon data
                    serverChoice = peerChoiceData[1];
                    this.log(`Link: Peer selected: 0x${serverChoice.toString(16)} (Index: ${serverChoice - this.FIRST_TRADE_INDEX})`);
                } else {
                    this.log("[ERROR] Link: No peer choice received - ending trade");
                    await this.endTrade(this.STOP_TRADE);
                    break;
                }
            }

            // One-sided cancel handling (Python do_trade): both stopped ->
            // close the menu; one stopped -> back to selection so the other
            // player can re-pick. A peer stop must never reach the GB as a
            // Pokemon choice.
            if (choice === this.STOP_TRADE || serverChoice === this.STOP_TRADE) {
                if (choice === this.STOP_TRADE && serverChoice === this.STOP_TRADE) {
                    this.log("RBY: Both players cancelled - ending trade");
                    await this.endTrade(this.STOP_TRADE);
                    break;
                }
                this.log("RBY: One player cancelled - returning to selection");
                continue;
            }

            let next = await this.exchangeByte(serverChoice);
            next = await this.waitForNoData(next, serverChoice, 20);
            if (next === this.NO_DATA) next = await this.waitForNoInput(next);

            // Wait for GB accept/decline
            const gbAccept = await this.waitForAcceptDecline(next);
            if (this.stopTrade) break;

            this.log(`RBY: GB decision: ${gbAccept === this.ACCEPT_TRADE ? 'ACCEPT' : 'DECLINE'}`);

            // Send ACP1
            const acp1Counter = this.tradeCounter;
            this.ws.sendData(this.MSG_ACP, new Uint8Array([acp1Counter, gbAccept]));
            this.tradeCounter = (this.tradeCounter + 1) & 0xFF;

            // Get server/peer accept response
            // IMPORTANT: Clear any stale ACP1 from previous trade first!
            delete this.ws.recvDict[this.MSG_ACP];
            this.ws.sendGetData(this.MSG_ACP);
            // Link peers are humans confirming in-game - wait generously
            const serverAcceptData = await this.waitForMessage(this.MSG_ACP, this.isLinkTrade ? 120000 : 5000);

            let serverAccept;
            if (!this.isLinkTrade) {
                // Pool: use the server's REAL decision. The server declines when
                // the offered mon fails its sanity checks; forcing an accept here
                // made the server commit garbage into the shared pool (Python
                // forwards the server's reply to the GB).
                if (serverAcceptData && serverAcceptData.length >= 2) {
                    serverAccept = serverAcceptData[1];
                    this.log(`Pool: Server decision: ${serverAccept === this.ACCEPT_TRADE ? 'ACCEPT' : 'DECLINE'}`);
                } else {
                    this.log("Pool: WARNING - No server accept received, declining");
                    serverAccept = this.DECLINE_TRADE;
                }
            } else {
                // Link: parse peer's actual response from ACP1
                if (serverAcceptData && serverAcceptData.length >= 2) {
                    serverAccept = serverAcceptData[1];
                    this.log(`Link: Peer decision: ${serverAccept === this.ACCEPT_TRADE ? 'ACCEPT' : 'DECLINE'}`);
                } else {
                    this.log("Link: WARNING - No peer accept received, assuming decline");
                    serverAccept = this.DECLINE_TRADE;
                }
            }

            next = await this.exchangeByte(serverAccept);
            next = await this.waitForNoData(next, serverAccept, 20);
            if (next === this.NO_DATA) next = await this.waitForNoInput(next);

            if (gbAccept === this.ACCEPT_TRADE && serverAccept === this.ACCEPT_TRADE) {
                this.log("RBY: Trade accepted by both parties!");

                // Wait for success byte
                const successByte = await this.waitForChoice(next, this.SUCCESS_VALUES, 10);
                this.log(`RBY: Trade success! Final byte: 0x${successByte.toString(16)}`);

                if (!this.stopTrade) {
                    next = await this.exchangeByte(successByte);
                    next = await this.waitForNoData(next, successByte, 20);
                    if (next === this.NO_DATA) next = await this.waitForNoInput(next);

                    // Clear buffers
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

                    // Send SUC1
                    const suc1Counter = this.tradeCounter;
                    this.ws.sendData(this.MSG_SUC, new Uint8Array([suc1Counter, 0x61]));
                    this.tradeCounter = (this.tradeCounter + 1) & 0xFF;

                    // Clear stale SUC1 before waiting for new one
                    delete this.ws.recvDict[this.MSG_SUC];
                    this.ws.sendGetData(this.MSG_SUC);
                    await this.waitForMessage(this.MSG_SUC, this.isLinkTrade ? 60000 : 5000);

                    this.log("RBY: Trade round completed successfully!");

                    // For pool trades: get a new Pokemon from the pool.
                    // (The mon we gave the server already went out inside CHC1;
                    // an extra SNG1 send here is outside the server's protocol
                    // and its size is not in the SNG1 whitelist.)
                    if (!this.isLinkTrade) {
                        // Get new Pokemon from pool via POL1 (will be used in next tradeStartingSequence)
                        this.log(`RBY Pool: Requesting new Pokemon from pool via ${this.MSG_POL}...`);
                        this.ws.sendGetData(this.MSG_POL);
                        const newPoolData = await this.waitForMessage(this.MSG_POL, 5000);

                        if (newPoolData && newPoolData.length > 1) {
                            this.log(`RBY Pool: Received new Pokemon from pool (${newPoolData.length} bytes)`);
                            delete this.ws.recvDict[this.MSG_POL];
                        } else {
                            this.log("RBY Pool: No new Pokemon received, pool may be empty");
                        }

                        // Break to let outer loop handle sit at table + section exchange
                        // The GB expects to re-enter the trade room and exchange sections again
                        this.log("RBY Pool: Trade complete. Returning to trade room...");
                        break;
                    } else {
                        // Link trade: Update bufferedOtherData with the trade result
                        // Like Python's trade_mon(), we need to:
                        // 1. Put the Pokemon we gave to them at the end of their party
                        // This ensures the next trade shows correct party state

                        const ourTradedIndex = choice - this.FIRST_TRADE_INDEX;
                        const peerTradedIndex = serverChoice - this.FIRST_TRADE_INDEX;

                        this.log(`Link: Updating cached peer data (we gave slot ${ourTradedIndex}, they gave slot ${peerTradedIndex})`);

                        // Update peer's party: put OUR traded Pokemon at the end of their party
                        if (this.bufferedOtherData && this.bufferedOtherData[1]) {
                            this.updatePeerPartyAfterTrade(ourTradedIndex, peerTradedIndex);
                        }

                        this.log("Link: Trade complete. Cached data updated for next trade.");
                        break;
                    }
                }
            } else {
                this.log("RBY: Trade declined. Returning to selection...");
            }
        }

        this.log("RBY: Trade menu loop ended.");
    }

    /**
     * Update peer's cached party data after a successful trade.
     * Like Python's trade_mon(), moves their traded Pokemon to the end
     * and replaces it with our Pokemon.
     * 
     * @param {number} ourIndex - Index of Pokemon we traded to them
     * @param {number} peerIndex - Index of Pokemon they traded to us
     */
    updatePeerPartyAfterTrade(ourIndex, peerIndex) {
        const peerSection1 = this.bufferedOtherData[1];
        if (!peerSection1 || !this.gbPartyData) return;

        // Get party size from peer's data (byte at trading_party_info_pos)
        const partySize = peerSection1[RBYUtils.trading_party_info_pos];
        if (partySize === 0 || partySize > 6) {
            this.log(`Link: Invalid peer party size: ${partySize}`);
            return;
        }

        const lastIndex = partySize - 1;
        const POKEMON_LEN = RBYUtils.trading_pokemon_length; // 44 bytes
        const NAME_LEN = RBYUtils.trading_name_length;       // 11 bytes

        // Step 1: Reorder peer's party - move their traded Pokemon to end
        // (Shift Pokemon after peerIndex down by 1)
        if (peerIndex < lastIndex) {
            // Move Pokemon data
            for (let i = peerIndex; i < lastIndex; i++) {
                const srcStart = RBYUtils.trading_pokemon_pos + (i + 1) * POKEMON_LEN;
                const dstStart = RBYUtils.trading_pokemon_pos + i * POKEMON_LEN;
                for (let j = 0; j < POKEMON_LEN; j++) {
                    peerSection1[dstStart + j] = peerSection1[srcStart + j];
                }
            }
            // Move OT names
            for (let i = peerIndex; i < lastIndex; i++) {
                const srcStart = RBYUtils.trading_pokemon_ot_pos + (i + 1) * NAME_LEN;
                const dstStart = RBYUtils.trading_pokemon_ot_pos + i * NAME_LEN;
                for (let j = 0; j < NAME_LEN; j++) {
                    peerSection1[dstStart + j] = peerSection1[srcStart + j];
                }
            }
            // Move nicknames
            for (let i = peerIndex; i < lastIndex; i++) {
                const srcStart = RBYUtils.trading_pokemon_nickname_pos + (i + 1) * NAME_LEN;
                const dstStart = RBYUtils.trading_pokemon_nickname_pos + i * NAME_LEN;
                for (let j = 0; j < NAME_LEN; j++) {
                    peerSection1[dstStart + j] = peerSection1[srcStart + j];
                }
            }
            // Move party info IDs (species list after count)
            for (let i = peerIndex; i < lastIndex; i++) {
                peerSection1[RBYUtils.trading_party_info_pos + 1 + i] =
                    peerSection1[RBYUtils.trading_party_info_pos + 1 + i + 1];
            }
        }

        // Step 2: Copy OUR traded Pokemon to the END of peer's party
        // Get our Pokemon data from gbPartyData (what we collected from our Game Boy)
        const ourPokemonStart = RBYUtils.trading_pokemon_pos + ourIndex * POKEMON_LEN;
        const ourOtStart = RBYUtils.trading_pokemon_ot_pos + ourIndex * NAME_LEN;
        const ourNickStart = RBYUtils.trading_pokemon_nickname_pos + ourIndex * NAME_LEN;

        const peerLastPokemonStart = RBYUtils.trading_pokemon_pos + lastIndex * POKEMON_LEN;
        const peerLastOtStart = RBYUtils.trading_pokemon_ot_pos + lastIndex * NAME_LEN;
        const peerLastNickStart = RBYUtils.trading_pokemon_nickname_pos + lastIndex * NAME_LEN;

        // Copy Pokemon data
        for (let j = 0; j < POKEMON_LEN; j++) {
            peerSection1[peerLastPokemonStart + j] = this.gbPartyData[ourPokemonStart + j] ?? 0;
        }
        // Copy OT name
        for (let j = 0; j < NAME_LEN; j++) {
            peerSection1[peerLastOtStart + j] = this.gbPartyData[ourOtStart + j] ?? 0;
        }
        // Copy nickname
        for (let j = 0; j < NAME_LEN; j++) {
            peerSection1[peerLastNickStart + j] = this.gbPartyData[ourNickStart + j] ?? 0;
        }

        // Copy species to party info
        const ourSpecies = this.gbPartyData[RBYUtils.trading_party_info_pos + 1 + ourIndex];
        peerSection1[RBYUtils.trading_party_info_pos + 1 + lastIndex] = ourSpecies;

        this.log(`Link: Updated peer party - our Pokemon (slot ${ourIndex}) now at end of their party (slot ${lastIndex})`);
    }

    /**
     * Prevent sending 0xFE as data - replace with 0xFF.
     * 0xFE is the protocol "no input" marker, so sending it as data would corrupt the exchange.
     */
    preventNoInput(val) {
        if (val === this.NO_INPUT) {
            return this.NO_INPUT_ALTERNATIVE;
        }
        return val;
    }

    /**
     * Read section - RBY uses only 3 sections
     * Also applies JP fillers when receiving from Japanese Game Boy
     */
    async readSection(index, sendData, skipSync = false) {
        if (index > 2) {
            this.log(`RBY: Invalid section index ${index} (max 2)`);
            return null;
        }

        // Pre-process sendData to replace 0xFE with 0xFF
        // In Pokemon trading protocol, 0xFE means "no input" so we can't send it as data
        let processedSendData = sendData;
        if (sendData && sendData.length > 0) {
            processedSendData = new Uint8Array(sendData.length);
            for (let i = 0; i < sendData.length; i++) {
                processedSendData[i] = this.preventNoInput(sendData[i]);
            }
        }

        // Call parent readSection with processed data
        const receivedData = await super.readSection(index, processedSendData, skipSync);

        // Apply JP fillers if Japanese mode and we have fillers for this section
        if (this.isJapanese && receivedData && this.JP_FILLERS[index]) {
            const fillers = this.JP_FILLERS[index];
            if (Object.keys(fillers).length > 0) {
                return this.applyJpFillers(receivedData, fillers);
            }
        }

        return receivedData;
    }

    /**
     * Apply JP fillers to section data.
     * Inserts padding bytes at specified positions to convert JP format to INT format.
     * 
     * @param {Uint8Array} data - Raw data received from Game Boy
     * @param {Object} fillers - Map of position -> [fillLength, fillByte]
     * @returns {Uint8Array} - Data with fillers applied
     */
    applyJpFillers(data, fillers) {
        // Sort filler positions in ascending order
        const positions = Object.keys(fillers).map(Number).sort((a, b) => a - b);

        if (positions.length === 0) {
            return data;
        }

        // Calculate total fill bytes to add
        let totalFillBytes = 0;
        for (const pos of positions) {
            totalFillBytes += fillers[pos][0];
        }

        // Create new array with room for filler bytes
        const result = new Uint8Array(data.length + totalFillBytes);

        let srcOffset = 0;
        let dstOffset = 0;

        for (const pos of positions) {
            const [fillLength, fillByte] = fillers[pos];

            // Copy data up to this position
            const copyLen = pos - srcOffset;
            if (copyLen > 0 && srcOffset < data.length) {
                result.set(data.slice(srcOffset, srcOffset + copyLen), dstOffset);
                dstOffset += copyLen;
                srcOffset += copyLen;
            }

            // Insert filler bytes
            for (let i = 0; i < fillLength; i++) {
                result[dstOffset++] = fillByte;
            }
        }

        // Copy remaining data
        if (srcOffset < data.length) {
            result.set(data.slice(srcOffset), dstOffset);
        }

        this.log(`[RBY-JP] Applied ${positions.length} fillers, expanded ${data.length} -> ${result.length} bytes`);
        return result;
    }

    /**
     * Remove JP fillers from section data before sending to Japanese Game Boy.
     * Reverses the applyJpFillers operation.
     * 
     * @param {Uint8Array} data - INT format data
     * @param {Object} fillers - Map of position -> [fillLength, fillByte]
     * @returns {Uint8Array} - JP format data with fillers removed
     */
    removeJpFillers(data, fillers) {
        const positions = Object.keys(fillers).map(Number).sort((a, b) => a - b);

        if (positions.length === 0) {
            return data;
        }

        // Calculate total fill bytes to remove
        let totalFillBytes = 0;
        for (const pos of positions) {
            totalFillBytes += fillers[pos][0];
        }

        // Create new array without filler bytes
        const result = new Uint8Array(data.length - totalFillBytes);

        let srcOffset = 0;
        let dstOffset = 0;

        for (const pos of positions) {
            const [fillLength, _] = fillers[pos];

            // Copy data up to this position
            const copyLen = pos - dstOffset;
            if (copyLen > 0 && srcOffset < data.length) {
                result.set(data.slice(srcOffset, srcOffset + copyLen), dstOffset);
                srcOffset += copyLen;
                dstOffset += copyLen;
            }

            // Skip filler bytes in source
            srcOffset += fillLength;
        }

        // Copy remaining data
        if (dstOffset < result.length && srcOffset < data.length) {
            result.set(data.slice(srcOffset, srcOffset + (result.length - dstOffset)), dstOffset);
        }

        this.log(`[RBY-JP] Removed ${positions.length} fillers, shrunk ${data.length} -> ${result.length} bytes`);
        return result;
    }

    // ==================== VEC FLOOD OVERRIDES ====================
    // Must override to use VEC1 instead of hardcoded VEC2

    startVEC2Flood() {
        if (this.vec2FloodInterval) return;
        this.log("Starting VEC1 Flood to ensure server sees Version...");
        const versionData = new Uint8Array([4, 0, 0, 0, 0, 0]);
        this.vec2FloodInterval = setInterval(() => {
            if (this.ws && this.ws.isConnected) {
                this.ws.sendData(this.MSG_VEC, versionData); // Uses VEC1 getter
            }
        }, 200);
    }

    stopVEC2Flood() {
        if (this.vec2FloodInterval) {
            clearInterval(this.vec2FloodInterval);
            this.vec2FloodInterval = null;
            this.log("Stopped VEC1 Flood.");
        }
    }
}
