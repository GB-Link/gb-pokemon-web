/**
 * GSCBattling.js - Gen 2 (Gold/Silver/Crystal) Link Battle Protocol
 * trade menu is replaced by the per-turn choice exchange, and three battle
 * transfers are added on top of the trading tags:
 * - BFL2: full battle data (counter + rng echo + party + patches) for
 *   post-exchange verification
 * - TST2: peer rendezvous before a synchronous section transfer
 * - RSS2: server RNG reseed acknowledgment
 * The 10-byte RNG section always comes from the server (both players get the
 * identical seed) so the two games' battle RNGs stay in lockstep.
 */

import { GSCTrading } from './GSCTrading.js?v=91';
import { GSCUtils } from './GSCUtils.js?v=91';
import { GSCPokemonInfo } from './GSCPokemonInfo.js?v=91';
import { GSCTradingData } from './GSCTradingDataUtils.js?v=91';

export class GSCBattling extends GSCTrading {
    constructor(usb, ws, logger, tradeType = 'battle', isBuffered = false, doSanityChecks = true, options = {}) {
        super(usb, ws, logger, tradeType, isBuffered, doSanityChecks, options);

        // Battles reuse all the 2-player link machinery (negotiation, sync engine)
        this.isLinkTrade = true;

        // ==================== BATTLE STATE MACHINES ====================
        // Colosseum room entry (0xD2 = fighting, vs 0xD1 trading)
        this.ENTER_ROOM_STATES = [
            [0x01, 0x61, 0xD2, 0x00, 0xFE],
            [new Set([0x61]), new Set([0xD2]), new Set([0x00]), new Set([0xFE]), new Set([0xFE])]
        ];
        this.START_TRADING_STATES = [
            [0x85, 0x85, 0x86],
            [new Set([0x85]), new Set([0x00]), new Set([0xFD])]
        ];

        // Battles exchange 3 sections: no mail
        this.SPECIAL_SECTIONS_LEN = [0xA, 0x1BC, 0xC5];
        this.SPECIAL_SECTIONS_PREAMBLE_LEN = [7, 6, 3];
        this.SECTION_NAMES = ['Random data', 'Party data', 'Patch data'];

        // JP battles differ only in the text fillers (no mail machinery);
        // same filler block as the JP trade layout
        this.SECTION_FILLERS = [{}, {}, {}];
        this.EXTRA_SECTION_DROPS = [0, 0, 0];
        if (this.isJapanese) {
            const fillers = {};
            fillers[6] = [5, 0x50]; // trainer name
            for (let i = 0; i < 12; i++) { // 6 OT names + 6 nicknames
                fillers[0x13B + i * 0x0B] = [5, 0x50];
            }
            this.SECTION_FILLERS[1] = fillers;
            this.EXTRA_SECTION_DROPS[1] = 4;
        }

        // ==================== BATTLE MENU BYTES ====================
        this.STOP_BATTLE = 0x8F;
        this.FIRST_BATTLE_INDEX = 0x80;
        this.MOVE_START_INDEX = 0x80;   // 0x80-0x83 = moves 1-4
        this.MON_START_INDEX = 0x84;    // 0x84-0x89 = party mons 1-6
        this.STRUGGLE_INDEX = 0x8E;
        this.MAX_NUM_POKEMON_PARTY = 6;
        this.MAX_NUM_MOVES_POKEMON = 4;
        // Active mon becomes unknown after whirlwind/roar/metronome/mimic
        this.UNKNOWN_MON_INDEX = 0xFF;
        this.CHOICE_STRUGGLE_ID = 0xFF;
        this.MOVE_WHIRLWIND_ID = 18;
        this.MOVE_ROAR_ID = 46;
        this.MOVE_MIMIC_ID = 102;
        this.MOVE_METRONOME_ID = 118;
        this.POSSIBLE_INDEXES = new Set();
        for (let i = 0x80; i < 0x90; i++) {
            this.POSSIBLE_INDEXES.add(i);
        }

        // Shared-helper constants (Python GSCTrading class attributes)
        this.OPTION_CONFIRMATION_THRESHOLD = 10;
        this.RESENDS_LIMIT_TRADE = 20;
        this.MAX_CONSECUTIVE_NO_DATA = 0x100;

        // ==================== BATTLE STATE ====================
        this.currOwnMonIndex = 0;
        this.currOtherMonIndex = 0;
        this.lockSwapStart = 0;
        this.lockSwapAmountS = 0;
        this.lastRandom = null;
        // Gen 2 suspends link polling between turns (battle animations);
        // Gen 1 disables this entirely
        this.canDropCommands = true;
        this.healAfterNotValidBuffered = false;
        this.initialSitPosition = 0;
        this.isVersionCheckDone = false;
        this.exitOrNew = true;
        this.hasGhosted = false;
        this._usbReadFailures = 0;
        this.ownPokemon = null;
        this.otherPokemon = null;
        this.battleBaseSections = null;
        this.battleTurnTimeS = options.battleTurnTime ?? 30;

        // UI hooks for the inter-turn wait (Python's ENTER-to-skip prompt)
        this.onTurnWait = null;
        this.onTurnWaitEnd = null;
        this._turnWaitResolve = null;
    }

