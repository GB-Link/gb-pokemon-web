
import { GSCUtils } from './GSCUtils.js';
import { GSCPokemonInfo } from './GSCPokemonInfo.js';
import { GSCTradingData, GSCTradingText } from './GSCTradingDataUtils.js';

// ==================== RSESPUtils ====================

export class RSESPUtils extends GSCUtils {
    // Gen 3 constants
    static base_folder = "data/rse/";
    static num_entries = 0x1BD;
    static last_valid_pokemon = 411;
    static last_valid_item = 376;
    static last_valid_move = 354;
    static struggle_id = 165;
    static hp_stat_id = 0;
    static num_stats = 6;
    static min_level = 2;
    static max_level = 100;
    static name_size = 10; // Gen 3 nickname length
    static end_of_line = 0xFF; // Gen 3 uses 0xFF as string terminator

    // Stat conversion tables (Gen 3: HP, ATK, DEF, SPD, SPATK, SPDEF)
    static stat_id_base_conv_table = [0, 1, 2, 5, 3, 4];

    // Data to be loaded
    static invalid_held_items = null;
    static invalid_pokemon = null;
    static abilities = null;
    static base_stats = null;
    static pokemon_names = null;
    static moves_pp_list = null;
    static exp_groups = null;
    static exp_lists = null;
    static egg_nick = null;
    static text_conv_dict = null;
    static enc_positions = null;
    static loaded = false;

