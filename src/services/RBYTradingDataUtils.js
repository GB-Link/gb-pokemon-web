/**
 * RBYTradingDataUtils.js - Data structures for Gen 1 (RBY) Pokemon trading.
 * Extends GSC data structures with RBY-specific formats.
 */

import { RBYUtils } from './RBYUtils.js?v=88';
import { GSCTradingText, GSCTradingPartyInfo, GSCTradingData } from './GSCTradingDataUtils.js?v=88';
import { GSCPokemonInfo } from './GSCPokemonInfo.js?v=88';

/**
 * RBY Pokemon info with Gen 1 specific structure (44 bytes vs 48 for GSC)
 */
export class RBYPokemonInfo extends GSCPokemonInfo {
    // RBY Pokemon data is 44 bytes (0x2C) vs 48 bytes (0x30) for GSC
    static pokemon_data_len = 0x2C;
    static ot_name_len = 0x0B;
    static nickname_len = 0x0B;
    static mail_len = 0;       // No mail in Gen 1
    static sender_len = 0;

    // RBY-specific offsets
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

    constructor(data, start, length = RBYPokemonInfo.pokemon_data_len) {
        super(data, start, length);
    }

    /**
     * Gen 1 has no hatching cycles (no eggs)
     */
    setHatchingCycles(val = 1) {
        // No-op for Gen 1
    }

    getHatchingCycles() {
        return 0xFF; // Always return max (no eggs)
    }

    /**
     * Gen 1 has no mail
     */
    addMail(data, start) {
        // No-op for Gen 1
    }

    addMailSender(data, start) {
        // No-op for Gen 1
    }

    hasMail() {
        return false;
    }

    /**
     * Create RBY Pokemon from data
     */
    static setData(data) {
        const mon = new RBYPokemonInfo(data, 0);
        // OT name and nickname are at different offsets for RBY
        if (data.length >= RBYPokemonInfo.pokemon_data_len + RBYPokemonInfo.ot_name_len) {
            mon.addOtName(data, RBYPokemonInfo.pokemon_data_len);
        }
        if (data.length >= RBYPokemonInfo.pokemon_data_len + RBYPokemonInfo.ot_name_len + RBYPokemonInfo.nickname_len) {
            mon.addNickname(data, RBYPokemonInfo.pokemon_data_len + RBYPokemonInfo.ot_name_len);
        }
        return mon;
    }

    /**
     * Get Pokemon data as array for transmission
     */
    getData() {
        const dataLen = RBYPokemonInfo.pokemon_data_len +
            RBYPokemonInfo.ot_name_len +
            RBYPokemonInfo.nickname_len;
        const result = new Uint8Array(dataLen);

        // Copy Pokemon struct
        result.set(this.values.slice(0, RBYPokemonInfo.pokemon_data_len), 0);

        // Copy OT name
        if (this.otName) {
            result.set(this.otName, RBYPokemonInfo.pokemon_data_len);
        }

        // Copy nickname
        if (this.nickname) {
            result.set(this.nickname, RBYPokemonInfo.pokemon_data_len + RBYPokemonInfo.ot_name_len);
        }

        return result;
    }
}

/**
 * RBY Trading Data - Party structure for Gen 1
 */
export class RBYTradingData extends GSCTradingData {
    // RBY-specific positions
    static TRADER_NAME_POS = 0;
    static TRADING_PARTY_INFO_POS = 0x0B;
    static TRADING_PARTY_FINAL_POS = 0x12;
    static TRADING_POKEMON_POS = 0x13;
    static TRADING_POKEMON_OT_POS = 0x11B;
    static TRADING_POKEMON_NICKNAME_POS = 0x15D;

    // RBY data lengths
    static TRADING_POKEMON_LENGTH = 0x2C;   // 44 bytes
    static TRADING_NAME_LENGTH = 0x0B;      // 11 bytes
    static TRADING_MAIL_LENGTH = 0;         // No mail
    static TRADING_MAIL_SENDER_LENGTH = 0;

    // Section lengths: [Random, Pokemon, Patches]
    static SECTION_LENGTHS = [0x0A, 0x1A2, 0xC5];

    constructor(dataPokemon, dataMail = null, doFull = true) {
        // Don't call super with mail data since Gen 1 has no mail
        super(dataPokemon, null, doFull);
    }