    // ==================== BATTLE MESSAGE TAGS ====================
    get MSG_BFL() { return "BFL2"; }
    get MSG_RSS() { return "RSS2"; }
    get MSG_TST() { return "TST2"; }

    get BASE_BATTLE_PATH() { return '/data/gsc/base_battle.bin'; }

    // Python utils_class hook: patch helpers must be invoked through the
    // per-gen class so the late-bound patch positions resolve correctly
    get utilsClass() { return GSCUtils; }

    get GEN_NAME() { return 'GSC'; }

    createPartyReader(partyBytes) {
        return new GSCTradingData(partyBytes);
    }

    // ==================== DATA LOADING ====================

    async loadBattleData() {
        if (this.doSanityChecks && this.checks.load) {
            const loaded = await this.checks.load();
            if (!loaded) {
                this.log('[WARN] Could not load sanity check data, continuing without checks');
                this.checks.doSanityChecks = false;
            }
        }
        // Needed even without checks: noMailSection for createTradingData and
        // movesPpList for healing
        await GSCUtils.load();
        await this.loadBattleBaseData();
    }

    /**
     * Load the buffered-mode ghost party (Python base_no_trade = base_battle.bin).
     */
    async loadBattleBaseData() {
        if (this.battleBaseSections) return true;
        try {
            const response = await fetch(this.BASE_BATTLE_PATH);
            if (!response.ok) {
                this.log(`[WARN] Could not load ${this.BASE_BATTLE_PATH} (${response.status})`);
                return false;
            }
            const data = new Uint8Array(await response.arrayBuffer());
            this.battleBaseSections = this.divideData(data, this.SPECIAL_SECTIONS_LEN);
            return true;
        } catch (e) {
            this.log(`[WARN] Error loading battle base data: ${e.message}`);
            return false;
        }
    }

    divideData(data, lengths) {
        const sections = [];
        let offset = 0;
        for (const len of lengths) {
            sections.push(new Uint8Array(data.slice(offset, offset + len)));
            offset += len;
        }
        return sections;
    }

    /**
     * Python read_section applies the per-byte checks map to the peer-bound
     * wire stream; the web applies it to the collected copy before decoding.
     * A no-op when the checks engine has no section map (gen 1 stub).
     */
    sanitizePeerSection(index, wireBytes) {
        if (!this.checks.getChecker || !this.checks.applyChecksToData) return;
        const checker = this.checks.getChecker(index);
        if (!checker) return;
        this.checks.prepareTextBuffer?.();
        this.checks.preparePatchSetsBuffer?.();
        this.checks.prepareSpeciesBuffer?.();
        const cleaned = this.checks.applyChecksToData(checker, wireBytes);
        for (let i = 0; i < wireBytes.length && i < cleaned.length; i++) {
            wireBytes[i] = cleaned[i];
        }
    }

    // ==================== LOCK SWAP (inter-turn polling suspension) ====================

    startLockSwap(seconds) {
        this.lockSwapStart = Date.now();
        this.lockSwapAmountS = seconds;
    }

    stopLockSwap() {
        this.lockSwapAmountS = 0;
    }

    isLockSwapStopped() {
        return this.lockSwapAmountS === 0;
    }

    getLockSwapRemainingTime() {
        if (this.isLockSwapStopped()) return 0;
        const elapsedS = (Date.now() - this.lockSwapStart) / 1000;
        if (elapsedS >= this.lockSwapAmountS) return 0;
        return this.lockSwapAmountS - elapsedS;
    }

    async exchangeByte(byteToSend) {
        if (this.getLockSwapRemainingTime() > 0) {
            return this.NO_INPUT;
        }
        await this.usb.writeByte(byteToSend);
        try {
            const recv = await this.usb.readByte();
            this._usbReadFailures = 0;
            return recv;
        } catch (e) {
            return this.failedRead(e, ++this._usbReadFailures);
        }
    }

    // ==================== PREDEFINED SECTIONS (enter room / sit) ====================

    /**
     * Python send_predefined_section: advance through fixed states; with
     * dieOnNoData, 0x100 consecutive 0x00 at state 0 means the player left.
     */
    async sendPredefinedSection(statesList, initialSending = 0, dieOnNoData = false) {
        let sending = initialSending;
        let consecutiveNoData = 0;
        while (sending < statesList[0].length && !this.stopTrade) {
            const recv = await this.exchangeByte(statesList[0][sending]);
            const expected = statesList[1][sending];
            const matched = expected instanceof Set ? expected.has(recv)
                : Array.isArray(expected) ? expected.includes(recv)
                    : recv === expected;
            if (matched) {
                sending++;
                if (this.verbose) this.log(`[DEBUG] Battle state advanced to ${sending}. Recv: ${recv.toString(16)}`);
            } else if (dieOnNoData && sending === 0) {
                if (recv === this.NO_DATA) {
                    consecutiveNoData++;
                    if (consecutiveNoData >= this.MAX_CONSECUTIVE_NO_DATA) {
                        return false;
                    }
                } else {
                    consecutiveNoData = 0;
                }
            }
            await this.sleep(5);
        }
        return !this.stopTrade;
    }

    async enterRoom() {
        this.log("Entering the battle room...");
        await this.sendPredefinedSection(this.ENTER_ROOM_STATES);
        this.log("Entered the battle room.");
        return true;
    }

