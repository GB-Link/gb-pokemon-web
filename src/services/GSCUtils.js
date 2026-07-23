export class GSCUtils {
    static trading_pokemon_length = 0x30; // 48
    static trading_name_length = 0xB; // 11
    static trading_mail_length = 0x21; // 33
    static trading_mail_sender_length = 0xE; // 14

    static trader_name_pos = 0;
    static trading_party_info_pos = 0xB; // 11
    static trading_party_final_pos = 0x12; // 18
    static trader_info_pos = 0x13; // 19
    static trading_pokemon_pos = 0x15; // 21
    static level_pos = 0x1F;  // Level position within Pokemon data (31)
    static trading_pokemon_ot_pos = 0x135; // 309
    static trading_pokemon_nickname_pos = 0x177; // 375
    static trading_pokemon_mail_pos = 0; // In section 3
    static trading_pokemon_mail_sender_pos = 0xC6; // In section 3

    static patch_set_base_pos = [0x13, 0xC6, 0];
    static patch_set_start_info_pos = [7, 0x11A, 0xFC];

    // Text encoding: ASCII character -> Game Boy text byte
    static END_OF_LINE = 0x50;
    static TEXT_CONV = {
        'A': 0x80, 'B': 0x81, 'C': 0x82, 'D': 0x83, 'E': 0x84, 'F': 0x85, 'G': 0x86, 'H': 0x87,
        'I': 0x88, 'J': 0x89, 'K': 0x8A, 'L': 0x8B, 'M': 0x8C, 'N': 0x8D, 'O': 0x8E, 'P': 0x8F,
        'Q': 0x90, 'R': 0x91, 'S': 0x92, 'T': 0x93, 'U': 0x94, 'V': 0x95, 'W': 0x96, 'X': 0x97,
        'Y': 0x98, 'Z': 0x99, "'": 0xE0, '-': 0xE3, '?': 0xE6, '.': 0xE8, '♂': 0xEF, '♀': 0xF5,
        '0': 0xF6, '1': 0xF7, '2': 0xF8, '3': 0xF9, '4': 0xFA, '5': 0xFB, '6': 0xFC, '7': 0xFD,
        '8': 0xFE, '9': 0xFF,
        // Lowercase (same as uppercase in Game Boy encoding)
        'a': 0x80, 'b': 0x81, 'c': 0x82, 'd': 0x83, 'e': 0x84, 'f': 0x85, 'g': 0x86, 'h': 0x87,
        'i': 0x88, 'j': 0x89, 'k': 0x8A, 'l': 0x8B, 'm': 0x8C, 'n': 0x8D, 'o': 0x8E, 'p': 0x8F,
        'q': 0x90, 'r': 0x91, 's': 0x92, 't': 0x93, 'u': 0x94, 'v': 0x95, 'w': 0x96, 'x': 0x97,
        'y': 0x98, 'z': 0x99
    };

    // Pokemon names array - loaded from file, indexed by species ID
    static pokemonNames = null;
    static pokemonNamesLoaded = false;

    /**
     * Load Pokemon names from text file
     */
    static async loadPokemonNames() {
        if (this.pokemonNamesLoaded) return;

        try {
            const response = await fetch('/data/gsc/pokemon_names.txt');
            const text = await response.text();
            const lines = text.split('\n').map(line => line.trim());

            // Convert each name to Game Boy byte format
            this.pokemonNames = lines.map(name => this.textToBytes(name));
            this.pokemonNamesLoaded = true;
            console.log(`[GSCUtils] Loaded ${this.pokemonNames.length} Pokemon names`);
        } catch (error) {
            console.error('[GSCUtils] Failed to load Pokemon names:', error);
            this.pokemonNames = [];
        }
    }

    /**
     * Convert ASCII text to Game Boy byte array
     * @param {string} text - ASCII text
     * @returns {Uint8Array} - Game Boy encoded bytes, padded to 11 bytes with END_OF_LINE
     */
    static textToBytes(text) {
        const result = new Uint8Array(this.trading_name_length);
        result.fill(this.END_OF_LINE); // Fill with terminator

        for (let i = 0; i < text.length && i < this.trading_name_length - 1; i++) {
            const char = text[i];
            const byte = this.TEXT_CONV[char];
            if (byte !== undefined) {
                result[i] = byte;
            } else {
                result[i] = this.END_OF_LINE; // Unknown char becomes terminator
                break;
            }
        }

        return result;
    }

    /**
     * Get the default species name for a Pokemon
     * @param {number} speciesId - The Pokemon species ID (1-251 for Gen 2)
     * @returns {Uint8Array} - The name as Game Boy bytes
     */
    static getDefaultNickname(speciesId) {
        if (!this.pokemonNamesLoaded || !this.pokemonNames) {
            console.warn('[GSCUtils] Pokemon names not loaded');
            return new Uint8Array(this.trading_name_length).fill(this.END_OF_LINE);
        }

        if (speciesId >= 0 && speciesId < this.pokemonNames.length) {
            return this.pokemonNames[speciesId];
        }

        // Unknown species - return "?????" pattern
        return this.pokemonNames[0] || new Uint8Array(this.trading_name_length).fill(this.END_OF_LINE);
    }

    /**
     * Set the nickname in trade data to the default species name
     * @param {Uint8Array} section1Data - The full section 1 trade data
     * @param {number} pokemonIndex - Which Pokemon in the party (0-5)
     * @param {number} speciesId - The Pokemon species ID
     */
    static setDefaultNicknameInData(section1Data, pokemonIndex, speciesId) {
        const nicknamePos = this.trading_pokemon_nickname_pos + (pokemonIndex * this.trading_name_length);
        const nickname = this.getDefaultNickname(speciesId);
        section1Data.set(nickname, nicknamePos);
    }

    /**
     * Check if a byte array looks like Japanese (hiragana) encoding
     * Japanese Pokemon games use different text encoding (0x00-0x4F = hiragana, 0x51-0x9F = katakana)
     * International games use 0x80-0x99 for uppercase letters
     * @param {Uint8Array} bytes - The name bytes
     * @returns {boolean} - True if the name appears to be Japanese encoded
     */
    static isJapaneseEncoded(bytes) {
        // If we find bytes in Japanese hiragana/katakana range that aren't valid INT chars
        // Japanese text encoding uses lower byte values (< 0x80 except terminators)
        let japaneseCharCount = 0;
        let intCharCount = 0;

        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (b === this.END_OF_LINE) break; // End of string

            // Japanese character ranges
            if ((b >= 0x00 && b < 0x50) || (b >= 0x51 && b < 0x80)) {
                japaneseCharCount++;
            }
            // International character range (letters are 0x80-0x99)
            if (b >= 0x80 && b <= 0x99) {
                intCharCount++;
            }
        }

        // If we have more Japanese chars than International, it's likely JP
        return japaneseCharCount > intCharCount && japaneseCharCount > 0;
    }

    /**
     * Get the species ID from a Pokemon's data in section 1
     * @param {Uint8Array} section1Data - The full section 1 trade data
     * @param {number} pokemonIndex - Which Pokemon in the party (0-5)
     * @returns {number} - The species ID
     */
    static getSpeciesFromData(section1Data, pokemonIndex) {
        // Species is at offset 0 in each Pokemon's 48-byte data block
        const pokemonDataPos = this.trading_pokemon_pos + (pokemonIndex * this.trading_pokemon_length);
        return section1Data[pokemonDataPos];
    }

    /**
     * Get nickname bytes from section 1 data
     * @param {Uint8Array} section1Data - The full section 1 trade data
     * @param {number} pokemonIndex - Which Pokemon in the party (0-5)
     * @returns {Uint8Array} - The nickname bytes
     */
    static getNicknameFromData(section1Data, pokemonIndex) {
        const nicknamePos = this.trading_pokemon_nickname_pos + (pokemonIndex * this.trading_name_length);
        return section1Data.slice(nicknamePos, nicknamePos + this.trading_name_length);
    }

    /**
     * Fix incompatible nicknames when trading between JP and INT versions
     * Replaces Japanese-encoded names with default English species names
     * @param {Uint8Array} section1Data - The full section 1 trade data (modified in place)
     * @param {number} partySize - Number of Pokemon in party (usually get from party info)
     * @returns {number} - Number of nicknames that were replaced
     */
    static fixIncompatibleNicknames(section1Data, partySize = 6) {
        let replaced = 0;

        for (let i = 0; i < partySize && i < 6; i++) {
            const nickname = this.getNicknameFromData(section1Data, i);

            if (this.isJapaneseEncoded(nickname)) {
                const speciesId = this.getSpeciesFromData(section1Data, i);
                this.setDefaultNicknameInData(section1Data, i, speciesId);
                console.log(`[GSCUtils] Replaced Japanese nickname for Pokemon ${i} (species ${speciesId}) with default name`);
                replaced++;
            }
        }

        return replaced;
    }

    static createTradingData(poolData) {
        // poolData is the raw byte array received from server (excluding counter)
        // It contains: [Pokemon Struct (48)] [OT Name (11)] [Nickname (11)] [Mail (33)] [Mail Sender (14)] [Egg Flag (1)]

        const data = {
            section1: new Uint8Array(418), // Pokemon Data
            section2: new Uint8Array(197), // Patches
            section3: new Uint8Array(418)  // Mail (Optional)
        };

        // Parse Pool Data
        const monData = poolData.slice(0, 48);
        const otName = poolData.slice(48, 48 + 11);
        const nickname = poolData.slice(48 + 11, 48 + 11 + 11);
        // Mail data...

        // 1. Construct Section 1
        // Trader Name (Use OT Name for now)
        this.copyToData(data.section1, this.trader_name_pos, otName);

        // Party Count = 1
        data.section1[this.trading_party_info_pos] = 1;

        // Species ID for the party list; the trailing egg flag (Python
        // single_mon_to_data) makes it show as an EGG while the mon struct
        // keeps the real species.
        const isEgg = poolData.length > 0x75 && poolData[0x75] === this.EGG_VALUE;
        data.section1[this.trading_party_info_pos + 1] = isEgg ? this.EGG_ID : monData[0];
        data.section1[this.trading_party_info_pos + 2] = 0xFF; // End of list

        // Final Byte
        data.section1[this.trading_party_final_pos] = 0xFF;

        // Pokemon Data
        this.copyToData(data.section1, this.trading_pokemon_pos, monData);

        // OT Name
        this.copyToData(data.section1, this.trading_pokemon_ot_pos, otName);

        // Nickname
        this.copyToData(data.section1, this.trading_pokemon_nickname_pos, nickname);

        // 2. Create Patches for Section 1
        // We need to pass section1 and section2 to createPatches
        this.createPatchesData(data.section1, data.section2, false);

        return data;
    }

    /**
     * Create default/empty trading data for link trades.
     * In link trade, the actual opponent data comes from section exchange
     * (server proxies other player's data to us).
     */
    static createDefaultTradingData() {
        // Return empty sections - will be filled by other player's data during exchange
        // Sizes must match SPECIAL_SECTIONS_LEN: [0xA, 0x1BC, 0xC5, 0x181]
        const data = {
            section1: new Uint8Array(0x1BC), // Pokemon Data (444 bytes)
            section2: new Uint8Array(0xC5),  // Patches (197 bytes)
            section3: new Uint8Array(0x181)  // Mail (385 bytes)
        };

        // If we have cached default party data, use it
        if (GSCUtils.defaultPartyData) {
            data.section1 = GSCUtils.defaultPartyData.section1;
            data.section2 = GSCUtils.defaultPartyData.section2;
            data.section3 = GSCUtils.defaultPartyData.section3;
        }

        return data;
    }

    /**
     * Load default party data from binary file (contains ZUBAT party).
     * This is used for ghost trades in buffered mode.
     * Matches ref impl's base.bin file structure.
     */
    static async loadDefaultPartyData() {
        try {
            const response = await fetch('/data/gsc_base_party.bin');
            if (!response.ok) {
                console.warn('Could not load gsc_base_party.bin, using empty default data');
                return false;
            }

            const buffer = await response.arrayBuffer();
            const data = new Uint8Array(buffer);

            // Section lengths: [0xA, 0x1BC, 0xC5, 0x181] = [10, 444, 197, 385]
            const SECTION_LENS = [0xA, 0x1BC, 0xC5, 0x181];
            let offset = 0;

            // Random section (10 bytes) - we skip this, random is generated fresh
            offset += SECTION_LENS[0];

            // Pokemon section (444 bytes)
            const section1 = data.slice(offset, offset + SECTION_LENS[1]);
            offset += SECTION_LENS[1];

            // Patches section (197 bytes)
            const section2 = data.slice(offset, offset + SECTION_LENS[2]);
            offset += SECTION_LENS[2];

            // Mail section (385 bytes)
            const section3 = data.slice(offset, offset + SECTION_LENS[3]);

            GSCUtils.defaultPartyData = {
                section1: section1,
                section2: section2,
                section3: section3
            };

            console.log('Loaded default party data (ZUBAT) from gsc_base_party.bin');
            return true;
        } catch (e) {
            console.warn('Error loading default party data:', e);
            return false;
        }
    }

    static copyToData(target, pos, source, length) {
        if (!length) length = source.length;
        for (let i = 0; i < length; i++) {
            if (i < source.length) {
                target[pos + i] = source[i];
            }
        }
    }

    static createPatchesData(data, patchSet, isMail = false, isJapanese = false) {
        // Use getPatchSetNumIndex for consistency with applyPatches
        const [patchSetsNum, patchSetsIndex] = this.getPatchSetNumIndex(isMail, isJapanese);
        let remaining = patchSetsNum;

        let base = this.patch_set_base_pos[patchSetsIndex];
        let start = this.patch_set_start_info_pos[patchSetsIndex];

        let i = 0; // index in patchSet
        let j = 0; // index in data (relative to base)

        while (remaining > 0 && (start + i) < patchSet.length && (base + j) < data.length) {
            const readData = data[base + j];
            if (readData === 0xFE) {
                data[base + j] = 0xFF;
                patchSet[start + i] = j + 1;
                i++;
            }
            j++;
            if (j === 0xFC) {
                base += 0xFC;
                j = 0;
                patchSet[start + i] = 0xFF;
                i++;
                remaining--;
            }
        }

        if (j !== 0) {
            if ((start + i) >= patchSet.length) {
                i = patchSet.length - start - 1;
            }
            patchSet[start + i] = 0xFF;
            i++;
        }
    }

    // ==================== NEW UTILITY FUNCTIONS (Ported from ref impl) ====================

    // Constants matching ref impl
    static BASE_FOLDER = '/data/gsc/';
    static NUM_ENTRIES = 0x100;  // 256
    static NUM_STATS = 6;
    static NAME_SIZE = 0x0B;  // 11
    static END_OF_LINE = 0x50;
    static MIN_LEVEL = 2;
    static MAX_LEVEL = 100;
    static HP_STAT_ID = 0;
    static EVERSTONE_ID = 0x70;
    static EGG_ID = 0xFD;
    static EGG_VALUE = 0x38;

    // Stat ID conversion tables (from ref impl)
    static STAT_ID_BASE_CONV_TABLE = [0, 1, 2, 5, 3, 4];
    static STAT_ID_IV_CONV_TABLE = [0, 0, 1, 2, 3, 3];
    static STAT_ID_EXP_CONV_TABLE = [0, 1, 2, 3, 4, 4];

    // Loaded data (populated by load())
    static baseStats = null;       // [256][6] base stats per species
    static expGroups = null;       // [256] EXP group per species
    static expLists = null;        // [num_groups][100] EXP required per level
    static evolutionIds = null;    // [256] = [canEvolve, itemNeeded, evolvesInto]
    static pokemonNames = null;    // [256][11] byte arrays of names
    static mailIds = null;         // [256] boolean - is mail item
    static learnsets = null;       // {species: {level: [moves]}}
    static noMailSection = null;   // Default empty mail section (385 bytes)
    static baseRandomSection = null; // Base random section (10 bytes)
    static eggNick = null;         // Egg nickname bytes
    static textConv = null;        // Text conversion dictionary
    static movesPpList = null;     // [256] PP values for each move

    static loaded = false;

    /**
     * Load all utility data files.
     */
    static async load() {
        if (this.loaded) return true;

        try {
            // Load base stats (stats.bin - 1536 bytes = 256 species * 6 stats)
            const statsData = await this.loadBinaryFile('stats.bin');
            if (statsData) {
                this.baseStats = this.prepareStats(statsData, this.NUM_STATS, this.NUM_ENTRIES);
            }

            // Load EXP groups (pokemon_exp_groups.bin - 256 bytes)
            this.expGroups = await this.loadBinaryFile('pokemon_exp_groups.bin');

            // Load EXP lists (pokemon_exp.txt)
            const expText = await this.loadTextFile('pokemon_exp.txt');
            if (expText) {
                this.expLists = this.prepareExpLists(expText);
            }

            // Load evolution data (evolution_ids.bin - 30 bytes)
            const evoData = await this.loadBinaryFile('evolution_ids.bin');
            if (evoData) {
                this.evolutionIds = this.prepareEvolutionList(evoData);
            }

            // Load mail IDs (ids_mail.bin)
            const mailData = await this.loadBinaryFile('ids_mail.bin');
            if (mailData) {
                this.mailIds = this.prepareCheckList(mailData);
            }

            // Load no mail section (no_mail_section.bin - 385 bytes)
            this.noMailSection = await this.loadBinaryFile('no_mail_section.bin');

            // Load moves PP list (moves_pp_list.bin - 256 bytes)
            this.movesPpList = await this.loadBinaryFile('moves_pp_list.bin');

            // Load base random section (base_random_section.bin - 10 bytes)
            this.baseRandomSection = await this.loadBinaryFile('base_random_section.bin');

            // Load egg nickname (egg_nick.bin - 11 bytes)
            this.eggNick = await this.loadBinaryFile('egg_nick.bin');

            // Load text conversion table
            const textConvText = await this.loadTextFile('text_conv.txt');
            if (textConvText) {
                this.textConv = this.prepareTextConv(textConvText);
            }

            // Load Pokemon names (pokemon_names.txt)
            const namesText = await this.loadTextFile('pokemon_names.txt');
            if (namesText && this.textConv) {
                this.pokemonNames = this.namesToByteArrays(namesText, this.textConv);
            }

            // Load learnsets (learnset_evos.bin)
            const learnsetData = await this.loadBinaryFile('learnset_evos.bin');
            if (learnsetData) {
                this.learnsets = this.prepareLearnsets(learnsetData);
            }

            // Load Japanese mail conversion tables
            await this.loadJapaneseMailData();

            this.loaded = true;
            console.log('[GSCUtils] Loaded all utility data files');
            return true;
        } catch (e) {
            console.error('[GSCUtils] Error loading utility data:', e);
            return false;

        }
    }

    // ==================== DATA LOADING HELPERS ====================

    static async loadBinaryFile(filename) {
        try {
            const response = await fetch(this.BASE_FOLDER + filename);
            if (!response.ok) return null;
            const buffer = await response.arrayBuffer();
            return new Uint8Array(buffer);
        } catch (e) {
            console.warn(`[GSCUtils] Could not load ${filename}:`, e);
            return null;
        }
    }

    static async loadTextFile(filename) {
        try {
            const response = await fetch(this.BASE_FOLDER + filename);
            if (!response.ok) return null;
            return await response.text();
        } catch (e) {
            console.warn(`[GSCUtils] Could not load ${filename}:`, e);
            return null;
        }
    }

    static prepareStats(data, numStats, numEntries) {
        const ret = [];
        for (let i = 0; i < numEntries; i++) {
            ret[i] = Array.from(data.slice(i * numStats, (i + 1) * numStats));
        }
        return ret;
    }

    static prepareExpLists(text) {
        // pokemon_exp.txt: one row per level (100 rows), 6 whitespace-separated
        // columns (one per growth group). Transposed like Python's
        // prepare_exp_lists so expLists[group][level-1] = cumulative EXP.
        const lines = text.trim().split('\n');
        const ret = [[], [], [], [], [], []];
        for (let level = 0; level < lines.length; level++) {
            const columns = lines[level].trim().split(/\s+/);
            for (let group = 0; group < 6; group++) {
                ret[group].push(parseInt(columns[group], 10));
            }
        }
        return ret;
    }

    static prepareEvolutionList(data) {
        // evolution_ids.bin format: 10 species that can evolve, 10 items, 10 target species
        // Each section is data_len = len/3 entries
        const ret = new Array(this.NUM_ENTRIES).fill(null).map(() => [false, null, null]);
        const dataLen = Math.floor(data.length / 3);

        for (let i = 0; i < dataLen; i++) {
            const species = data[i];
            const item = data[i + dataLen];
            const target = data[i + 2 * dataLen];

            if (item !== 0) {
                ret[species] = [true, item, target];
            } else {
                ret[species] = [true, null, target];
            }
        }
        return ret;
    }

    static prepareCheckList(data) {
        const ret = new Array(this.NUM_ENTRIES).fill(false);
        for (const byte of data) {
            if (byte < this.NUM_ENTRIES) {
                ret[byte] = true;
            }
        }
        return ret;
    }

    static prepareTextConv(text) {
        // Format: "A 128" per line (character space decimal_value)
        const dict = {};
        const lines = text.trim().split('\n');
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const char = parts[0];
                const value = parseInt(parts[1], 10);
                if (char && !isNaN(value)) {
                    dict[char.toUpperCase()] = value;
                    dict[char.toLowerCase()] = value;
                }
            }
        }
        dict['\n'] = this.END_OF_LINE;
        return dict;
    }

    static namesToByteArrays(namesText, textConv) {
        // Convert Pokemon names to byte arrays using text conversion
        const lines = namesText.trim().split('\n');
        const ret = [];

        for (let i = 0; i < this.NUM_ENTRIES; i++) {
            const nameBytes = new Array(this.NAME_SIZE).fill(this.END_OF_LINE);
            const name = lines[i] || '';

            for (let j = 0; j < name.length && j < this.NAME_SIZE; j++) {
                const char = name[j].toUpperCase();
                if (textConv[char] !== undefined) {
                    nameBytes[j] = textConv[char];
                }
            }
            ret.push(nameBytes);
        }
        return ret;
    }

    static prepareLearnsets(data) {
        // learnset_evos.bin format: species, num_levels, then for each: level, num_moves, moves...
        const dict = {};
        let pos = 0;
        const numSpecies = data[pos++];

        for (let i = 0; i < numSpecies && pos < data.length; i++) {
            const species = data[pos++];
            const numLevels = data[pos++];
            const entry = {};

            for (let j = 0; j < numLevels && pos < data.length; j++) {
                const level = data[pos++];
                const numMoves = data[pos++];
                const moves = [];
                for (let k = 0; k < numMoves && pos < data.length; k++) {
                    moves.push(data[pos++]);
                }
                entry[level] = moves;
            }
            dict[species] = entry;
        }
        return dict;
    }

    // ==================== STAT & LEVEL CALCULATION ====================

    /**
     * Get base stat for a species.
     * @param {number} species - Pokemon species ID
     * @param {number} statId - Stat ID (0=HP, 1=ATK, 2=DEF, 3=SPD, 4=SPATK, 5=SPDEF)
     * @returns {number} Base stat value
     */
    static getBaseStat(species, statId) {
        if (!this.baseStats || species >= this.NUM_ENTRIES || species < 0) return 0;
        const convertedId = this.STAT_ID_BASE_CONV_TABLE[statId] || 0;
        return this.baseStats[species]?.[convertedId] || 0;
    }

    /**
     * Get IV for a stat from IV array.
     * @param {number[]} iv - Array of 4 IV values [ATK, DEF, SPD, SPC]
     * @param {number} statId - Stat ID
     * @returns {number} IV value (0-15)
     */
    static getIV(iv, statId) {
        if (statId !== this.HP_STAT_ID) {
            return iv[this.STAT_ID_IV_CONV_TABLE[statId]] || 0;
        }
        // HP IV is derived from other IVs
        return ((iv[0] & 1) << 3) | ((iv[1] & 1) << 2) | ((iv[2] & 1) << 1) | (iv[3] & 1);
    }

    /**
     * Get stat EXP contribution.
     */
    static getStatExpContribution(statExp) {
        let val = Math.ceil(Math.sqrt(statExp));
        if (val >= 0x100) val = 0xFF;
        return Math.floor(val / 4);
    }

    /**
     * Calculate a stat value.
     */
    static statCalculation(statId, species, ivs, statExp, level, doExp = true) {
        let interValue = (this.getBaseStat(species, statId) + this.getIV(ivs, statId)) * 2;
        if (doExp && statExp) {
            const expContrib = this.getStatExpContribution(statExp[this.STAT_ID_EXP_CONV_TABLE[statId]] || 0);
            interValue += expContrib;
        }
        interValue = Math.floor((interValue * level) / 100);

        // Final step: HP gets level+10, others get +5
        if (statId === this.HP_STAT_ID) {
            return interValue + level + 10;
        }
        return interValue + 5;
    }

    /**
     * Get EXP required for a level.
     */
    static getExpLevel(species, level) {
        if (!this.expGroups || !this.expLists) return 0;
        const group = this.expGroups[species] || 0;
        if (!this.expLists[group]) return 0;
        return this.expLists[group][level - 1] || 0;
    }

    /**
     * Get level from EXP value.
     * Uses binary search like ref impl implementation.
     */
    static getLevelExp(species, exp) {
        let start = this.MIN_LEVEL;
        let end = this.MAX_LEVEL;

        if (exp < this.getExpLevel(species, start + 1)) {
            return start;
        }
        if (exp >= this.getExpLevel(species, end)) {
            return end;
        }

        while (start < end) {
            const checkLevel = Math.floor((start + end) / 2);
            const levelExp = this.getExpLevel(species, checkLevel);
            const nextLevelExp = this.getExpLevel(species, checkLevel + 1);

            if (exp < levelExp) {
                end = checkLevel;
            } else if (exp > nextLevelExp) {
                start = checkLevel;
            } else if (exp === nextLevelExp) {
                return checkLevel + 1;
            } else {
                return checkLevel;
            }
        }
        return this.MAX_LEVEL;
    }

    // ==================== EVOLUTION ====================

    /**
     * Check if a Pokemon evolves via trade.
     */
    static isEvolving(species, item) {
        if (species >= this.NUM_ENTRIES || species < 0) return false;
        if (!this.evolutionIds) return false;

        const evoInfo = this.evolutionIds[species];
        if (!evoInfo || !evoInfo[0]) return false;  // Can't evolve

        if (item === this.EVERSTONE_ID) return false;  // Everstone blocks evolution

        // If no item needed, or held item matches required item
        if (evoInfo[1] === null || item === evoInfo[1]) {
            return true;
        }
        return false;
    }

    /**
     * Get evolution target species.
     */
    static getEvolution(species, item) {
        if (!this.isEvolving(species, item)) return null;
        return this.evolutionIds[species][2];
    }

    /**
     * Get moves learned on evolution to a level.
     */
    static getLearnset(species, level) {
        if (!this.learnsets || !this.learnsets[species]) return null;
        return this.learnsets[species][level] || null;
    }

    // ==================== MAIL ====================

    /**
     * Check if an item is mail.
     */
    static isItemMail(item) {
        if (!this.mailIds || item >= this.NUM_ENTRIES) return false;
        return this.mailIds[item];
    }

    /**
     * Get Pokemon name as byte array.
     */
    static getPokemonName(species) {
        if (!this.pokemonNames || species >= this.NUM_ENTRIES) return null;
        return this.pokemonNames[species];
    }

    // ==================== PATCH HANDLING ====================

    /**
     * Get patch set parameters for Pokemon or Mail data.
     * @param {boolean} isMail - True if processing mail data
     * @param {boolean} isJapanese - True if Japanese mail format
     * @returns {[number, number]} [patchSetsNum, patchSetsIndex]
     */
    static getPatchSetNumIndex(isMail, isJapanese = false) {
        let patchSetsNum = 2;
        let patchSetsIndex = 0;
        if (isMail) {
            patchSetsNum = 1;
            patchSetsIndex = 1;
            if (isJapanese) {
                patchSetsIndex = 2;
            }
        }
        return [patchSetsNum, patchSetsIndex];
    }

    /**
     * Apply patches to data - restores 0xFE bytes from patch offsets.
     * Reverse of createPatchesData().
     * @param {Uint8Array} data - The data to apply patches to (modified in place)
     * @param {Uint8Array} patchSet - The patch set data
     * @param {boolean} isMail - True if mail data
     * @param {boolean} isJapanese - True if Japanese format
     */
    static applyPatches(data, patchSet, isMail = false, isJapanese = false) {
        const [patchSetsNum, patchSetsIndex] = this.getPatchSetNumIndex(isMail, isJapanese);

        let base = this.patch_set_base_pos[patchSetsIndex];
        let start = this.patch_set_start_info_pos[patchSetsIndex];
        let i = 0;
        let remaining = patchSetsNum;

        while (remaining > 0 && (start + i) < patchSet.length) {
            const readPos = patchSet[start + i];
            i++;

            if (readPos === 0xFF) {
                remaining--;
                base += 0xFC;
            } else if (readPos > 0 && (readPos + base - 1) < data.length) {
                data[readPos + base - 1] = 0xFE;
            }
        }
    }

    // ==================== JAPANESE MAIL SUPPORT ====================

    // Japanese mail data (loaded by load())
    static japanesMailPatchSet = null;
    static mailChecksJp = null;
    static mailConvEnToJp = null;
    static mailConvJpToEn = null;

    /**
     * Load Japanese mail data files.
     * Called as part of load() if files exist.
     */
    static async loadJapaneseMailData() {
        try {
            this.japanesMailPatchSet = await this.loadBinaryFile('japanese_mail_patch_set.bin');
            this.mailChecksJp = await this.loadBinaryFile('mail_checks_jp.bin');
            this.mailConvEnToJp = await this.loadBinaryFile('mail_conversion_table_en_to_jp.bin');
            this.mailConvJpToEn = await this.loadBinaryFile('mail_conversion_table_jp_to_en.bin');

            if (this.mailConvEnToJp && this.mailConvJpToEn) {
                console.log('[GSCUtils] Loaded Japanese mail conversion tables');
                return true;
            }
        } catch (e) {
            console.warn('[GSCUtils] Japanese mail data not loaded:', e);
        }
        return false;
    }

    /**
     * Check if mail section appears to be Japanese format.
     * Japanese mail uses different byte ranges.
     * @param {Uint8Array} mailData - Mail section data
     * @returns {boolean} True if Japanese format detected
     */
    static isJapaneseMail(mailData) {
        if (!mailData || mailData.length < 10) return false;
        // Japanese text uses bytes 0x00-0x4F for katakana/hiragana
        // English text uses 0x80-0xBF range
        // Check first few message bytes for patterns
        for (let i = 0; i < Math.min(10, mailData.length); i++) {
            // Japanese character range check
            if (mailData[i] > 0 && mailData[i] < 0x50) {
                return true;
            }
        }
        return false;
    }

    /**
     * Convert mail message from English to Japanese format.
     * @param {Uint8Array} mailData - English mail data
     * @returns {Uint8Array} Japanese-converted mail data
     */
    static convertMailEnToJp(mailData) {
        if (!this.mailConvEnToJp || !mailData) return mailData;

        const result = new Uint8Array(mailData.length);
        for (let i = 0; i < mailData.length; i++) {
            const byte = mailData[i];
            if (byte < this.mailConvEnToJp.length) {
                result[i] = this.mailConvEnToJp[byte] || byte;
            } else {
                result[i] = byte;
            }
        }
        return result;
    }

    /**
     * Convert mail message from Japanese to English format.
     * @param {Uint8Array} mailData - Japanese mail data
     * @returns {Uint8Array} English-converted mail data
     */
    static convertMailJpToEn(mailData) {
        if (!this.mailConvJpToEn || !mailData) return mailData;

        const result = new Uint8Array(mailData.length);
        for (let i = 0; i < mailData.length; i++) {
            const byte = mailData[i];
            if (byte < this.mailConvJpToEn.length) {
                result[i] = this.mailConvJpToEn[byte] || byte;
            } else {
                result[i] = byte;
            }
        }
        return result;
    }

    // ==================== ADDITIONAL EVOLUTION HELPERS ====================

    /**
     * Get the item required to trigger evolution for a species.
     * @param {number} species - Pokemon species ID
     * @returns {number|null} Item ID required, or null if no item needed
     */
    static getEvolutionItem(species) {
        if (!this.evolutionIds || species >= this.NUM_ENTRIES) return null;
        const evoInfo = this.evolutionIds[species];
        if (evoInfo && evoInfo[0]) {
            return evoInfo[1]; // Item ID or null
        }
        return null;
    }

    /**
     * Get all species that evolve via trade.
     * @returns {number[]} Array of species IDs that evolve on trade
     */
    static getTradeEvolutionSpecies() {
        if (!this.evolutionIds) return [];
        const species = [];
        for (let i = 0; i < this.NUM_ENTRIES; i++) {
            if (this.evolutionIds[i] && this.evolutionIds[i][0]) {
                species.push(i);
            }
        }
        return species;
    }
}
