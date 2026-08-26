/**
 * RBYBattling.js - Gen 1 (Red/Blue/Yellow) link battles.
 *
 * Extends GSCBattling (not RBYTrading), so the gen 1 tags, state tables,
 * section lengths and choice bytes are re-declared here.
 * Gen 1 differences: no inter-turn polling suspension (canDropCommands=false),
 * a 0x6D "no move possible" choice (Wrap/Bind), no unpredictable moves, the
 * ghost party gets healed, and the battle-end probe waits for 0xFD.
 */

import { GSCBattling } from './GSCBattling.js?v=91';
import { RBYUtils } from './RBYUtils.js?v=91';
import { RBYTradingData, RBYChecks } from './RBYTradingDataUtils.js?v=91';
import { DefaultNames } from './DefaultNames.js?v=91';

export class RBYBattling extends GSCBattling {
    constructor(usb, ws, logger, tradeType = 'battle', isBuffered = false, doSanityChecks = true, options = {}) {
        super(usb, ws, logger, tradeType, isBuffered, doSanityChecks, options);

        // ==================== RBY BATTLE STATE MACHINES ====================
        // 0xD1 = fight table (0xD0 is the trade table)
        this.ENTER_ROOM_STATES = [
            [0x01, 0x60, 0xD1, 0xD5],
            [
                new Set([0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x6F]),
                new Set([0xD0, 0xD1, 0xD2, 0xD3, 0xD4]),
                new Set([0xD0, 0xD1, 0xD2, 0xD3, 0xD4]),
                new Set(Array.from({ length: 0x10 }, (_, i) => 0x60 + i))
            ]
        ];
        this.START_TRADING_STATES = [
            [0x60, 0x60],
            [
                new Set(Array.from({ length: 0x10 }, (_, i) => 0x60 + i)),
                new Set([0xFD])
            ]
        ];

        this.SPECIAL_SECTIONS_LEN = [0xA, 0x1A2, 0xC5];
        this.SPECIAL_SECTIONS_PREAMBLE_LEN = [7, 6, 3];
        this.SECTION_NAMES = ['Random data', 'Party data', 'Patch data'];

        this.SECTION_FILLERS = [{}, {}, {}];
        this.EXTRA_SECTION_DROPS = [0, 0, 0];
        if (this.isJapanese) {
            const fillers = {};
            fillers[6] = [5, 0x50]; // trainer name
            for (let i = 0; i < 12; i++) { // 6 OT names + 6 nicknames
                fillers[0x121 + i * 0x0B] = [5, 0x50];
            }
            this.SECTION_FILLERS[1] = fillers;
        }

        // ==================== RBY BATTLE MENU BYTES ====================
        this.STOP_BATTLE = 0x6F;
        this.FIRST_BATTLE_INDEX = 0x60;
        this.MOVE_START_INDEX = 0x60;   // 0x60-0x63 = moves 1-4
        this.MON_START_INDEX = 0x64;    // 0x64-0x69 = party mons 1-6
        this.NO_MOVE_INDEX = 0x6D;      // "no move possible" (Wrap/Bind etc.)
        this.STRUGGLE_INDEX = 0x6E;
        this.CHOICE_NO_MOVE_ID = 0xFE;
        this.POSSIBLE_INDEXES = new Set();
        for (let i = 0x60; i < 0x70; i++) {
            this.POSSIBLE_INDEXES.add(i);
        }

        this.canDropCommands = false;
        this.healAfterNotValidBuffered = true;
        this.TIMEOUT_USER_CHOICE_NO_DATA_MS = 6000;

        this.checks = new RBYChecks(this.SPECIAL_SECTIONS_LEN, doSanityChecks);
        this.jpMailConverter = null;
    }

    // ==================== RBY MESSAGE TAGS ====================
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
    get MSG_BFL() { return "BFL1"; }
    get MSG_RSS() { return "RSS1"; }
    get MSG_TST() { return "TST1"; }

    get BASE_BATTLE_PATH() { return '/data/rby/base_battle.bin'; }

    get utilsClass() { return RBYUtils; }

    get GEN_NAME() { return 'RBY'; }

    get nameUtilsClass() { return RBYUtils; }

    get NAME_LAYOUT() {
        return { gen: 1, nicknamePos: 0x15D, otPos: 0x11B, speciesListPos: 0x0C, partySizePos: 0x0B, nameLength: 0x0B, trainerNamePos: 0x00 };
    }

    createPartyReader(partyBytes) {
        return new RBYTradingData(partyBytes);
    }

    async loadBattleData() {
        if (this.doSanityChecks && this.checks.load) {
            await this.checks.load();
        }
        // RBYUtils inherits the gen 2 PP table, so the gen 1 one must
        // be loaded onto it explicitly before healing
        if (!Object.prototype.hasOwnProperty.call(RBYUtils, 'movesPpList') || !RBYUtils.movesPpList) {
            RBYUtils.movesPpList = await RBYUtils.loadBinaryFile('moves_pp_list.bin');
        }
        if (this.defaultReceivedNames) await DefaultNames.load();
        await this.loadBattleBaseData();
    }

    /**
     * On no-data, give the game a 6s window to come back before treating
     * it as the player closing the battle.
     */
    async getUserChoice() {
        while (!this.stopTrade) {
            let sentChoice = await this.waitForBattleChoice(this.NO_INPUT, true);
            if (sentChoice !== this.NO_DATA) {
                return sentChoice;
            }
            sentChoice = await this.timedWaitForNoInput(this.NO_INPUT, this.TIMEOUT_USER_CHOICE_NO_DATA_MS);
            if (sentChoice === this.NO_DATA) {
                return this.NO_DATA;
            }
        }
        return this.NO_DATA;
    }

    isChoiceMove(choice) {
        if (choice === this.NO_MOVE_INDEX) return true;
        return super.isChoiceMove(choice);
    }

    convertChoiceMove(choice) {
        if (choice === this.NO_MOVE_INDEX) return this.CHOICE_NO_MOVE_ID;
        return super.convertChoiceMove(choice);
    }

    isMoveUnpredictable(mon, moveIndex, battleData) {
        // No unpredictable moves in RBY
        return false;
    }

    isMoveUsable(mon, moveIndex, battleData) {
        // Doing nothing is always possible (caused by moves like Wrap)
        if (moveIndex === this.CHOICE_NO_MOVE_ID) return true;
        return super.isMoveUsable(mon, moveIndex, battleData);
    }

    getBattleEndStartTradingStates() {
        return this.START_TRADING_STATES[1][1];
    }

    handleBattleEndedToNew() {
        this.initialSitPosition = 1;
    }
}