    async sitToTable(initialSending = 0) {
        if (this.exitOrNew) {
            this.log("Sit at the battle table to start a battle (leave the room to exit).");
            this.onStatus?.('Start a battle on your Game Boy (Colosseum)');
        }
        return this.sendPredefinedSection(this.START_TRADING_STATES, initialSending, true);
    }

    // ==================== FORCE-RECEIVE HELPERS ====================

    /**
     * Python force_receive over a non-counter tag: poll the receive dict,
     * re-request every 500ms, optionally keep the console clock alive.
     * Only main-loop callers may keep-alive (single transport).
     */
    async forceReceiveTag(tag, keepAlive = true, timeoutMs = 600000, fresh = false) {
        if (fresh) {
            delete this.ws.recvDict[tag];
        }
        const deadline = Date.now() + timeoutMs;
        let lastGet = 0;
        while (!this.stopTrade && Date.now() < deadline) {
            const data = this.ws.recvDict[tag];
            if (data && data.length > 0) {
                delete this.ws.recvDict[tag];
                return data;
            }
            if (Date.now() - lastGet > 500) {
                this.ws.sendGetData(tag);
                lastGet = Date.now();
            }
            if (keepAlive) await this.exchangeByte(this.NO_INPUT);
            await this.sleep(keepAlive ? 20 : 50);
        }
        return null;
    }

    async waitForReseed(keepAlive) {
        const data = await this.forceReceiveTag(this.MSG_RSS, keepAlive, 600000, true);
        return data !== null;
    }

    async getRandomBattle() {
        const data = await this.forceReceiveTag(this.MSG_RAN, true, 600000, true);
        return data ? new Uint8Array(data) : null;
    }

    // ==================== TST (synchronous transfer rendezvous) ====================

    sendTransferSyncTransfer() {
        this.ws.sendData(this.MSG_TST, new Uint8Array([1]));
    }

    async getTransferSyncTransfer() {
        return this.forceReceiveTag(this.MSG_TST, true);
    }

    resetTransferSyncTransfer() {
        delete this.ws.sendDict[this.MSG_TST];
        delete this.ws.recvDict[this.MSG_TST];
    }

    // ==================== VERSION CHECK / NEGOTIATION TAIL ====================

    /**
     * Python post_buffered_negotiation_init: the reseed ack MUST come before
     * the version check (each client's G RSS regenerates the shared seed).
     * Runs inside the background negotiation promise - never touches USB.
     */
    async postBufferedNegotiationInit() {
        const reseeded = await this.waitForReseed(false);
        if (!reseeded) {
            throw new Error('Server never acknowledged the RNG reseed');
        }
        await this.doVersionCheckBattle();
    }

    async doVersionCheckBattle() {
        this.useNewProtocol = false;
        this.ws.sendGetData(this.MSG_VES);
        const serverVersion = await this.waitForMessage(this.MSG_VES, 5000);
        if (serverVersion) {
            const peerVersion = await this.waitForMessage(this.MSG_VEC, 10000);
            if (peerVersion && peerVersion.length > 0) {
                this.useNewProtocol = true;
                this.log("Peer supports the NEW sync protocol (32-byte packets)");
            }
        }
        if (!this.useNewProtocol) {
            // Python reset_client_version: withdraw our version so the peer's
            // window also misses and both settle on the OLD protocol
            delete this.ws.sendDict[this.MSG_VEC];
            this.log("Using the OLD sync protocol (7-byte packets) for compatibility");
        }
        this.isVersionCheckDone = true;
    }

    // ==================== SECTION EXCHANGE ====================

    /**
     * Python battle_starting_sequence: exchange the three battle sections.
     * The RNG section is always fed buffered-style from the server seed.
     */
    async battleStartingSequence(buffered, sendData = [null, null, null]) {
        this.checks.resetSpeciesItemList?.();

        // Keep the console clock alive until the background handshake
        // (reseed + version check) is done
        while (!this.isVersionCheckDone && !this.stopTrade) {
            await this.exchangeByte(this.NO_INPUT);
            await this.sleep(20);
        }
        if (this.stopTrade) throw new Error('Battle stopped');

        if (!buffered) {
            this.sendTransferSyncTransfer();
            this.log("Waiting for the other player to also start the transfer...");
            this.onStatus?.('Waiting for the other player to also start the transfer…');
            if (!(await this.getTransferSyncTransfer())) {
                throw new Error('Peer never confirmed the synchronous transfer');
            }
        }

        this.lastRandom = await this.getRandomBattle();
        if (!this.lastRandom) {
            throw new Error('No RNG data received from the server');
        }

        await this.readSection(0, this.lastRandom, true);
        const partyData = await this.readSection(1, sendData[1], buffered);
        const patchData = await this.readSection(2, sendData[2], buffered);
        if (this.stopTrade) throw new Error('Battle stopped');

        // Decode our party (0xFE bytes are escaped on the wire)
        const ownParty = new Uint8Array(partyData);
        this.utilsClass.applyPatches(ownParty, patchData, false);

        // Decode the other party: from the sync exchange, or from what we fed
        if (!buffered && (!this.peerPartyData || !this.peerPatchData)) {
            throw new Error('Peer battle data missing after the synchronous exchange');
        }
        const otherParty = new Uint8Array(!buffered ? this.peerPartyData : sendData[1]);
        const otherPatch = new Uint8Array(!buffered ? this.peerPatchData : sendData[2]);
        // Python runs the per-byte checks map over the peer-bound stream; the
        // BFL verification then catches any data the checks had to fix
        this.sanitizePeerSection(1, otherParty);
        this.sanitizePeerSection(2, otherPatch);
        this.utilsClass.applyPatches(otherParty, otherPatch, false);

        if (!buffered) {
            this.resetTransferSyncTransfer();
        }

        return [
            [this.lastRandom, ownParty, null],
            [this.lastRandom, otherParty, null]
        ];
    }