    static init_enc_positions() {
        const positions = [];
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (j !== i) {
                    for (let k = 0; k < 4; k++) {
                        if (k !== i && k !== j) {
                            for (let l = 0; l < 4; l++) {
                                if (l !== i && l !== j && l !== k) {
                                    positions.push((0 << (i * 2)) | (1 << (j * 2)) | (2 << (k * 2)) | (3 << (l * 2)));
                                }
                            }
                        }
                    }
                }
            }
        }
        return positions;
    }

    static async load() {
        if (this.loaded) return;

        this.enc_positions = this.init_enc_positions();

        const folder = this.base_folder;

        // Load binary files
        const [
            invalidHeldItems, invalidPokemon, abilities, stats,
            movesPpList, expGroups, eggNick
        ] = await Promise.all([
            this.fetchBin(folder + "invalid_held_items.bin"),
            this.fetchBin(folder + "invalid_pokemon.bin"),
            this.fetchBin(folder + "abilities.bin"),
            this.fetchBin(folder + "stats.bin"),
            this.fetchBin(folder + "moves_pp_list.bin"),
            this.fetchBin(folder + "pokemon_exp_groups.bin"),
            this.fetchBin(folder + "egg_nick.bin"),
        ]);

        this.invalid_held_items = invalidHeldItems;
        this.invalid_pokemon = invalidPokemon;
        this.abilities = abilities;
        this.moves_pp_list = movesPpList;
        this.exp_groups = expGroups;
        this.egg_nick = eggNick ? Array.from(eggNick) : null;

        // Parse stats: num_entries entries, each num_stats bytes
        if (stats) {
            this.base_stats = [];
            for (let i = 0; i < this.num_entries; i++) {
                this.base_stats[i] = Array.from(stats.slice(i * this.num_stats, (i + 1) * this.num_stats));
            }
        }

        // Load text conversion dictionary
        const textConvText = await this.fetchText(folder + "text_conv.txt");
        if (textConvText) {
            this.text_conv_dict = {};
            const lines = textConvText.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Format: "A 128" (character space value)
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 2) {
                    const char = parts[0];
                    const val = parseInt(parts[1], 10);
                    if (!isNaN(val)) {
                        this.text_conv_dict[char] = val;
                        // Add lowercase mapping too
                        if (char.length === 1 && char >= 'A' && char <= 'Z') {
                            this.text_conv_dict[char.toLowerCase()] = val;
                        }
                    }
                }
            }
            this.text_conv_dict['\n'] = this.end_of_line;
        }

        // Load pokemon names
        const namesText = await this.fetchText(folder + "pokemon_names.txt");
        if (namesText) {
            const nameLines = namesText.split('\n');
            this.pokemon_names = [];
            for (let i = 0; i < this.num_entries; i++) {
                const nameArr = new Array(this.name_size).fill(this.end_of_line);
                if (i < nameLines.length) {
                    const name = nameLines[i];
                    for (let j = 0; j < name.length && j < this.name_size; j++) {
                        const letter = name[j].toUpperCase();
                        if (this.text_conv_dict && letter in this.text_conv_dict) {
                            nameArr[j] = this.text_conv_dict[letter];
                        }
                    }
                }
                this.pokemon_names[i] = nameArr;
            }
        }

        // Load experience lists: one row per level, 6 columns (one per growth
        // group), transposed so exp_lists[group][level-1] = cumulative EXP.
        const expText = await this.fetchText(folder + "pokemon_exp.txt");
        if (expText) {
            const expLines = expText.split('\n').filter(l => l.trim());
            this.exp_lists = [[], [], [], [], [], []];
            for (const line of expLines) {
                const vals = line.trim().split(/\s+/).map(Number);
                for (let group = 0; group < 6; group++) {
                    this.exp_lists[group].push(vals[group]);
                }
            }
        }

        this.loaded = true;
        console.log("[RSESPUtils] Loaded all Gen 3 data files");
    }

    static async fetchBin(path) {
        try {
            const response = await fetch('/' + path);
            if (!response.ok) return null;
            const buffer = await response.arrayBuffer();
            return new Uint8Array(buffer);
        } catch (e) {
            console.warn(`[RSESPUtils] Failed to load ${path}:`, e);
            return null;
        }
    }

    static async fetchText(path) {
        try {
            const response = await fetch('/' + path);
            if (!response.ok) return null;
            return await response.text();
        } catch (e) {
            console.warn(`[RSESPUtils] Failed to load ${path}:`, e);
            return null;
        }
    }

    // ==================== Stat Helpers ====================

    static getBaseStat(species, statId) {
        if (!this.base_stats || species >= this.base_stats.length) return 0;
        return this.base_stats[species][this.stat_id_base_conv_table[statId]] || 0;
    }

    static getIv(ivs, statId) {
        return ivs[statId] || 0;
    }

    static getEv(statExp, statId) {
        return statExp[statId] || 0;
    }

    static getStatExpContribution(statExp) {
        return Math.floor(statExp / 4);
    }

    static finalStatCalcStep(statId, level) {
        if (statId !== this.hp_stat_id) return 5;
        return level + 10;
    }

    static statCalculation(statId, species, ivs, statExp, level, nature = 0, doExp = true) {
        let interValue = (2 * this.getBaseStat(species, statId)) + this.getIv(ivs, statId);
        if (doExp) {
            interValue += this.getStatExpContribution(this.getEv(statExp, statId));
        }
        interValue = Math.floor((interValue * level) / 100);

        // Nature modifiers
        const statBoosted = Math.floor(nature / 5) + 1;
        const statNerfed = (nature % 5) + 1;
        let preciseStatBoost = 1.0;
        if (statBoosted !== statNerfed) {
            if (statId === statBoosted) preciseStatBoost = 1.1;
            if (statId === statNerfed) preciseStatBoost = 0.9;
        }

        return Math.floor((interValue + this.finalStatCalcStep(statId, level)) * preciseStatBoost);
    }

    static getExpLevel(species, level) {
        if (!this.exp_lists || !this.exp_groups) return 0;
        const group = this.exp_groups[species];
        if (group === undefined || !this.exp_lists[group]) return 0;
        return this.exp_lists[group][level - 1] || 0;
    }

    static getLevelExp(species, exp) {
        const start = this.min_level;
        const end = this.max_level;
        if (exp < this.getExpLevel(species, start + 1)) return start;
        if (exp >= this.getExpLevel(species, end)) return end;
        let lo = start, hi = end;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            const levelExp = this.getExpLevel(species, mid);
            const nextLevelExp = this.getExpLevel(species, mid + 1);
            if (exp < levelExp) {
                hi = mid;
            } else if (exp > nextLevelExp) {
                lo = mid + 1;
            } else if (exp === nextLevelExp) {
                return mid + 1;
            } else {
                return mid;
            }
        }
        return this.max_level;
    }

    // ==================== Validation Helpers ====================

    static isSpeciesValid(species) {
        if (species > this.last_valid_pokemon) return false;
        if (this.invalid_pokemon && (this.invalid_pokemon[species >> 3] & (1 << (species & 7))) !== 0) return false;
        return true;
    }

    static isMoveValid(move) {
        if (move > this.last_valid_move) return false;
        if (move === this.struggle_id) return false;
        return true;
    }

    static isItemValid(item) {
        if (item > this.last_valid_item) return false;
        if (this.invalid_held_items && (this.invalid_held_items[item >> 3] & (1 << (item & 7))) !== 0) return false;
        return true;
    }

    static isItemMail(item) {
        return (item >= 0x79) && (item <= 0x84);
    }

    // ==================== Single Mon Helpers ====================

    static singleMonFromData(checks, data) {
        const totalLen = RSESPTradingPokemonInfo.POKEMON_DATA_LEN +
            RSESPTradingPokemonInfo.MAIL_LEN +
            RSESPTradingPokemonInfo.VERSION_INFO_LEN +
            RSESPTradingPokemonInfo.RIBBON_INFO_LEN;

        if (data.length < totalLen) return null;

        const mon = RSESPTradingPokemonInfo.setData(data);
        if (!mon.hasChangedSignificantly(null)) {
            return [mon, mon.getIsEgg()];
        }
        return null;
    }

    static singleMonToData(mon) {
        return mon.getData();
    }

    // ==================== LE Read/Write Helpers ====================

    static readInt(data, offset) {
        return ((data[offset]) | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
    }

    static readIntSigned(data, offset) {
        return (data[offset]) | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
    }

    static writeInt(data, offset, val) {
        data[offset] = val & 0xFF;
        data[offset + 1] = (val >>> 8) & 0xFF;
        data[offset + 2] = (val >>> 16) & 0xFF;
        data[offset + 3] = (val >>> 24) & 0xFF;
    }

    static readShort(data, offset) {
        return (data[offset]) | (data[offset + 1] << 8);
    }

    static writeShort(data, offset, val) {
        data[offset] = val & 0xFF;
        data[offset + 1] = (val >>> 8) & 0xFF;
    }

    static toNBytesLE(val, n) {
        const arr = [];
        for (let i = 0; i < n; i++) {
            arr.push((val >>> (i * 8)) & 0xFF);
        }
        return arr;
    }

    static fromNBytesLE(arr, n) {
        let val = 0;
        for (let i = 0; i < n && i < arr.length; i++) {
            val |= (arr[i] << (i * 8));
        }
        return val >>> 0;
    }
}


