/**
 * GSCTradingData - Party data structure for GSC trading.
 * Based on ref. impl's GSCTradingData class.
 * 
 * Handles party-level operations including:
 * - Party parsing and construction
 * - Evolution handling
 * - Trading between parties
 * - Data export for hardware
 */
import { GSCUtils } from './GSCUtils.js?v=88';
import { GSCPokemonInfo } from './GSCPokemonInfo.js?v=88';

/**
 * Simple text holder class (matches ref. impl's GSCTradingText)
 */
export class GSCTradingText {
    constructor(data, start, length = 0x0B) {
        this.values = new Uint8Array(data.slice(start, start + length));
    }

    valuesEqual(other) {
        if (!other || this.values.length !== other.length) return false;
        for (let i = 0; i < this.values.length; i++) {
            if (this.values[i] !== other[i]) return false;
        }
        return true;
    }
}

/**
 * Party info holder (matches ref. impl's GSCTradingPartyInfo) 
 */
export class GSCTradingPartyInfo {
    static MAX_PARTY_MONS = 6;

    constructor(data, start) {
        this.total = data[start];
        if (this.total <= 0 || this.total > 6) {
            this.total = 1;
        }
        // Copy species list (6 entries after count byte)
        this.actualMons = new Uint8Array(data.slice(start + 1, start + 1 + GSCTradingPartyInfo.MAX_PARTY_MONS));
    }

    getId(pos) {
        if (pos < 0 || pos >= GSCTradingPartyInfo.MAX_PARTY_MONS) return 0;
        return this.actualMons[pos];
    }

    setId(pos, val) {
        if (pos >= 0 && pos < GSCTradingPartyInfo.MAX_PARTY_MONS) {
            this.actualMons[pos] = val & 0xFF;
        }
    }

    getTotal() {
        return this.total;
    }
}

/**
 * Main trading data class for party operations.
 */
export class GSCTradingData {
    // Section offsets
    static TRADER_NAME_POS = 0;
    static TRADING_PARTY_INFO_POS = 0x0B;
    static TRADING_PARTY_FINAL_POS = 0x12;
    static TRADER_INFO_POS = 0x13;
    static TRADING_POKEMON_POS = 0x15;
    static TRADING_POKEMON_OT_POS = 0x135;
    static TRADING_POKEMON_NICKNAME_POS = 0x177;
    static TRADING_POKEMON_MAIL_POS = 0;
    static TRADING_POKEMON_MAIL_SENDER_POS = 0xC6;

    // Data lengths
    static TRADING_POKEMON_LENGTH = 0x30;   // 48
    static TRADING_NAME_LENGTH = 0x0B;      // 11
    static TRADING_MAIL_LENGTH = 0x21;      // 33
    static TRADING_MAIL_SENDER_LENGTH = 0x0E; // 14

    // Section lengths
    static SECTION_LENGTHS = [0x0A, 0x1BC, 0xC5, 0x181];

    /**
     * Create trading data from raw section data.
     * @param {Uint8Array} dataPokemon - Section 1 data (Pokemon/party)
     * @param {Uint8Array|null} dataMail - Section 3 data (Mail), optional
     * @param {boolean} doFull - Parse full Pokemon data
     */
    constructor(dataPokemon, dataMail = null, doFull = true) {
        this.trader = new GSCTradingText(dataPokemon, GSCTradingData.TRADER_NAME_POS);
        this.partyInfo = new GSCTradingPartyInfo(dataPokemon, GSCTradingData.TRADING_PARTY_INFO_POS);
        this.trainerInfo = this.readShort(dataPokemon, GSCTradingData.TRADER_INFO_POS);
        this.pokemon = [];

        if (doFull) {
            for (let i = 0; i < this.getPartySize(); i++) {
                const mon = new GSCPokemonInfo(
                    dataPokemon,
                    GSCTradingData.TRADING_POKEMON_POS + i * GSCTradingData.TRADING_POKEMON_LENGTH
                );
                mon.addOtName(
                    dataPokemon,
                    GSCTradingData.TRADING_POKEMON_OT_POS + i * GSCTradingData.TRADING_NAME_LENGTH
                );
                mon.addNickname(
                    dataPokemon,
                    GSCTradingData.TRADING_POKEMON_NICKNAME_POS + i * GSCTradingData.TRADING_NAME_LENGTH
                );

                if (dataMail && mon.hasMail()) {
                    mon.addMail(
                        dataMail,
                        GSCTradingData.TRADING_POKEMON_MAIL_POS + i * GSCTradingData.TRADING_MAIL_LENGTH
                    );
                    mon.addMailSender(
                        dataMail,
                        GSCTradingData.TRADING_POKEMON_MAIL_SENDER_POS + i * GSCTradingData.TRADING_MAIL_SENDER_LENGTH
                    );
                }
                this.pokemon.push(mon);
            }
        }
    }