    /**
     * Python synchronous_trade (battles reuse it unchanged via the rename trick).
     */
    async synchronousBattle() {
        let data, dataOther;
        if (this.otherPokemon === null) {
            [data, dataOther] = await this.battleStartingSequence(false);
        } else {
            this.log("Recycling data from the previous battle...");
            [data, dataOther] = await this.battleStartingSequence(true, this.otherPokemon.createTradingData());
        }
        this.ownPokemon = this.createPartyReader(data[1]);
        this.otherPokemon = this.createPartyReader(dataOther[1]);
        return true;
    }

    /**
     * Python buffered_trade: non-blocking peer-FLL check with the base_battle
     * ghost fallback, then send our real party back as FLL.
     */
    async bufferedBattle() {
        this.checks.doSanityChecks = this.doSanityChecks;
        let sections;
        let valid = true;
        if (this.otherPokemon === null) {
            this.ws.sendGetData(this.MSG_FLL);
            await this.sleep(500);
            let peerFll = this.ws.recvDict[this.MSG_FLL];
            if (!peerFll && this.hasGhosted) {
                // Our data is already out, so the peer's is on its way -
                // wait for it (keeping the console clocked) instead of
                // looping ghost battles while the peer catches up
                this.log("Waiting for the other player's battle data...");
                this.onStatus?.("Waiting for the other player's battle data…");
                peerFll = await this.forceReceiveTag(this.MSG_FLL, true, 120000);
            } else if (peerFll) {
                delete this.ws.recvDict[this.MSG_FLL];
            }
            if (peerFll && peerFll.length > 0) {
                sections = this.divideData(peerFll, this.SPECIAL_SECTIONS_LEN);
                this.log("Found the other player's buffered battle data!");
            } else {
                if (!this.battleBaseSections) {
                    await this.loadBattleBaseData();
                }
                if (!this.battleBaseSections) {
                    throw new Error('Battle base data unavailable for the ghost battle');
                }
                sections = this.battleBaseSections.map(s => new Uint8Array(s));
                valid = false;
                this.hasGhosted = true;
                this.checks.doSanityChecks = false;
                this.log("The other player's data isn't here yet. Battling the ghost party...");
                this.onStatus?.('Ghost battle — pick any action, then flee to continue');
            }
        } else {
            this.log("Recycling data from the previous battle...");
            sections = this.otherPokemon.createTradingData();
        }

        const [data, dataOther] = await this.battleStartingSequence(true, sections);
        this.ownPokemon = this.createPartyReader(data[1]);
        this.otherPokemon = this.createPartyReader(dataOther[1]);
        if (!valid && this.healAfterNotValidBuffered) {
            this.ownPokemon.healParty();
        }
        this.sendBattleFllData();
        return valid;
    }

    /**
     * Python send_big_trading_data: our full data (all sections concatenated)
     * for the peer's buffered pass. No counter on FLL.
     */
    sendBattleFllData() {
        const sections = this.ownPokemon.createTradingData();
        let total = 0;
        for (const sec of sections) total += sec.length;
        const payload = new Uint8Array(total);
        let offset = 0;
        for (const sec of sections) {
            payload.set(sec, offset);
            offset += sec.length;
        }
        this.log(`Sending ${this.MSG_FLL} battle data: ${payload.length} bytes`);
        this.ws.sendData(this.MSG_FLL, payload);
    }

    // ==================== BFL (post-exchange verification) ====================

    /**
     * Python send_big_battle_trading_data: counter + rng echo + party + patches
     * (+ the gen 2 no-mail block that createTradingData always appends).
     */
    sendBigBattleTradingData() {
        const sections = this.ownPokemon.createTradingData();
        if (this.ownCounterId === undefined) {
            this.ownCounterId = Math.floor(Math.random() * 256);
        }
        let total = 1 + this.lastRandom.length;
        for (let i = 1; i < sections.length; i++) total += sections[i].length;
        const payload = new Uint8Array(total);
        payload[0] = this.ownCounterId;
        payload.set(this.lastRandom, 1);
        let offset = 1 + this.lastRandom.length;
        for (let i = 1; i < sections.length; i++) {
            payload.set(sections[i], offset);
            offset += sections[i].length;
        }
        this.ws.sendData(this.MSG_BFL, payload);
        this.ownCounterId = (this.ownCounterId + 1) % 256;
    }

    async getBigBattleTradingData() {
        const data = await this.getCounterMessage(this.MSG_BFL);
        if (!data) return null;
        return this.divideData(data.slice(1), this.SPECIAL_SECTIONS_LEN);
    }