// ==================== RSESPTradingPokemonInfo ====================

export class RSESPTradingPokemonInfo {
    // Class-level constants (matching Python class variables)
    static POKEMON_DATA_LEN = 0x64;  // 100 bytes
    static MAIL_LEN = 0x24;          // 36 bytes
    static VERSION_INFO_LEN = 2;
    static RIBBON_INFO_LEN = 11;
    static ALL_LENGTHS = [0x64, 0x24, 2, 11];

    static JAPANESE_LANGUAGE_ID = 1;
    static NUM_UNOWN_LETTERS = 28;
    static UNOWN_B_START = 415;
    static UNOWN_SPECIES = 201;
    static DEOXYS_SPECIES = 410;
    static EGG_SPECIES = 412;
    static DEOXYS_FORMS_START = 442;
    static TRADE_LOCATION = 0xFE;
    static EVENT_LOCATION = 0xFF;
    static COLOSSEUM_GAME = 0xF;
    static OT_NAME_LEN = 7;
    static NICKNAME_LEN = 10;

    // Offsets within 100-byte pokemon structure
    static PID_POS = 0;
    static OT_ID_POS = 4;
    static NICKNAME_POS = 8;
    static LANGUAGE_POS = 18;
    static USE_EGG_NAME_POS = 19;
    static OT_NAME_POS = 20;
    static CHECKSUM_POS = 28;
    static ENC_DATA_POS = 32;
    static ENC_DATA_LEN = 48;
    static STATUS_POS = 80;
    static LEVEL_POS = 84;
    static MAIL_INFO_POS = 85;
    static CURR_HP_POS = 86;
    static STATS_POS = 88;

    constructor(data, start, length = RSESPTradingPokemonInfo.POKEMON_DATA_LEN, isEncrypted = true) {
        // Copy pokemon data
        this.values = new Uint8Array(length);
        if (data) {
            const src = data instanceof Uint8Array ? data : new Uint8Array(data);
            const end = Math.min(start + length, src.length);
            this.values.set(src.slice(start, end));
        }

        this.pid = RSESPUtils.readInt(this.values, RSESPTradingPokemonInfo.PID_POS);
        this.ot_id = RSESPUtils.readInt(this.values, RSESPTradingPokemonInfo.OT_ID_POS);

        this.isValid = true;
        this.checksumFailed = false;

        // Precalculated cumulative offsets: [0, 0x64, 0x88, 0x8A, 0x95]
        this._precalced_lengths = [0];
        let cum = 0;
        for (const l of RSESPTradingPokemonInfo.ALL_LENGTHS) {
            cum += l;
            this._precalced_lengths.push(cum);
        }

        // Initialize separate sections
        this.mail = { values: new Uint8Array(RSESPTradingPokemonInfo.MAIL_LEN) };
        this.version_info = new Array(RSESPTradingPokemonInfo.VERSION_INFO_LEN).fill(0);
        this.ribbon_info = new Array(RSESPTradingPokemonInfo.RIBBON_INFO_LEN).fill(0);

        // Decrypt or parse
        if (isEncrypted) {
            this._decryptAndValidate();
        } else {
            this._parseUnencrypted();
        }
    }

    _decryptAndValidate() {
        const encDataPos = RSESPTradingPokemonInfo.ENC_DATA_POS;
        const encDataLen = RSESPTradingPokemonInfo.ENC_DATA_LEN;
        const enc_positions = RSESPUtils.enc_positions;

        // Decrypt 32-bit words with XOR
        const decrypted_data = [];
        let checksum = 0;
        for (let i = 0; i < encDataLen / 4; i++) {
            let single_entry_dec = RSESPUtils.readInt(this.values, encDataPos + (i * 4)) ^ this.pid ^ this.ot_id;
            // Expand to bytes (LE)
            for (let j = 0; j < 4; j++) {
                decrypted_data.push((single_entry_dec >>> (8 * j)) & 0xFF);
            }
            checksum = (checksum + (single_entry_dec & 0xFFFF)) & 0xFFFF;
            checksum = (checksum + ((single_entry_dec >>> 16) & 0xFFFF)) & 0xFFFF;
        }

        const storedChecksum = RSESPUtils.readShort(this.values, RSESPTradingPokemonInfo.CHECKSUM_POS);
        if (checksum !== storedChecksum) {
            this.isValid = false;
            this.checksumFailed = true;
        }

        // Unshuffle substructures based on PID
        const index = this.pid % enc_positions.length;
        const order = enc_positions[index];
        const blockSize = encDataLen / 4; // 12 bytes per block

        // Python: growth = decrypted_data[blockSize*((order>>0)&3) : blockSize*(((order>>0)&3)+1)]
        this.growth = decrypted_data.slice(blockSize * ((order >> 0) & 3), blockSize * (((order >> 0) & 3) + 1));
        this.attacks = decrypted_data.slice(blockSize * ((order >> 2) & 3), blockSize * (((order >> 2) & 3) + 1));
        this.evs = decrypted_data.slice(blockSize * ((order >> 4) & 3), blockSize * (((order >> 4) & 3) + 1));
        this.misc = decrypted_data.slice(blockSize * ((order >> 6) & 3), blockSize * (((order >> 6) & 3) + 1));

        // Validate
        if (this.isValid) {
            if (!RSESPUtils.isSpeciesValid(this.getSpecies())) this.isValid = false;
        }
        if (this.isValid) {
            if (!this.hasValidMoves()) this.isValid = false;
        }
        if (this.isValid) {
            if (!this.isAbilityValid()) this.isValid = false;
        }
        if (this.isValid) {
            if (this.getIsBadEgg()) this.isValid = false;
        }
    }