    // ==================== PARTY INFO ====================

    getPartySize() {
        return this.partyInfo.getTotal();
    }

    getLastMonIndex() {
        return this.getPartySize() - 1;
    }

    /**
     * Check if any Pokemon in party has mail.
     */
    partyHasMail() {
        for (let i = 0; i < this.getPartySize(); i++) {
            if (this.monHasMail(i)) return true;
        }
        return false;
    }

    monHasMail(pos) {
        if (pos < 0 || pos >= this.getPartySize()) return false;
        return this.pokemon[pos].hasMail();
    }

    isMonEgg(pos) {
        if (pos < 0 || pos >= this.getPartySize()) return false;
        return this.partyInfo.getId(pos) === GSCUtils.EGG_ID;
    }

    /**
     * Search for a Pokemon in the party.
     * @returns {number|null} Index if found, null otherwise
     */
    searchForMon(mon, isEgg) {
        // Strong comparison first
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(this.pokemon[i]) && this.isMonEgg(i) === isEgg) {
                return i;
            }
        }
        // Weak comparison fallback
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(this.pokemon[i], true) && this.isMonEgg(i) === isEgg) {
                return i;
            }
        }
        return null;
    }

    // ==================== EVOLUTION ====================

    /**
     * Execute evolution procedure.
     */
    evolutionProcedure(pos, evolution) {
        if (!this.pokemon[pos].isNicknamed()) {
            const newName = GSCUtils.getPokemonName(evolution);
            if (newName) {
                this.pokemon[pos].nickname = new Uint8Array(newName);
            }
        }
        this.pokemon[pos].setSpecies(evolution);
        this.partyInfo.setId(pos, this.pokemon[pos].getSpecies());
        this.pokemon[pos].updateStats();
    }

    /**
     * Evolve a Pokemon if applicable.
     * @returns {boolean|null} null = no evolution, false = evolved (no input needed), true = evolved (input needed)
     */
    evolveMon(pos) {
        if (pos < 0 || pos >= this.getPartySize()) return null;

        const mon = this.pokemon[pos];
        const evolution = GSCUtils.getEvolution(mon.getSpecies(), mon.getItem());

        if (evolution === null || this.isMonEgg(pos)) {
            return null;
        }

        // Clear evolution item if one was used
        const evoItem = GSCUtils.getEvolutionItem(mon.getSpecies());
        if (evoItem !== null) {
            mon.setItem(0);
        }

        this.evolutionProcedure(pos, evolution);

        // Check for learnable moves
        const currLearning = mon.learnableMoves();
        if (currLearning) {
            for (const move of currLearning) {
                if (!mon.hasMove(move)) {
                    const freeSlots = mon.freeMoveSlots();
                    if (freeSlots.length > 0) {
                        mon.setMove(freeSlots[0], move);
                    } else {
                        // Need player input to choose move
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Check if Pokemon requires special handling.
     */
    requiresInput(pos, specialMonsSet) {
        const evoResult = this.evolveMon(pos);
        if (evoResult !== null) return evoResult;
        return this.isSpecialMon(pos, specialMonsSet);
    }

    isSpecialMon(pos, specialMonsSet) {
        if (pos < 0 || pos >= this.getPartySize()) return false;
        return specialMonsSet.has(this.pokemon[pos].getSpecies());
    }

    // ==================== TRADING ====================

    /**
     * Get which Pokemon were traded (species IDs).
     */
    getTradedMons(other) {
        return [
            this.pokemon[this.getLastMonIndex()].getSpecies(),
            other.pokemon[other.getLastMonIndex()].getSpecies()
        ];
    }

    /**
     * Move a Pokemon to the end of the party.
     */
    reorderParty(tradedPos) {
        if (tradedPos < 0 || tradedPos >= this.getPartySize()) return;

        const paInfo = this.partyInfo.getId(tradedPos);
        const poData = this.pokemon[tradedPos];

        // Shift everything down
        for (let i = tradedPos + 1; i < this.getPartySize(); i++) {
            this.partyInfo.setId(i - 1, this.partyInfo.getId(i));
            this.pokemon[i - 1] = this.pokemon[i];
        }

        // Put traded mon at end
        this.partyInfo.setId(this.getLastMonIndex(), paInfo);
        this.pokemon[this.getLastMonIndex()] = poData;
    }

    /**
     * Execute a trade between two parties.
     */
    tradeMon(other, ownIndex, otherIndex, checks) {
        // Prepare checks
        if (checks) {
            checks.resetState();
        }

        // Reorder both parties (move traded mon to end)
        this.reorderParty(ownIndex);
        other.reorderParty(otherIndex);

        // Swap the Pokemon
        const temp = this.pokemon[this.getLastMonIndex()];
        this.pokemon[this.getLastMonIndex()] = other.pokemon[other.getLastMonIndex()];
        other.pokemon[other.getLastMonIndex()] = temp;

        // Swap party info IDs
        const tempId = this.partyInfo.getId(this.getLastMonIndex());
        this.partyInfo.setId(this.getLastMonIndex(), other.partyInfo.getId(other.getLastMonIndex()));
        other.partyInfo.setId(other.getLastMonIndex(), tempId);
    }

    // ==================== DATA EXPORT ====================

    /**
     * Create trading data arrays for hardware.
     * @returns {Uint8Array[]} [randomSection, pokemonSection, patchSection, mailSection]
     */
    createTradingData() {
        const lengths = GSCTradingData.SECTION_LENGTHS;
        const data = [
            new Uint8Array(lengths[0]),
            new Uint8Array(lengths[1]),
            new Uint8Array(lengths[2]),
            GSCUtils.noMailSection ? new Uint8Array(GSCUtils.noMailSection) : new Uint8Array(lengths[3])
        ];

        // Section 1: Pokemon data
        // Trader name
        if (this.trader && this.trader.values) {
            data[1].set(this.trader.values, GSCTradingData.TRADER_NAME_POS);
        }

        // Party size
        data[1][GSCTradingData.TRADING_PARTY_INFO_POS] = this.getPartySize();

        // Species list
        if (this.partyInfo && this.partyInfo.actualMons) {
            data[1].set(this.partyInfo.actualMons, GSCTradingData.TRADING_PARTY_INFO_POS + 1);
        }

        // Party final byte
        data[1][GSCTradingData.TRADING_PARTY_FINAL_POS] = 0xFF;

        // Trainer info
        if (this.trainerInfo !== null) {
            this.writeShort(data[1], GSCTradingData.TRADER_INFO_POS, this.trainerInfo);
        }

        // Pokemon data
        for (let i = 0; i < this.getPartySize(); i++) {
            const mon = this.pokemon[i];

            // Pokemon struct
            data[1].set(mon.values, GSCTradingData.TRADING_POKEMON_POS + i * GSCTradingData.TRADING_POKEMON_LENGTH);

            // OT Name
            if (mon.otName) {
                data[1].set(mon.otName, GSCTradingData.TRADING_POKEMON_OT_POS + i * GSCTradingData.TRADING_NAME_LENGTH);
            }

            // Nickname
            if (mon.nickname) {
                data[1].set(mon.nickname, GSCTradingData.TRADING_POKEMON_NICKNAME_POS + i * GSCTradingData.TRADING_NAME_LENGTH);
            }

            // Mail (Section 3)
            if (mon.mail) {
                data[3].set(mon.mail, GSCTradingData.TRADING_POKEMON_MAIL_POS + i * GSCTradingData.TRADING_MAIL_LENGTH);
            }
            if (mon.mailSender) {
                data[3].set(mon.mailSender, GSCTradingData.TRADING_POKEMON_MAIL_SENDER_POS + i * GSCTradingData.TRADING_MAIL_SENDER_LENGTH);
            }
        }

        // Create patches (Section 2)
        GSCUtils.createPatchesData(data[1], data[2], false);

        // Create mail patches (Section 3)
        if (this.partyHasMail()) {
            GSCUtils.createPatchesData(data[3], data[3], true);
        }

        return data;
    }

    // ==================== HELPERS ====================

    readShort(data, pos) {
        return (data[pos] << 8) | data[pos + 1];
    }

    writeShort(data, pos, val) {
        data[pos] = (val >> 8) & 0xFF;
        data[pos + 1] = val & 0xFF;
    }
}