    /**
     * Python player_battle's success check: the rng echo must match the server
     * seed and every mon must byte-equal what the section exchange produced.
     */
    verifyBattleData(otherFull) {
        const rngEcho = otherFull[0];
        if (!this.lastRandom || rngEcho.length !== this.lastRandom.length) return false;
        for (let i = 0; i < rngEcho.length; i++) {
            if (rngEcho[i] !== this.lastRandom[i]) return false;
        }
        const otherPartyData = otherFull[1];
        this.utilsClass.applyPatches(otherPartyData, otherFull[2], false);
        const otherFinal = this.createPartyReader(otherPartyData);
        if (otherFinal.getPartySize() !== this.otherPokemon.getPartySize()) return false;
        for (let i = 0; i < otherFinal.getPartySize(); i++) {
            if (!otherFinal.pokemon[i].isEqual(this.otherPokemon.pokemon[i], true, true)) {
                return false;
            }
        }
        return true;
    }

    // ==================== CHOICE HELPERS ====================

    isChoiceStop(choice) {
        return choice === this.STOP_BATTLE;
    }

    isChoiceMove(choice) {
        if (choice === this.STRUGGLE_INDEX) return true;
        if (choice < this.MOVE_START_INDEX) return false;
        if (choice >= this.MOVE_START_INDEX + this.MAX_NUM_MOVES_POKEMON) return false;
        return true;
    }

    isChoiceMon(choice) {
        if (choice < this.MON_START_INDEX) return false;
        if (choice >= this.MON_START_INDEX + this.MAX_NUM_POKEMON_PARTY) return false;
        return true;
    }

    convertChoiceMove(choice) {
        if (choice === this.STRUGGLE_INDEX) return this.CHOICE_STRUGGLE_ID;
        return choice - this.MOVE_START_INDEX;
    }

    convertChoiceMon(choice) {
        return choice - this.MON_START_INDEX;
    }

    /**
     * Python is_move_unpredictable: moves that can force switches (or copy
     * ones that do) make the opponent's active mon unknowable. null = error.
     */
    isMoveUnpredictable(mon, moveIndex, battleData) {
        if (moveIndex === this.CHOICE_STRUGGLE_ID) return false;
        if (moveIndex >= 4) return null;

        if (mon !== this.UNKNOWN_MON_INDEX) {
            if (!this.isMonUsable(mon, battleData)) return null;
            const move = battleData.pokemon[mon].getMove(moveIndex);
            if (move === GSCPokemonInfo.FREE_VALUE_MOVES) return null;
            if (move === this.MOVE_WHIRLWIND_ID) return true;
            if (move === this.MOVE_ROAR_ID) return true;
            if (move === this.MOVE_METRONOME_ID) return true;
            if (move === this.MOVE_MIMIC_ID) return true;
            return false;
        }

        // The current mon could be anything, so test the whole party
        for (let i = 0; i < battleData.getPartySize(); i++) {
            const move = battleData.pokemon[i].getMove(moveIndex);
            if (move === this.MOVE_WHIRLWIND_ID) return true;
            if (move === this.MOVE_ROAR_ID) return true;
            if (move === this.MOVE_METRONOME_ID) return true;
            if (move === this.MOVE_MIMIC_ID) return true;
        }
        return false;
    }

    isMoveUsable(mon, moveIndex, battleData) {
        // Struggle is always available
        if (moveIndex === this.CHOICE_STRUGGLE_ID) return true;
        if (moveIndex >= 4) return false;
        // The current mon could be anything, so accept
        if (mon === this.UNKNOWN_MON_INDEX) return true;
        if (!this.isMonUsable(mon, battleData)) return false;
        if (battleData.pokemon[mon].getMove(moveIndex) === GSCPokemonInfo.FREE_VALUE_MOVES) return false;
        return true;
    }

    isMonUsable(mon, battleData) {
        return mon < battleData.getPartySize();
    }

    /**
     * Python update_battle_information: track both active mons; a switch-forcing
     * move makes the OPPOSITE side's active mon unknown until it's seen again.
     */
    updateBattleInformation(sentChoice, receivedChoice) {
        const lastTurnOwnMon = this.currOwnMonIndex;
        const lastTurnOtherMon = this.currOtherMonIndex;

        const ownIsMove = this.isChoiceMove(sentChoice);
        const ownMoveIndex = this.convertChoiceMove(sentChoice);
        const ownIsMon = this.isChoiceMon(sentChoice);
        const ownMonIndex = this.convertChoiceMon(sentChoice);

        const opponentIsMove = this.isChoiceMove(receivedChoice);
        const opponentMoveIndex = this.convertChoiceMove(receivedChoice);
        const opponentIsMon = this.isChoiceMon(receivedChoice);
        const opponentMonIndex = this.convertChoiceMon(receivedChoice);

        if (opponentIsMon) this.currOtherMonIndex = opponentMonIndex;
        if (ownIsMon) this.currOwnMonIndex = ownMonIndex;

        if (ownIsMove) {
            let unpredictable = this.isMoveUnpredictable(lastTurnOwnMon, ownMoveIndex, this.ownPokemon);
            if (unpredictable === null) unpredictable = true;
            if (unpredictable) this.currOtherMonIndex = this.UNKNOWN_MON_INDEX;
        }
        if (opponentIsMove) {
            let unpredictable = this.isMoveUnpredictable(lastTurnOtherMon, opponentMoveIndex, this.otherPokemon);
            if (unpredictable === null) unpredictable = true;
            if (unpredictable) this.currOwnMonIndex = this.UNKNOWN_MON_INDEX;
        }

        if (this.checks.doSanityChecks && this.verbose) {
            if (lastTurnOtherMon !== this.currOtherMonIndex && this.currOtherMonIndex === this.UNKNOWN_MON_INDEX) {
                this.log("Warning! Temporarily impossible to verify the moves used by the opponent!");
            }
            if (lastTurnOtherMon !== this.currOtherMonIndex && lastTurnOtherMon === this.UNKNOWN_MON_INDEX) {
                this.log("It is now possible to verify the moves used by the opponent!");
            }
        }
    }