    _parseUnencrypted() {
        // For data that's already decrypted (is_encrypted=False in Python)
        const encDataPos = RSESPTradingPokemonInfo.ENC_DATA_POS;
        const encDataLen = RSESPTradingPokemonInfo.ENC_DATA_LEN;
        const blockSize = encDataLen / 4;

        // Checksum on raw unencrypted data
        let checksum = 0;
        for (let i = 0; i < encDataLen / 4; i++) {
            const val = RSESPUtils.readInt(this.values, encDataPos + (i * 4));
            checksum = (checksum + (val & 0xFFFF)) & 0xFFFF;
            checksum = (checksum + ((val >>> 16) & 0xFFFF)) & 0xFFFF;
        }
        const storedChecksum = RSESPUtils.readShort(this.values, RSESPTradingPokemonInfo.CHECKSUM_POS);
        if (checksum !== storedChecksum) {
            this.isValid = false;
            this.checksumFailed = true;
        }

        // Read substructures directly (no shuffle, data at fixed positions)
        this.growth = Array.from(this.values.slice(encDataPos + blockSize * 0, encDataPos + blockSize * 1));
        this.attacks = Array.from(this.values.slice(encDataPos + blockSize * 1, encDataPos + blockSize * 2));
        this.evs = Array.from(this.values.slice(encDataPos + blockSize * 2, encDataPos + blockSize * 3));
        this.misc = Array.from(this.values.slice(encDataPos + blockSize * 3, encDataPos + blockSize * 4));

        // Encrypt so values[] has proper encrypted data
        this.encryptData();
    }

