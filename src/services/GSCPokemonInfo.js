/**
 * GSCPokemonInfo - Pokemon data structure for GSC trading.
 * Based on reference's GSCTradingPokémonInfo class.
 * 
 * Handles individual Pokemon data manipulation including:
 * - Species, item, moves, level, stats
 * - Evolution, healing, fainting
 * - Mail attachment
 * - Data comparison for trade verification
 */
import { GSCUtils } from './GSCUtils.js?v=88';
import { GSCChecks } from './GSCChecks.js?v=88';

export class GSCPokemonInfo {
    // Data structure lengths
    static POKEMON_DATA_LEN = 0x30;  // 48 bytes
    static OT_NAME_LEN = 0x0B;       // 11 bytes
    static NICKNAME_LEN = 0x0B;      // 11 bytes
    static MAIL_LEN = 0x21;          // 33 bytes
    static SENDER_LEN = 0x0E;        // 14 bytes

    // Offsets within Pokemon data structure
    static SPECIES_POS = 0;
    static ITEM_POS = 1;
    static MOVES_POS = 2;
    static PPS_POS = 0x17;           // 23
    static LEVEL_POS = 0x1F;         // 31
    static EXP_POS = 8;
    static CURR_HP_POS = 0x22;       // 34
    static STATS_POS = 0x24;         // 36
    static EVS_POS = 0x0B;           // 11
    static IVS_POS = 0x15;           // 21
    static EGG_CYCLES_POS = 0x1B;    // 27
    static STATUS_POS = 0x20;        // 32

    // Free move value
    static FREE_VALUE_MOVES = 0x00;

    /**
     * Create a Pokemon info instance from data.
     * @param {Uint8Array} data - Source data array
     * @param {number} start - Starting offset in data
     * @param {number} length - Length of Pokemon data (default 48)
     */
    constructor(data, start, length = GSCPokemonInfo.POKEMON_DATA_LEN) {
        this.values = new Uint8Array(data.slice(start, start + length));
        this.otName = null;
        this.nickname = null;
        this.mail = null;
        this.mailSender = null;
    }

    // ==================== GETTERS/SETTERS ====================

    getSpecies() {
        return this.values[GSCPokemonInfo.SPECIES_POS];
    }

    setSpecies(val) {
        this.values[GSCPokemonInfo.SPECIES_POS] = val & 0xFF;
    }

    getItem() {
        return this.values[GSCPokemonInfo.ITEM_POS];
    }

    setItem(val = 0) {
        this.values[GSCPokemonInfo.ITEM_POS] = val & 0xFF;
    }

    getMove(pos) {
        return this.values[GSCPokemonInfo.MOVES_POS + pos];
    }

    setMove(pos, val, maxPp = true) {
        this.values[GSCPokemonInfo.MOVES_POS + pos] = val;
        if (maxPp && GSCUtils.movesPpList) {
            this.setPP(pos, GSCUtils.movesPpList[val] || 0);
        }
    }

    getPP(pos) {
        return this.values[GSCPokemonInfo.PPS_POS + pos];
    }

    setPP(pos, val) {
        this.values[GSCPokemonInfo.PPS_POS + pos] = val;
    }

    getLevel() {
        return this.values[GSCPokemonInfo.LEVEL_POS];
    }

    setLevel(val) {
        this.values[GSCPokemonInfo.LEVEL_POS] = val;
        // Set EXP to match level
        const exp = GSCUtils.getExpLevel(this.getSpecies(), val);
        this.setExp(exp);
        this.updateStats();
    }

    getExp() {
        const pos = GSCPokemonInfo.EXP_POS;
        return (this.values[pos] << 16) | (this.values[pos + 1] << 8) | this.values[pos + 2];
    }

    setExp(val) {
        const pos = GSCPokemonInfo.EXP_POS;
        this.values[pos] = (val >> 16) & 0xFF;
        this.values[pos + 1] = (val >> 8) & 0xFF;
        this.values[pos + 2] = val & 0xFF;
    }

    getHatchingCycles() {
        return this.values[GSCPokemonInfo.EGG_CYCLES_POS];
    }

    setHatchingCycles(val = 1) {
        this.values[GSCPokemonInfo.EGG_CYCLES_POS] = val;
    }

    // ==================== HP & STATS ====================

    getCurrHp() {
        return this.readShort(GSCPokemonInfo.CURR_HP_POS);
    }

    setCurrHp(val) {
        this.writeShort(GSCPokemonInfo.CURR_HP_POS, val);
    }

    getMaxHp() {
        return this.readShort(GSCPokemonInfo.STATS_POS);
    }

    getStat(index) {
        return this.readShort(GSCPokemonInfo.STATS_POS + (index * 2));
    }