    /**
     * Build Pokemon array for RBY (different offsets)
     */
    buildPokemonArray(dataPokemon, doFull) {
        this.pokemon = [];

        if (doFull) {
            for (let i = 0; i < this.getPartySize(); i++) {
                const mon = new RBYPokemonInfo(
                    dataPokemon,
                    RBYTradingData.TRADING_POKEMON_POS + i * RBYTradingData.TRADING_POKEMON_LENGTH
                );
                mon.addOtName(
                    dataPokemon,
                    RBYTradingData.TRADING_POKEMON_OT_POS + i * RBYTradingData.TRADING_NAME_LENGTH
                );
                mon.addNickname(
                    dataPokemon,
                    RBYTradingData.TRADING_POKEMON_NICKNAME_POS + i * RBYTradingData.TRADING_NAME_LENGTH
                );
                // No mail in Gen 1
                this.pokemon.push(mon);
            }
        }
    }

    /**
     * Search for a Pokemon - simplified for RBY (no egg check)
     */
    searchForMon(mon, isEgg) {
        // Gen 1 has no eggs, so ignore isEgg parameter
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(this.pokemon[i])) {
                return i;
            }
        }
        // Weak comparison fallback
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(this.pokemon[i], true)) {
                return i;
            }
        }
        return null;
    }

    /**
     * Is Pokemon an egg - always false for Gen 1
     */
    isMonEgg(pos) {
        return false;
    }

    /**
     * Party has mail - always false for Gen 1
     */
    partyHasMail() {
        return false;
    }

    /**
     * Create trading data arrays for hardware (3 sections for RBY)
     */
    createTradingData() {
        const lengths = RBYTradingData.SECTION_LENGTHS;
        const data = [
            new Uint8Array(lengths[0]),  // Random
            new Uint8Array(lengths[1]),  // Pokemon
            new Uint8Array(lengths[2])   // Patches
            // No mail section
        ];

        // Section 1: Pokemon data
        // Trader name
        if (this.trader && this.trader.values) {
            data[1].set(this.trader.values, RBYTradingData.TRADER_NAME_POS);
        }

        // Party size
        data[1][RBYTradingData.TRADING_PARTY_INFO_POS] = this.getPartySize();

        // Species list
        if (this.partyInfo && this.partyInfo.actualMons) {
            data[1].set(this.partyInfo.actualMons, RBYTradingData.TRADING_PARTY_INFO_POS + 1);
        }

        // Party final byte
        data[1][RBYTradingData.TRADING_PARTY_FINAL_POS] = 0xFF;

        // Pokemon data
        for (let i = 0; i < this.getPartySize(); i++) {
            const mon = this.pokemon[i];

            // Pokemon struct
            data[1].set(
                mon.values.slice(0, RBYTradingData.TRADING_POKEMON_LENGTH),
                RBYTradingData.TRADING_POKEMON_POS + i * RBYTradingData.TRADING_POKEMON_LENGTH
            );

            // OT Name
            if (mon.otName) {
                data[1].set(
                    mon.otName,
                    RBYTradingData.TRADING_POKEMON_OT_POS + i * RBYTradingData.TRADING_NAME_LENGTH
                );
            }

            // Nickname
            if (mon.nickname) {
                data[1].set(
                    mon.nickname,
                    RBYTradingData.TRADING_POKEMON_NICKNAME_POS + i * RBYTradingData.TRADING_NAME_LENGTH
                );
            }
        }

        // Create patches (Section 2)
        RBYUtils.createPatchesData(data[1], data[2], false);

        return data;
    }
}

/**
 * RBY Sanity Checks - Simplified for Gen 1 (no eggs, different species IDs)
 */
export class RBYChecks {
    static base_folder = "data/rby/";
    static rattata_id = 0xA5;  // Rattata in Gen 1 internal order
    static max_evs = 0xFFFF;
    static max_ivs = 0xF;      // DVs in Gen 1 are 0-15

    constructor(sectionSizes, doSanityChecks) {
        this.sectionSizes = sectionSizes;
        this.doSanityChecks = doSanityChecks;
    }

    /**
     * No eggs in Gen 1
     */
    isEgg() {
        return false;
    }

    /**
     * Load sanity check data files
     */
    async load() {
        // RBY sanity checks would be loaded here
        // For now, return true to indicate "loaded"
        return true;
    }

    /**
     * Reset state between trades
     */
    resetState() {
        // Reset any stateful check data
    }
}