    encryptData() {
        this.pid = RSESPUtils.readInt(this.values, RSESPTradingPokemonInfo.PID_POS);
        this.ot_id = RSESPUtils.readInt(this.values, RSESPTradingPokemonInfo.OT_ID_POS);

        const enc_positions = RSESPUtils.enc_positions;
        const encDataLen = RSESPTradingPokemonInfo.ENC_DATA_LEN;
        const encDataPos = RSESPTradingPokemonInfo.ENC_DATA_POS;
        const index = this.pid % enc_positions.length;
        const order = enc_positions[index];

        // Reverse-shuffle: for each position i (0-3), find which substructure maps to it
        const decrypted_data = [];
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                const value = (order >> (2 * j)) & 3;
                if (value === i) {
                    if (j === 0) decrypted_data.push(...this.growth);
                    else if (j === 1) decrypted_data.push(...this.attacks);
                    else if (j === 2) decrypted_data.push(...this.evs);
                    else if (j === 3) decrypted_data.push(...this.misc);
                }
            }
        }

        // Calculate checksum and encrypt
        let checksum = 0;
        const encrypted_data = [];
        for (let i = 0; i < encDataLen / 4; i++) {
            const single_entry_dec = RSESPUtils.readInt(decrypted_data, i * 4);
            checksum = (checksum + (single_entry_dec & 0xFFFF)) & 0xFFFF;
            checksum = (checksum + ((single_entry_dec >>> 16) & 0xFFFF)) & 0xFFFF;
            const encrypted = single_entry_dec ^ this.pid ^ this.ot_id;
            for (let j = 0; j < 4; j++) {
                encrypted_data.push((encrypted >>> (8 * j)) & 0xFF);
            }
        }

        if (this.checksumFailed) {
            checksum = (checksum + 1) & 0xFFFF;
        }

        // Write back to values
        for (let i = 0; i < encrypted_data.length; i++) {
            this.values[encDataPos + i] = encrypted_data[i];
        }
        RSESPUtils.writeShort(this.values, RSESPTradingPokemonInfo.CHECKSUM_POS, checksum);
    }

    // ==================== Getters ====================

    getSpecies() { return RSESPUtils.readShort(this.growth, 0); }
    setSpecies(val) { RSESPUtils.writeShort(this.growth, 0, val); }

    getItem() { return RSESPUtils.readShort(this.growth, 2); }
    setItem(val = 0) { RSESPUtils.writeShort(this.growth, 2, val); }

    getExp() { return RSESPUtils.readInt(this.growth, 4); }
    setExp(val) { RSESPUtils.writeInt(this.growth, 4, val); }

    getHatchingCycles() { return this.growth[9]; }
    setHatchingCycles(val = 0) { this.growth[9] = val; }

    getMove(pos) {
        const move = RSESPUtils.readShort(this.attacks, pos * 2);
        if (!RSESPUtils.isMoveValid(move)) return 0;
        return move;
    }
    setMove(pos, val, maxPp = true) {
        RSESPUtils.writeShort(this.attacks, pos * 2, val);
        if (maxPp && RSESPUtils.moves_pp_list) {
            this.setPP(pos, RSESPUtils.moves_pp_list[val] || 0);
        }
    }

    getPP(pos) { return this.attacks[8 + pos]; }
    setPP(pos, val) { this.attacks[8 + pos] = val; }

    hasValidMoves() {
        for (let i = 0; i < 4; i++) {
            if (this.getMove(i) !== 0) return true;
        }
        return false;
    }

    getLevel() { return this.values[RSESPTradingPokemonInfo.LEVEL_POS]; }
    setLevel(val) {
        this.values[RSESPTradingPokemonInfo.LEVEL_POS] = val;
        if (RSESPUtils.loaded) {
            const exp = RSESPUtils.getExpLevel(this.getMonIndex(), val);
            this.setExp(exp);
            this.updateStats();
        }
    }

    getCurrHp() { return RSESPUtils.readShort(this.values, RSESPTradingPokemonInfo.CURR_HP_POS); }
    getMaxHp() { return RSESPUtils.readShort(this.values, RSESPTradingPokemonInfo.STATS_POS); }

    getMailId() { return this.values[RSESPTradingPokemonInfo.MAIL_INFO_POS]; }

    hasMail() {
        if (RSESPUtils.isItemMail(this.getItem())) {
            if (this.getMailId() < 6) return true;
        }
        return false;
    }

    getIsBadEgg() {
        return (this.values[RSESPTradingPokemonInfo.USE_EGG_NAME_POS] & 1) !== 0;
    }

    getIsEgg() {
        return (this.misc[7] & 0x40) !== 0 ? 1 : 0;
    }

    getHasSecondAbility() {
        return (this.misc[7] & 0x80) !== 0 ? 1 : 0;
    }

    getMetLocation() {
        return this.misc[1];
    }

    getOriginGame() {
        return (RSESPUtils.readShort(this.misc, 2) >> 7) & 0xF;
    }

    getNature() {
        return this.pid % 25;
    }

    getUnownLetter() {
        return ((this.pid & 3) + (((this.pid >>> 8) & 3) << 2) + (((this.pid >>> 16) & 3) << 4) + (((this.pid >>> 24) & 3) << 6)) % RSESPTradingPokemonInfo.NUM_UNOWN_LETTERS;
    }

    getDeoxysForm() {
        if (this.version_info[0] === 2) return 3;
        if (this.version_info[0] === 1) {
            if (this.version_info[1] === 1) return 2;
            return 1;
        }
        return 0;
    }

    getMonIndex(ignoreEgg = true) {
        const index = this.getSpecies();
        if (!this.isValid) return 0;
        if (!RSESPUtils.isSpeciesValid(index)) {
            this.isValid = false;
            return 0;
        }
        if (!ignoreEgg && this.getIsEgg()) {
            return RSESPTradingPokemonInfo.EGG_SPECIES;
        }
        if (index === RSESPTradingPokemonInfo.UNOWN_SPECIES) {
            const letter = this.getUnownLetter();
            if (letter === 0) return RSESPTradingPokemonInfo.UNOWN_SPECIES;
            return RSESPTradingPokemonInfo.UNOWN_B_START + letter - 1;
        } else if (index === RSESPTradingPokemonInfo.DEOXYS_SPECIES) {
            const form = this.getDeoxysForm();
            if (form === 0) return RSESPTradingPokemonInfo.DEOXYS_SPECIES;
            return RSESPTradingPokemonInfo.DEOXYS_FORMS_START + form - 1;
        }
        return index;
    }

    isAbilityValid() {
        const monIndex = this.getMonIndex();
        if (!RSESPUtils.abilities || monIndex * 2 + 1 >= RSESPUtils.abilities.length) return true;
        const ab = RSESPUtils.abilities.slice(monIndex * 2, monIndex * 2 + 2);
        const abilitiesSame = ab[0] === ab[1];

        if (abilitiesSame && this.getHasSecondAbility() === 1) return false;

        if (((this.pid & 1) ^ this.getHasSecondAbility()) === 0) return true;
        if (this.getMetLocation() === RSESPTradingPokemonInfo.TRADE_LOCATION) return true;
        if (this.getMetLocation() === RSESPTradingPokemonInfo.EVENT_LOCATION) return true;
        if (this.getOriginGame() === RSESPTradingPokemonInfo.COLOSSEUM_GAME) return true;
        if (abilitiesSame) return true;

        return false;
    }

    getIVs() {
        const ret = [0, 0, 0, 0, 0, 0];
        const totalVal = RSESPUtils.readInt(this.misc, 4);
        for (let i = 0; i < 6; i++) {
            ret[i] = (totalVal >>> (5 * i)) & 0x1F;
        }
        return ret;
    }

    getStatExp() {
        // Gen 3 EVs: 6 bytes in the evs substructure
        return this.evs.slice(0, 6);
    }

    // ==================== Modification ====================

    heal() {
        RSESPUtils.writeShort(this.values, RSESPTradingPokemonInfo.CURR_HP_POS, this.getMaxHp());
        this.values[RSESPTradingPokemonInfo.STATUS_POS] = 0;
    }

    faint() {
        RSESPUtils.writeShort(this.values, RSESPTradingPokemonInfo.CURR_HP_POS, 0);
        this.values[RSESPTradingPokemonInfo.STATUS_POS] = 0;
    }

    updateStats() {
        if (!RSESPUtils.loaded) return;
        const oldMaxHp = this.getMaxHp();
        const oldCurrHp = this.getCurrHp();

        for (let i = 0; i < RSESPUtils.num_stats; i++) {
            const stat = RSESPUtils.statCalculation(
                i, this.getMonIndex(), this.getIVs(), this.getStatExp(),
                this.getLevel(), this.getNature()
            );
            RSESPUtils.writeShort(this.values, RSESPTradingPokemonInfo.STATS_POS + (i * 2), stat);
        }

        const newMaxHp = this.getMaxHp();
        let newCurrHp = oldCurrHp + (newMaxHp - oldMaxHp);
        newCurrHp = Math.max(0, Math.min(newCurrHp, newMaxHp));
        RSESPUtils.writeShort(this.values, RSESPTradingPokemonInfo.CURR_HP_POS, newCurrHp);
    }

    setEggNickname() {
        if (RSESPUtils.egg_nick) {
            this.addNickname(RSESPUtils.egg_nick, 0);
        }
        this.values[RSESPTradingPokemonInfo.LANGUAGE_POS] = RSESPTradingPokemonInfo.JAPANESE_LANGUAGE_ID;
        this.values[RSESPTradingPokemonInfo.USE_EGG_NAME_POS] |= 4;
        this.misc[7] |= 0x40;
    }

    setDefaultNickname() {
        if (RSESPUtils.pokemon_names) {
            this.addNickname(RSESPUtils.pokemon_names[this.getSpecies()], 0);
        }
    }

    // ==================== Data sections ====================

    addOtName(data, start) {
        const len = RSESPTradingPokemonInfo.OT_NAME_LEN;
        const src = (data instanceof Uint8Array) ? Array.from(data) : data;
        while (src.length < start + len) src.push(0);
        for (let i = 0; i < len; i++) {
            this.values[RSESPTradingPokemonInfo.OT_NAME_POS + i] = src[start + i];
        }
    }

    addNickname(data, start) {
        const len = RSESPTradingPokemonInfo.NICKNAME_LEN;
        const src = (data instanceof Uint8Array) ? Array.from(data) : data;
        while (src.length < start + len) src.push(0);
        for (let i = 0; i < len; i++) {
            this.values[RSESPTradingPokemonInfo.NICKNAME_POS + i] = src[start + i];
        }
    }

    addMail(data, start) {
        const len = RSESPTradingPokemonInfo.MAIL_LEN;
        const src = (data instanceof Uint8Array) ? Array.from(data) : data;
        while (src.length < start + len) src.push(0);
        this.mail = { values: src.slice(start, start + len) };
    }

    addVersionInfo(data, start) {
        const len = RSESPTradingPokemonInfo.VERSION_INFO_LEN;
        const src = (data instanceof Uint8Array) ? Array.from(data) : data;
        while (src.length < start + len) src.push(0);
        this.version_info = src.slice(start, start + len);
    }

    addRibbonInfo(data, start) {
        const len = RSESPTradingPokemonInfo.RIBBON_INFO_LEN;
        const src = (data instanceof Uint8Array) ? Array.from(data) : data;
        while (src.length < start + len) src.push(0);
        this.ribbon_info = src.slice(start, start + len);
    }

    // ==================== Comparison ====================

    hasChangedSignificantly(_raw) {
        return !this.isValid;
    }

    isEqual(_other, _weak = false) {
        return true;
    }

    // ==================== Data Export ====================

    getData() {
        // Re-encrypt before serializing
        this.encryptData();

        // Build output: [pokemon_data(0x64), mail(0x24), version(2), ribbon(11)] = 0x95 bytes
        const totalLen = this._precalced_lengths[this._precalced_lengths.length - 1];
        const data = new Array(totalLen).fill(0);

        if (this.isValid) {
            // Copy pokemon values
            for (let i = 0; i < this.values.length; i++) {
                data[this._precalced_lengths[0] + i] = this.values[i];
            }
            // Copy mail
            if (this.mail && this.mail.values) {
                for (let i = 0; i < this.mail.values.length; i++) {
                    data[this._precalced_lengths[1] + i] = this.mail.values[i];
                }
            }
            // Copy version info
            for (let i = 0; i < this.version_info.length; i++) {
                data[this._precalced_lengths[2] + i] = this.version_info[i];
            }
            // Copy ribbon info
            for (let i = 0; i < this.ribbon_info.length; i++) {
                data[this._precalced_lengths[3] + i] = this.ribbon_info[i];
            }
        }

        return data;
    }

    static setData(data, isEncrypted = true) {
        const src = (data instanceof Uint8Array) ? Array.from(data) : data;
        const mon = new RSESPTradingPokemonInfo(src, 0, RSESPTradingPokemonInfo.POKEMON_DATA_LEN, isEncrypted);
        mon.addMail(src, mon._precalced_lengths[1]);
        mon.addVersionInfo(src, mon._precalced_lengths[2]);
        mon.addRibbonInfo(src, mon._precalced_lengths[3]);
        return mon;
    }
}