    setStat(index, val) {
        this.writeShort(GSCPokemonInfo.STATS_POS + (index * 2), val);
    }

    getStatExp() {
        const ret = [0, 0, 0, 0, 0];
        for (let i = 0; i < 5; i++) {
            ret[i] = this.readShort(GSCPokemonInfo.EVS_POS + (i * 2));
        }
        return ret;
    }

    getIVs() {
        const ret = [0, 0, 0, 0];
        const byte1 = this.values[GSCPokemonInfo.IVS_POS];
        const byte2 = this.values[GSCPokemonInfo.IVS_POS + 1];

        // Nybbles: [ATK, DEF] from byte1, [SPD, SPC] from byte2
        ret[0] = (byte1 >> 4) & 0x0F;  // ATK
        ret[1] = byte1 & 0x0F;          // DEF
        ret[2] = (byte2 >> 4) & 0x0F;  // SPD
        ret[3] = byte2 & 0x0F;          // SPC
        return ret;
    }

    /**
     * Recalculate all stats after level/species change.
     */
    updateStats() {
        if (!GSCUtils.loaded) return;

        const oldMaxHp = this.getMaxHp();
        const oldCurrHp = this.getCurrHp();

        for (let i = 0; i < 6; i++) {
            const stat = GSCUtils.statCalculation(
                i,
                this.getSpecies(),
                this.getIVs(),
                this.getStatExp(),
                this.getLevel(),
                true
            );
            this.setStat(i, stat);
        }

        const newMaxHp = this.getMaxHp();
        // Adjust current HP proportionally
        let newCurrHp = oldCurrHp + (newMaxHp - oldMaxHp);
        newCurrHp = Math.max(0, Math.min(newCurrHp, newMaxHp));
        this.setCurrHp(newCurrHp);
    }

    heal() {
        this.setCurrHp(this.getMaxHp());
        this.values[GSCPokemonInfo.STATUS_POS] = 0;
    }

    faint() {
        this.setCurrHp(0);
        this.values[GSCPokemonInfo.STATUS_POS] = 0;
    }

    // ==================== MOVES ====================

    hasMoveIndex(move, start = 0) {
        for (let i = start; i < 4; i++) {
            if (this.getMove(i) === move) {
                return i;
            }
        }
        return 4; // Not found
    }

    hasMove(move) {
        return this.hasMoveIndex(move) !== 4;
    }

    freeMoveSlots() {
        const slots = [];
        for (let i = 0; i < 4; i++) {
            if (this.getMove(i) === GSCPokemonInfo.FREE_VALUE_MOVES) {
                slots.push(i);
            }
        }
        return slots;
    }

    /**
     * Get moves learnable at current level.
     */
    learnableMoves() {
        return GSCUtils.getLearnset(this.getSpecies(), this.getLevel());
    }

    // ==================== MAIL ====================

    hasMail() {
        return GSCUtils.isItemMail(this.getItem());
    }

    addOtName(data, start) {
        this.otName = new Uint8Array(data.slice(start, start + GSCPokemonInfo.OT_NAME_LEN));
    }

    addNickname(data, start) {
        this.nickname = new Uint8Array(data.slice(start, start + GSCPokemonInfo.NICKNAME_LEN));
    }

    addMail(data, start) {
        this.mail = new Uint8Array(data.slice(start, start + GSCPokemonInfo.MAIL_LEN));
    }

    addMailSender(data, start) {
        this.mailSender = new Uint8Array(data.slice(start, start + GSCPokemonInfo.SENDER_LEN));
    }

    isNicknamed() {
        if (!this.nickname || !GSCUtils.pokemonNames) return false;
        const defaultName = GSCUtils.getPokemonName(this.getSpecies());
        if (!defaultName) return false;
        return !this.arraysEqual(this.nickname, defaultName);
    }

    setDefaultNickname() {
        const name = GSCUtils.getPokemonName(this.getSpecies());
        if (name) {
            this.nickname = new Uint8Array(name);
        }
    }

    setEggNickname() {
        if (GSCUtils.eggNick) {
            this.nickname = new Uint8Array(GSCUtils.eggNick);
        }
    }

    // ==================== COMPARISON ====================

    /**
     * Check if Pokemon has changed significantly after sanity checks.
     * @param {GSCPokemonInfo} raw - Original Pokemon data
     * @returns {boolean} True if significantly changed
     */
    hasChangedSignificantly(raw) {
        if (this.getSpecies() !== raw.getSpecies()) return true;
        if (this.areMovesSame(raw) === null) return true;
        if (this.getLevel() !== raw.getLevel()) return true;
        return false;
    }

