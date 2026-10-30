/**
 * RBYTradingDataUtils.js - Data structures for Gen 1 (RBY) Pokemon trading.
 * Extends the GSC structures with the Gen 1 layout (0x2C-byte Pokémon, no
 * mail, no eggs).
 */

import { RBYUtils } from './RBYUtils.js?v=103';
import { GSCTradingText, GSCTradingData } from './GSCTradingDataUtils.js?v=103';
import { GSCPokemonInfo } from './GSCPokemonInfo.js?v=103';
import { GSCUtilsMisc } from './GSCUtils.js?v=103';
import { RBYChecks } from './RBYChecks.js?v=103';

export { RBYChecks };

export class RBYTradingText extends GSCTradingText {
    getUtilsClass() {
        return RBYUtils;
    }
}

/**
 * RBY Pokemon info with Gen 1 specific structure (44 bytes vs 48 for GSC)
 */
export class RBYPokemonInfo extends GSCPokemonInfo {
    static POKEMON_DATA_LEN = 0x2C;
    static OT_NAME_LEN = 0x0B;
    static NICKNAME_LEN = 0x0B;
    static MAIL_LEN = 0;
    static SENDER_LEN = 0;

    static ITEM_POS = 7;
    static MOVES_POS = 8;
    static PPS_POS = 0x1D;
    static LEVEL_POS = 0x21;
    static EXP_POS = 0x0E;
    static CURR_HP_POS = 1;
    static STATS_POS = 0x22;
    static EVS_POS = 0x11;
    static IVS_POS = 0x1B;
    static STATUS_POS = 4;
    static REFERENCE_GEN = 1;

    static NO_MOVES_EQUALITY_RANGES = [[0, 3], [4, 8], [0x0C, 0x1D], [0x21, 0x2C]];
    static FULL_EQUALITY_RANGES = [[0, 0x2C]];
    static ALL_LENGTHS = [0x2C, 0xB, 0xB, 0, 0];

    // Older lowercase names
    static pokemon_data_len = 0x2C;
    static ot_name_len = 0x0B;
    static nickname_len = 0x0B;
    static mail_len = 0;
    static sender_len = 0;
    static item_pos = 7;
    static moves_pos = 8;
    static pps_pos = 0x1D;
    static level_pos = 0x21;
    static exp_pos = 0x0E;
    static curr_hp_pos = 1;
    static stats_pos = 0x22;
    static evs_pos = 0x11;
    static ivs_pos = 0x1B;
    static status_pos = 4;

    getUtilsClass() {
        return RBYUtils;
    }

    getTextClass() {
        return RBYTradingText;
    }

    setFriendship(val = null) {
    }

    setHatchingCycles(val = 1) {
    }

    getHatchingCycles() {
        return 0xFF;
    }

    addMail(data, start) {
    }

    addMailSender(data, start) {
    }

    hasMail() {
        return false;
    }

    static setData(data) {
        const mon = new RBYPokemonInfo(data, 0);
        mon.addOtName(data, mon.precalcedLengths[1]);
        mon.addNickname(data, mon.precalcedLengths[2]);
        return mon;
    }
}

/**
 * RBY Trading Data - Party structure for Gen 1
 */
export class RBYTradingData extends GSCTradingData {
    static TRADER_NAME_POS = 0;
    static TRADING_PARTY_INFO_POS = 0x0B;
    static TRADING_PARTY_FINAL_POS = 0x12;
    static TRADING_POKEMON_POS = 0x13;
    static TRADING_POKEMON_OT_POS = 0x11B;
    static TRADING_POKEMON_NICKNAME_POS = 0x15D;

    static TRADING_POKEMON_LENGTH = 0x2C;
    static TRADING_NAME_LENGTH = 0x0B;
    static TRADING_MAIL_LENGTH = 0;
    static TRADING_MAIL_SENDER_LENGTH = 0;

    // Random, party, patches
    static SECTION_LENGTHS = [0x0A, 0x1A2, 0xC5];
    static SECTION_LENGTHS_OLD = [0x0A, 0x1A2, 0xC5];

    constructor(dataPokemon, dataMail = null, doFull = true) {
        super(dataPokemon, null, doFull);
    }

    monGeneratorClass() {
        return RBYPokemonInfo;
    }

    textGenerator(data, pos, length = this.constructor.TRADING_NAME_LENGTH) {
        return new RBYTradingText(data, pos, length);
    }

    getTextClass() {
        return RBYTradingText;
    }

    trainerInfoGenerator(data, pos) {
        return null;
    }

    getUtilsClass() {
        return RBYUtils;
    }

    searchForMon(mon, isEgg) {
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(this.pokemon[i])) return i;
        }
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(this.pokemon[i], true)) return i;
        }
        return null;
    }

    isMonEgg(pos) {
        return false;
    }

    partyHasMail() {
        return false;
    }

    /**
     * @returns {boolean|null} null if it does not evolve; true when the
     * player's input is needed: Gen 1 -> Gen 2 can't predict the new moves,
     * and an Everstone only stops the Gen 1 side
     */
    evolveMon(pos, targetLanguage, ownLanguage) {
        if (this.isPosInvalid(pos)) return false;
        const mon = this.pokemon[pos];
        const evolution = this.utilsClass.getEvolution(mon.getSpecies(), mon.getItem());
        if (evolution === null) return null;
        if (evolution === mon.getSpecies()) return true;
        this.evolutionProcedure(pos, evolution, targetLanguage, ownLanguage);
        if (mon.learnableMoves() !== null) return true;
        return false;
    }

    /**
     * The sections for the hardware: [random, party, patches].
     */
    createTradingData(lengths = null) {
        const C = this.constructor;
        if (lengths === null) lengths = C.SECTION_LENGTHS;
        const data = [];
        for (let i = 0; i < 3; i++) data.push(new Array(lengths[i]).fill(0));
        GSCUtilsMisc.copyToData(data[1], C.TRADER_NAME_POS, this.trader.values, C.TRADING_NAME_LENGTH);
        GSCUtilsMisc.setItem(data[1], C.TRADING_PARTY_INFO_POS, this.getPartySize());
        GSCUtilsMisc.copyToData(data[1], C.TRADING_PARTY_INFO_POS + 1, this.partyInfo.actualMons);
        GSCUtilsMisc.setItem(data[1], C.TRADING_PARTY_FINAL_POS, 0xFF);
        for (let i = 0; i < this.getPartySize(); i++) {
            const mon = this.pokemon[i];
            GSCUtilsMisc.copyToData(data[1], C.TRADING_POKEMON_POS + (i * C.TRADING_POKEMON_LENGTH), mon.values);
            GSCUtilsMisc.copyToData(data[1], C.TRADING_POKEMON_OT_POS + (i * C.TRADING_NAME_LENGTH), mon.otName.values, C.TRADING_NAME_LENGTH);
            GSCUtilsMisc.copyToData(data[1], C.TRADING_POKEMON_NICKNAME_POS + (i * C.TRADING_NAME_LENGTH), mon.nickname.values, C.TRADING_NAME_LENGTH);
        }
        this.utilsClass.createPatchesData(data[1], data[2], false);
        return data;
    }
}