// ==================== RSESPTradingPartyInfo ====================

class RSESPTradingPartyInfo {
    static MAX_PARTY_MONS = 6;

    constructor(data, start) {
        this.total = RSESPUtils.readInt(data, start);
        if (this.total <= 0 || this.total > RSESPTradingPartyInfo.MAX_PARTY_MONS) {
            this.total = 1;
        }
    }

    getId(_pos) { return null; }
    setId(_pos, _val) {}
    getTotal() { return this.total; }
}


// ==================== RSESPTradingData ====================

export class RSESPTradingData {
    // Gen 3 party data layout constants
    static TRADER_NAME_POS = 0x353;
    static GAME_ID_POS = 0x344;
    static TRADER_INFO_POS = 0x378;
    static RIBBON_INFO_POS = 0x348;
    static TRADING_PARTY_INFO_POS = 0xE4;
    static TRADING_POKEMON_POS = 0xE8;
    static TRADING_MAIL_POS = 8;

    static TRADING_PARTY_MAX_SIZE = 6;
    static TRADING_POKEMON_LENGTH = 0x64;
    static TRADING_NAME_LENGTH = 8;
    static TRADING_MAIL_LENGTH = 0x24;
    static TRADING_VERSION_INFO_LENGTH = 2;

    constructor(data, dataMail = null, doFull = true) {
        const src = (data instanceof Uint8Array) ? data : new Uint8Array(data);

        // Parse trader name
        this.trader = new GSCTradingText(src, RSESPTradingData.TRADER_NAME_POS, RSESPTradingData.TRADING_NAME_LENGTH);

        // Parse party info
        this.partyInfo = new RSESPTradingPartyInfo(src, RSESPTradingData.TRADING_PARTY_INFO_POS);

        // Parse trainer info
        this.trainerInfo = RSESPUtils.readInt(src, RSESPTradingData.TRADER_INFO_POS);

        this.pokemon = [];

        if (doFull) {
            for (let i = 0; i < this.getPartySize(); i++) {
                const mon = new RSESPTradingPokemonInfo(
                    src,
                    RSESPTradingData.TRADING_POKEMON_POS + i * RSESPTradingData.TRADING_POKEMON_LENGTH
                );

                // Add mail if pokemon has it
                if (mon.hasMail()) {
                    mon.addMail(src, RSESPTradingData.TRADING_MAIL_POS + mon.getMailId() * RSESPTradingData.TRADING_MAIL_LENGTH);
                } else {
                    mon.addMail(new Array(RSESPTradingData.TRADING_MAIL_LENGTH).fill(0), 0);
                }

                // Add version info (at game_id_pos + 1)
                mon.addVersionInfo(src, RSESPTradingData.GAME_ID_POS + 1);

                // Add ribbon info
                mon.addRibbonInfo(src, RSESPTradingData.RIBBON_INFO_POS);

                this.pokemon.push(mon);
            }
        }
    }