    /**
     * Compare moves between Pokemon.
     * @returns {number[]|null} Index mapping or null if different
     */
    areMovesSame(other) {
        const pos = [];
        for (let i = 0; i < 4; i++) {
            let found = false;
            let startIndex = 0;
            while (!found) {
                const index = other.hasMoveIndex(this.getMove(i), startIndex);
                if (index === 4) {
                    return null;
                } else if (pos.includes(index)) {
                    startIndex = index + 1;
                } else {
                    pos.push(index);
                    found = true;
                }
            }
        }
        return pos;
    }

    getSameMoves() {
        const pos = [];
        for (let i = 0; i < 4; i++) {
            const innerPos = [];
            for (let j = 0; j < 4; j++) {
                if (this.getMove(i) === this.getMove(j)) {
                    innerPos.push(i);
                }
            }
            pos.push(innerPos);
        }
        return pos;
    }

    areMovesAndPpSame(other) {
        const correspondingIndexes = this.areMovesSame(other);
        if (correspondingIndexes === null) return false;

        const possiblePositions = this.getSameMoves();
        const foundPos = [];

        for (let i = 0; i < 4; i++) {
            let found = false;
            for (const j of possiblePositions[i]) {
                if (!found && !foundPos.includes(correspondingIndexes[j]) &&
                    this.getPP(i) === other.getPP(correspondingIndexes[j])) {
                    foundPos.push(correspondingIndexes[j]);
                    found = true;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    isEqual(other, weak = false) {
        // Compare core data ranges (excluding moves as they're checked separately)
        const ranges = [[0, 2], [6, 0x17], [0x1B, GSCPokemonInfo.POKEMON_DATA_LEN]];
        for (const [start, end] of ranges) {
            for (let j = start; j < end; j++) {
                if (this.values[j] !== other.values[j]) {
                    return false;
                }
            }
        }

        if (!this.areMovesAndPpSame(other)) return false;

        if (!weak) {
            if (this.otName && other.otName) {
                if (!this.arraysEqual(this.otName, other.otName)) return false;
            }
            if (this.nickname && other.nickname) {
                if (!this.arraysEqual(this.nickname, other.nickname)) return false;
            }
            if (this.hasMail()) {
                if (this.mail && other.mail) {
                    if (!this.arraysEqual(this.mail, other.mail)) return false;
                }
                if (this.mailSender && other.mailSender) {
                    if (!this.arraysEqual(this.mailSender, other.mailSender)) return false;
                }
            }
        }
        return true;
    }

    // ==================== DATA EXPORT ====================

    /**
     * Get all data as a flat array.
     */
    getData() {
        const totalLen = GSCPokemonInfo.POKEMON_DATA_LEN +
            GSCPokemonInfo.OT_NAME_LEN +
            GSCPokemonInfo.NICKNAME_LEN +
            (this.hasMail() ? GSCPokemonInfo.MAIL_LEN + GSCPokemonInfo.SENDER_LEN : 0);

        const data = new Uint8Array(totalLen);
        let offset = 0;

        // Pokemon data
        data.set(this.values, offset);
        offset += GSCPokemonInfo.POKEMON_DATA_LEN;

        // OT Name
        if (this.otName) {
            data.set(this.otName, offset);
        }
        offset += GSCPokemonInfo.OT_NAME_LEN;

        // Nickname
        if (this.nickname) {
            data.set(this.nickname, offset);
        }
        offset += GSCPokemonInfo.NICKNAME_LEN;

        // Mail (if present)
        if (this.hasMail()) {
            if (this.mail) {
                data.set(this.mail, offset);
            }
            offset += GSCPokemonInfo.MAIL_LEN;

            if (this.mailSender) {
                data.set(this.mailSender, offset);
            }
        }

        return data;
    }

    /**
     * Create a Pokemon from flat data array.
     */
    static fromData(data) {
        const mon = new GSCPokemonInfo(data, 0);
        let offset = GSCPokemonInfo.POKEMON_DATA_LEN;

        mon.addOtName(data, offset);
        offset += GSCPokemonInfo.OT_NAME_LEN;

        mon.addNickname(data, offset);
        offset += GSCPokemonInfo.NICKNAME_LEN;

        if (mon.hasMail()) {
            mon.addMail(data, offset);
            offset += GSCPokemonInfo.MAIL_LEN;

            mon.addMailSender(data, offset);
        }

        return mon;
    }

    // ==================== HELPERS ====================

    readShort(pos) {
        return (this.values[pos] << 8) | this.values[pos + 1];
    }

    writeShort(pos, val) {
        this.values[pos] = (val >> 8) & 0xFF;
        this.values[pos + 1] = val & 0xFF;
    }

    arraysEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
}