    // ==================== WAIT PRIMITIVES (faithful ports) ====================

    /**
     * Python wait_for_set_of_values: a value only counts once it repeats for
     * threshold consecutive reads. threshold 0 = accept the first hit
     * (including 0x00 when breakOnNoData).
     */
    async waitForSetOfValues(next, values, breakOnNoData = false, threshold = null) {
        let foundVal = next;
        let consecutiveReads = 0;
        let specialMode = false;
        if (threshold === null) threshold = this.OPTION_CONFIRMATION_THRESHOLD;
        if (threshold === 0) {
            threshold = 1;
            specialMode = true;
        }
        while (consecutiveReads < threshold && !this.stopTrade) {
            next = await this.exchangeByte(this.NO_INPUT);
            const doCheck = values.has(next) || (breakOnNoData && next === this.NO_DATA);
            if (doCheck) {
                if (next === foundVal) consecutiveReads++;
                else consecutiveReads = 0;
                if (specialMode) consecutiveReads = threshold;
            } else {
                consecutiveReads = 0;
            }
            foundVal = next;
            await this.sleep(20);
        }
        return next;
    }

    /**
     * Python timed_wait_for_set_of_values. Note the threshold-0 special mode
     * differs from the untimed one: instant accept only for in-set values.
     */
    async timedWaitForSetOfValues(next, values, { timeoutMs = 1000, breakOnNoData = false, threshold = null } = {}) {
        const start = Date.now();
        let foundVal = next;
        let consecutiveReads = 0;
        let specialMode = false;
        if (threshold === null) threshold = this.OPTION_CONFIRMATION_THRESHOLD;
        if (threshold === 0) {
            threshold = this.OPTION_CONFIRMATION_THRESHOLD;
            specialMode = true;
        }
        while (consecutiveReads < threshold && !this.stopTrade) {
            next = await this.exchangeByte(this.NO_INPUT);
            const doCheck = values.has(next) || (breakOnNoData && next === this.NO_DATA);
            if (doCheck) {
                if (next === foundVal) consecutiveReads++;
                else consecutiveReads = 0;
                if (specialMode && values.has(next)) consecutiveReads = threshold;
            } else {
                consecutiveReads = 0;
            }
            foundVal = next;
            if (Date.now() - start >= timeoutMs) break;
            await this.sleep(20);
        }
        return next;
    }

    async waitForBattleChoice(next, breakOnNoData = false) {
        return this.waitForSetOfValues(next, this.POSSIBLE_INDEXES, breakOnNoData);
    }

    async timedWaitForBattleChoice(next, opts = {}) {
        return this.timedWaitForSetOfValues(next, this.POSSIBLE_INDEXES, opts);
    }

    /**
     * Python timed_wait_for_no_input (ignores the passed value on entry).
     */
    async timedWaitForNoInput(next, timeoutMs = 1000) {
        next = this.NO_INPUT + 1;
        const start = Date.now();
        while (next !== this.NO_INPUT && !this.stopTrade) {
            next = await this.exchangeByte(this.NO_INPUT);
            if (Date.now() - start >= timeoutMs) break;
            await this.sleep(20);
        }
        return next;
    }

    async getUserChoice() {
        return this.waitForBattleChoice(this.NO_INPUT, true);
    }

    // ==================== PER-TURN CHOICE EXCHANGE ====================

    sendChosenOption(choice) {
        if (this.ownCounterId === undefined) {
            this.ownCounterId = Math.floor(Math.random() * 256);
        }
        this.ws.sendData(this.MSG_CHC, new Uint8Array([this.ownCounterId, choice]));
        this.ownCounterId = (this.ownCounterId + 1) % 256;
    }

    /**
     * Python GSCBattlingClient.get_chosen_option: the opponent's choice with a
     * validity flag from the move/mon sanity checks. Invalid only warns
     * (matching the reference), it does not end the battle.
     */
    async getChosenOption() {
        const data = await this.getCounterMessage(this.MSG_CHC);
        if (!data || data.length < 2) return null;
        const choice = data[1];
        let valid = true;
        if (!this.isChoiceStop(choice)) {
            const isMove = this.isChoiceMove(choice);
            const isMon = this.isChoiceMon(choice);
            if (this.checks.doSanityChecks && isMove) {
                valid = this.isMoveUsable(this.currOtherMonIndex, this.convertChoiceMove(choice), this.otherPokemon);
            }
            if (this.checks.doSanityChecks && isMon) {
                valid = this.isMonUsable(this.convertChoiceMon(choice), this.otherPokemon);
            }
        }
        return [choice, valid];
    }

    // ==================== BATTLE END DETECTION ====================