    getPartySize() {
        return this.partyInfo.getTotal();
    }

    getPokemon(i) {
        if (i >= 0 && i < this.pokemon.length) return this.pokemon[i];
        return null;
    }

    searchForMon(mon, _isEgg) {
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(this.pokemon[i])) return i;
        }
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(this.pokemon[i], true)) return i;
        }
        return null;
    }

    createTradingData(lengths) {
        const data = new Array(lengths[0]).fill(0);

        // Trader name
        if (this.trader && this.trader.values) {
            for (let i = 0; i < Math.min(this.trader.values.length, RSESPTradingData.TRADING_NAME_LENGTH); i++) {
                data[RSESPTradingData.TRADER_NAME_POS + i] = this.trader.values[i];
            }
        }

        // Party size
        RSESPUtils.writeInt(data, RSESPTradingData.TRADING_PARTY_INFO_POS, this.getPartySize());

        // Pokemon data
        for (let i = 0; i < this.getPartySize(); i++) {
            const monData = this.pokemon[i].getData();

            // Copy pokemon values (0x64 bytes) to trading_pokemon_pos
            for (let j = 0; j < RSESPTradingData.TRADING_POKEMON_LENGTH; j++) {
                if (j < monData.length) {
                    data[RSESPTradingData.TRADING_POKEMON_POS + (i * RSESPTradingData.TRADING_POKEMON_LENGTH) + j] = monData[this.pokemon[i]._precalced_lengths[0] + j];
                }
            }

            // Copy mail if present
            if (this.pokemon[i].hasMail()) {
                const mailStart = this.pokemon[i]._precalced_lengths[1];
                const mailEnd = this.pokemon[i]._precalced_lengths[2];
                for (let j = 0; j < RSESPTradingData.TRADING_MAIL_LENGTH; j++) {
                    if (mailStart + j < monData.length) {
                        data[RSESPTradingData.TRADING_MAIL_POS + (this.pokemon[i].getMailId() * RSESPTradingData.TRADING_MAIL_LENGTH) + j] = monData[mailStart + j];
                    }
                }
            }

            // Version and ribbon info only from first pokemon
            if (i === 0) {
                const versionStart = this.pokemon[i]._precalced_lengths[2];
                const ribbonStart = this.pokemon[i]._precalced_lengths[3];
                for (let j = 0; j < RSESPTradingPokemonInfo.VERSION_INFO_LEN; j++) {
                    data[RSESPTradingData.GAME_ID_POS + 1 + j] = monData[versionStart + j];
                }
                for (let j = 0; j < RSESPTradingPokemonInfo.RIBBON_INFO_LEN; j++) {
                    data[RSESPTradingData.RIBBON_INFO_POS + j] = monData[ribbonStart + j];
                }
            }
        }

        RSESPTradingData.generateChecksum(data, lengths);
        return [data];
    }

    static areChecksumValid(buf, lengths) {
        const C = RSESPTradingData;

        // 1. Mail checksum
        let checksum = 0;
        for (let i = 0; i < C.TRADING_PARTY_MAX_SIZE; i++) {
            for (let j = 0; j < C.TRADING_MAIL_LENGTH / 4; j++) {
                checksum = (checksum + RSESPUtils.readInt(buf, (i * C.TRADING_MAIL_LENGTH) + (j * 4) + C.TRADING_MAIL_POS)) >>> 0;
            }
        }
        if (RSESPUtils.readInt(buf, C.TRADING_MAIL_POS + (C.TRADING_PARTY_MAX_SIZE * C.TRADING_MAIL_LENGTH)) !== checksum) {
            return false;
        }

        // 2. Pokemon checksum
        checksum = RSESPUtils.readInt(buf, C.TRADING_PARTY_INFO_POS);
        for (let i = 0; i < C.TRADING_PARTY_MAX_SIZE; i++) {
            for (let j = 0; j < C.TRADING_POKEMON_LENGTH / 4; j++) {
                checksum = (checksum + RSESPUtils.readInt(buf, (i * C.TRADING_POKEMON_LENGTH) + (j * 4) + C.TRADING_POKEMON_POS)) >>> 0;
            }
        }
        if (RSESPUtils.readInt(buf, C.TRADING_POKEMON_POS + (C.TRADING_PARTY_MAX_SIZE * C.TRADING_POKEMON_LENGTH)) !== checksum) {
            return false;
        }

        // 3. Global checksum
        checksum = 0;
        for (let i = 0; i < (lengths[0] - 4) / 4; i++) {
            checksum = (checksum + RSESPUtils.readInt(buf, i * 4)) >>> 0;
        }
        if (RSESPUtils.readInt(buf, lengths[0] - 4) !== checksum) {
            return false;
        }

        return true;
    }

    static generateChecksum(buf, lengths) {
        const C = RSESPTradingData;

        // 1. Mail checksum
        let checksum = 0;
        for (let i = 0; i < C.TRADING_PARTY_MAX_SIZE; i++) {
            for (let j = 0; j < C.TRADING_MAIL_LENGTH / 4; j++) {
                const offset = (i * C.TRADING_MAIL_LENGTH) + (j * 4) + C.TRADING_MAIL_POS;
                checksum = (checksum + RSESPUtils.readInt(buf, offset)) >>> 0;
            }
        }
        RSESPUtils.writeInt(buf, C.TRADING_MAIL_POS + (C.TRADING_PARTY_MAX_SIZE * C.TRADING_MAIL_LENGTH), checksum);

        // 2. Pokemon checksum
        checksum = RSESPUtils.readInt(buf, C.TRADING_PARTY_INFO_POS);
        for (let i = 0; i < C.TRADING_PARTY_MAX_SIZE; i++) {
            for (let j = 0; j < C.TRADING_POKEMON_LENGTH / 4; j++) {
                const offset = (i * C.TRADING_POKEMON_LENGTH) + (j * 4) + C.TRADING_POKEMON_POS;
                checksum = (checksum + RSESPUtils.readInt(buf, offset)) >>> 0;
            }
        }
        RSESPUtils.writeInt(buf, C.TRADING_POKEMON_POS + (C.TRADING_PARTY_MAX_SIZE * C.TRADING_POKEMON_LENGTH), checksum);

        // 3. Global checksum
        checksum = 0;
        const totalLen = lengths[0];
        for (let i = 0; i < (totalLen - 4) / 4; i++) {
            checksum = (checksum + RSESPUtils.readInt(buf, i * 4)) >>> 0;
        }
        RSESPUtils.writeInt(buf, totalLen - 4, checksum);
    }
}