    /**
     * In Gen 2, the sit byte doubles as "switch to party mon 2", so a
     * timed probe decides between a regular turn and a battle restart.
     */
    couldBattleHaveEnded(sentChoice, receivedChoice) {
        const sitSet = this.START_TRADING_STATES[1][0];
        return sitSet.has(sentChoice) && sitSet.has(receivedChoice);
    }

    async hasBattleEnded(sentChoice, receivedChoice) {
        if (!this.couldBattleHaveEnded(sentChoice, receivedChoice)) return false;
        const endStates = this.getBattleEndStartTradingStates();
        const next = await this.timedWaitForSetOfValues(this.NO_INPUT, endStates);
        return endStates.has(next);
    }

    getBattleEndStartTradingStates() {
        return new Set([this.START_TRADING_STATES[0][2]]);
    }

    handleBattleEndedToNew() {
        this.initialSitPosition = 2;
    }

    async endBattle() {
        let next = this.STOP_BATTLE;
        while (next !== this.NO_DATA && !this.stopTrade) {
            next = await this.exchangeByte(this.STOP_BATTLE);
            await this.sleep(20);
        }
    }

    // ==================== INTER-TURN WAIT (UI adaptation of ENTER-skip) ====================

    async waitBeforeTurn(seconds) {
        if (!seconds || seconds <= 0) return;
        this.log(`Waiting ${Math.round(seconds)} seconds before checking for the next user input (skippable)...`);
        this.onTurnWait?.(seconds);
        await new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                clearInterval(poll);
                this._turnWaitResolve = null;
                resolve();
            };
            const timer = setTimeout(finish, seconds * 1000);
            const poll = setInterval(() => {
                if (this.stopTrade) finish();
            }, 250);
            this._turnWaitResolve = finish;
        });
        this.onTurnWaitEnd?.();
    }

    skipTurnWait() {
        this._turnWaitResolve?.();
    }

    // ==================== THE PER-TURN LOOP ====================

    /**
     * Python do_battle (2-player path).
     */
    async doBattle(close = false) {
        this.initialSitPosition = 0;
        let battleCompleted = false;
        this.currOwnMonIndex = 0;
        this.currOtherMonIndex = 0;

        if (close) {
            this.log("Closing the battle...");
        } else {
            this.onStatus?.('In battle');
        }
        let next = this.NO_INPUT;
        while (!battleCompleted && !this.stopTrade) {
            // Re-arm the inter-turn lock unless part of the window already
            // elapsed elsewhere (the BFL exchange runs under it)
            let timeToWait = this.getLockSwapRemainingTime();
            if (this.isLockSwapStopped()) {
                timeToWait = this.battleTurnTimeS;
                if (this.canDropCommands) {
                    this.startLockSwap(timeToWait);
                }
            }
            if (!this.canDropCommands) {
                timeToWait = 0;
            }
            await this.waitBeforeTurn(timeToWait);
            this.stopLockSwap();
            if (this.stopTrade) break;

            this.log("Now reading user input...");
            const sentChoice = await this.getUserChoice();

            if (sentChoice === this.NO_DATA) {
                this.log("Player stopped sending data - closing the battle.");
                close = true;
            }

            let receivedChoice;
            if (!close) {
                this.sendChosenOption(sentChoice);
                this.log("Waiting for the other player's choice...");
                const receivedData = await this.getChosenOption();
                if (!receivedData) break;
                receivedChoice = receivedData[0];
                if (!receivedData[1]) {
                    this.log("[WARN] Issue detected with the command sent by the other player!");
                }
            } else {
                this.resetTrade();
                receivedChoice = this.STOP_BATTLE;
            }

            // The battle may have ended with one player slower to rematch
            if (this.couldBattleHaveEnded(sentChoice, receivedChoice)) {
                const resentChoice = await this.timedWaitForBattleChoice(next, { breakOnNoData: true, threshold: 0 });
                let toClose = false;
                if (resentChoice === this.NO_DATA) {
                    this.log("Player stopped sending data - closing the battle.");
                    toClose = true;
                } else if (resentChoice === this.NO_INPUT) {
                    toClose = true;
                } else if (resentChoice !== sentChoice) {
                    this.log("[WARN] Issue detected with the command sent by the player!");
                    toClose = true;
                }
                if (toClose) {
                    battleCompleted = true;
                    this.exitOrNew = true;
                    this.log("Battle closed.");
                    continue;
                }
            }

            if (!this.isChoiceStop(receivedChoice) && !this.isChoiceStop(sentChoice)) {
                // Hand the opponent's action to the game
                next = await this.exchangeByte(receivedChoice);
                next = await this.waitForNoData(next, receivedChoice, this.RESENDS_LIMIT_TRADE);
                if (next === this.NO_DATA) {
                    next = await this.timedWaitForNoInput(next);
                }

                this.updateBattleInformation(sentChoice, receivedChoice);

                // Both players may be starting a new battle right away
                if (await this.hasBattleEnded(sentChoice, receivedChoice)) {
                    this.handleBattleEndedToNew();
                    battleCompleted = true;
                    this.exitOrNew = true;
                    this.log("Battle closed.");
                }
            } else {
                if (close || (this.isChoiceStop(sentChoice) && this.isChoiceStop(receivedChoice))) {
                    battleCompleted = true;
                    this.exitOrNew = true;
                    this.log("Battle closed.");
                    await this.endBattle();
                } else if (receivedChoice !== this.NO_DATA) {
                    // One-sided flee: the last exchange decides win/loss/draw
                    next = await this.exchangeByte(receivedChoice);
                    next = await this.waitForNoData(next, receivedChoice, this.RESENDS_LIMIT_TRADE);
                    if (next === this.NO_DATA) {
                        next = await this.waitForNoInput(next);
                    }
                    battleCompleted = true;
                    this.exitOrNew = true;
                    this.log("Battle closed.");
                }
            }
        }
    }

    // ==================== RESETS ====================

    resetTrade() {
        this.ownPokemon = null;
        this.otherPokemon = null;
        this.peerPartyData = null;
        this.peerPatchData = null;
    }

    resetBigTradingData() {
        delete this.ws.sendDict[this.MSG_FLL];
        delete this.ws.recvDict[this.MSG_FLL];
        this.bufferedOtherData = null;
        this.hasGhosted = false;
    }

    // ==================== SESSION ENTRY ====================

    // AppUI drives every protocol through startTrade() (Python player_trade
    // -> player_battle rename trick)
    async startTrade() {
        return this.startBattle();
    }

    /**
     * Python player_battle.
     */
    async startBattle() {
        this.log(`Starting ${this.GEN_NAME} Battle Protocol (${this.isBuffered ? 'buffered' : 'sync'}, sanity checks: ${this.doSanityChecks})...`);

        await this.loadBattleData();

        this.exitOrNew = true;
        this.initialSitPosition = 0;
        this.stopLockSwap();
        this.resetTrade();
        this.isVersionCheckDone = false;
        this.hasGhosted = false;

        // 4.1 behavior: send the client version immediately; the check itself
        // runs after the reseed ack (Python post_buffered_negotiation_init)
        this.ws.sendData(this.MSG_VEC, this.versionData());

        // Pre-populate + early-send the buffered preference so the peer's
        // negotiator GET is always answerable (same prelude as the trades)
        if (this.ownCounterId === undefined) {
            this.ownCounterId = Math.floor(Math.random() * 256);
        }
        const ourMode = this.isBuffered ? 0x85 : 0x12;
        const bufPacket = new Uint8Array([this.ownCounterId, ourMode]);
        this.ws.sendDict[this.MSG_BUF] = bufPacket;
        this.ws.sendData(this.MSG_BUF, bufPacket);
        this.ownCounterId = (this.ownCounterId + 1) % 256;

        let negotiationPromise = null;
        if (!this.initialNegotiationDone) {
            negotiationPromise = (async () => {
                await this.waitForPeer();
                await this.completeBufferedNegotiation();
                await this.postBufferedNegotiationInit();
                this.initialNegotiationDone = true;
            })();
            // Surfaced when awaited in the loop below
            negotiationPromise.catch(() => {});
        }

        await this.enterRoom();

        while (!this.stopTrade) {
            try {
                if (!(await this.sitToTable(this.initialSitPosition))) {
                    this.log("Player left the battle room. Exiting...");
                    break;
                }
                if (this.stopTrade) break;

                if (negotiationPromise) {
                    this.log("Waiting for mode negotiation and the server handshake...");
                    const pending = negotiationPromise;
                    negotiationPromise = null;
                    // Python force_receive: keep the console clock running
                    // while the negotiation thread finishes
                    let negotiationSettled = false;
                    let negotiationError = null;
                    pending.then(
                        () => { negotiationSettled = true; },
                        (e) => { negotiationSettled = true; negotiationError = e; }
                    );
                    while (!negotiationSettled && !this.stopTrade) {
                        await this.exchangeByte(this.NO_INPUT);
                        await this.sleep(20);
                    }
                    if (negotiationError) throw negotiationError;
                    if (this.stopTrade) break;
                    this.log(`Negotiation complete. Mode: ${this.isBuffered ? 'Buffered' : 'Sync'}`);
                }

                const valid = this.isBuffered
                    ? await this.bufferedBattle()
                    : await this.synchronousBattle();
                if (this.stopTrade) break;

                if (valid) {
                    // Gen 2 games start animating right after the exchange -
                    // suspend polling for the whole turn window
                    if (this.canDropCommands) {
                        this.startLockSwap(this.battleTurnTimeS);
                    }
                    this.sendBigBattleTradingData();
                    const otherFull = await this.getBigBattleTradingData();
                    if (!otherFull) break;
                    if (!this.verifyBattleData(otherFull)) {
                        this.log("[ERROR] ERROR WITH OTHER PLAYER'S DATA! SOMETHING CHANGED! ABORTING BATTLE!");
                        if (!this.isBuffered) {
                            this.log("If this keeps happening, try enabling Buffered mode.");
                        }
                        this.onStatus?.("Other player's data changed — battle aborted", 'error');
                        break;
                    }
                }

                await this.doBattle(!valid);
                this.stopLockSwap();

                if (valid && !this.stopTrade) {
                    this.resetBigTradingData();
                    this.resetTrade();
                    // Fresh server seed for the next battle
                    if (!(await this.waitForReseed(true))) break;
                }
            } catch (error) {
                this.log(`[ERROR] Battle error: ${error.message}`);
                console.error(error);
                break;
            }
        }

        this.stopLockSwap();
        this.log("Battle session ended.");
    }
}
