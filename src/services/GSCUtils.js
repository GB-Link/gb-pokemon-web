import { GSCPokemonInfo } from './GSCPokemonInfo.js?v=100';
import { GSCChecks } from './GSCChecks.js?v=100';
import { PokemonNamesForGen, PokemonTextConversions } from './TextConversions.js?v=100';

// Python list indexing: negative indexes count from the end, anything else
// out of range throws.
export function pyIndex(seq, index) {
    if (seq === null || seq === undefined) throw new TypeError('object is not subscriptable');
    const i = index < 0 ? seq.length + index : index;
    if (!Number.isInteger(i) || i < 0 || i >= seq.length) throw new RangeError(`index ${index} out of range`);
    return seq[i];
}

export function pySlice(seq, start, end) {
    if (seq === null || seq === undefined) throw new TypeError('object is not subscriptable');
    return Array.prototype.slice.call(seq, start, end);
}

export function pyLen(value) {
    if (typeof value === 'string') return Array.from(value).length;
    if (value === null || value === undefined) throw new TypeError('object has no len()');
    return value.length;
}

export function pyListEquals(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Loaders for the binary/text tables in data/<gen>/.
 */
export class GSCUtilsLoaders {
    static prepareExpLists(lines, maxLevel) {
        const expLists = [[], [], [], [], [], []];
        for (let i = 0; i < maxLevel; i++) {
            const columns = pyIndex(lines, i).trim().split(/\s+/);
            for (let j = 0; j < 6; j++) expLists[j].push(parseInt(pyIndex(columns, j), 10));
        }
        return expLists;
    }

    static prepareLearnsets(data) {
        const learnsets = new Map();
        const entries = pyIndex(data, 0);
        for (let i = 0; i < entries; i++) {
            let pos = GSCUtilsMisc.readShort(data, 1 + (i * 2));
            const entry = new Map();
            const species = pyIndex(data, pos);
            const levels = pyIndex(data, pos + 1);
            pos += 2;
            for (let j = 0; j < levels; j++) {
                const level = pyIndex(data, pos);
                const numMoves = pyIndex(data, pos + 1);
                const movesList = [];
                pos += 2;
                for (let k = 0; k < numMoves; k++) {
                    movesList.push(pyIndex(data, pos));
                    pos += 1;
                }
                entry.set(level, movesList);
            }
            learnsets.set(species, entry);
        }
        return learnsets;
    }

    static prepareCheckList(data) {
        const ret = new Array(0x100).fill(false);
        if (data) {
            for (const i of data) ret[i] = true;
        }
        return ret;
    }

    static prepareEvolutionCheckList(data) {
        const ret = new Array(0x100).fill(null).map(() => [false, null, null]);
        if (data) {
            const dataLen = Math.floor(data.length / 3);
            for (let i = 0; i < dataLen; i++) {
                ret[data[i]] = [true, null, data[i + (2 * dataLen)]];
                if (data[i + dataLen] !== 0) ret[data[i]] = [true, data[i + dataLen], data[i + (2 * dataLen)]];
            }
        }
        return ret;
    }

    static prepareStats(data, numStats, numEntries) {
        const ret = new Array(numEntries);
        for (let i = 0; i < numEntries; i++) ret[i] = pySlice(data, i * numStats, (i + 1) * numStats);
        return ret;
    }

    static prepareFunctionsMap(data, functions) {
        const callMap = new Array(data.length);
        for (let i = 0; i < data.length; i++) callMap[i] = pyIndex(functions, data[i]);
        return callMap;
    }

    static loadReplacementDataDoubleDict(data, dataLen = 1) {
        const outForward = new Map();
        const outBackwards = new Map();
        const entryLen = dataLen * 2;
        for (let i = 0; i < Math.floor(data.length / entryLen); i++) {
            const entryPos = i * entryLen;
            const elemOne = GSCUtilsMisc.fromNBytesLE(data, dataLen, entryPos);
            const elemTwo = GSCUtilsMisc.fromNBytesLE(data, dataLen, entryPos + dataLen);
            outForward.set(elemOne, elemTwo);
            outBackwards.set(elemTwo, elemOne);
        }
        return [outForward, outBackwards];
    }
}

/**
 * Generic byte helpers with the reference client's list semantics.
 */
export class GSCUtilsMisc {
    static readNybbles(val) {
        return [(val & 0xF0) >> 4, val & 0xF];
    }

    static readShortLE(data, pos) {
        return pyIndex(data, pos) + (pyIndex(data, pos + 1) << 8);
    }

    static readIntLE(data, pos) {
        return (pyIndex(data, pos) + (pyIndex(data, pos + 1) << 8) + (pyIndex(data, pos + 2) << 16) + (pyIndex(data, pos + 3) * 0x1000000));
    }

    static readShort(data, pos) {
        return (pyIndex(data, pos) << 8) + pyIndex(data, pos + 1);
    }

    static writeShort(data, pos, shortData) {
        GSCUtilsMisc.setItem(data, pos, (shortData >> 8) & 0xFF);
        GSCUtilsMisc.setItem(data, pos + 1, shortData & 0xFF);
    }

    static writeIntLE(data, pos, intData) {
        GSCUtilsMisc.setItem(data, pos, intData & 0xFF);
        GSCUtilsMisc.setItem(data, pos + 1, (intData >>> 8) & 0xFF);
        GSCUtilsMisc.setItem(data, pos + 2, (intData >>> 16) & 0xFF);
        GSCUtilsMisc.setItem(data, pos + 3, (intData >>> 24) & 0xFF);
    }

    static writeShortLE(data, pos, shortData) {
        GSCUtilsMisc.setItem(data, pos, shortData & 0xFF);
        GSCUtilsMisc.setItem(data, pos + 1, (shortData >> 8) & 0xFF);
    }

    static toNBytesLE(inData, nBytes) {
        const data = new Array(nBytes).fill(0);
        for (let i = 0; i < nBytes; i++) data[i] = Math.floor(inData / (2 ** (8 * i))) & 0xFF;
        return data;
    }

    static fromNBytesLE(data, nBytes, start = 0) {
        let outData = 0;
        for (let i = 0; i < nBytes; i++) outData += pyIndex(data, start + i) * (2 ** (8 * i));
        return outData;
    }

    // Python item assignment: out of range throws instead of growing the list
    static setItem(data, index, value) {
        const i = index < 0 ? data.length + index : index;
        if (!Number.isInteger(i) || i < 0 || i >= data.length) throw new RangeError(`assignment index ${index} out of range`);
        data[i] = value;
    }

    // data[pos:pos+length] = values[:length] - the list grows or shrinks when
    // the two sides differ in length, like a Python slice assignment
    static copyToData(data, pos, values, length = null) {
        if (length === null || length === undefined) length = values.length;
        const src = pySlice(values, 0, Math.max(0, length));
        const start = Math.min(pos, data.length);
        const end = Math.max(start, Math.min(pos + length, data.length));
        if (end - start === src.length) {
            for (let i = 0; i < src.length; i++) data[start + i] = src[i];
            return;
        }
        if (!Array.isArray(data)) throw new TypeError('cannot resize a fixed-length buffer');
        data.splice(start, end - start, ...src);
    }

    static checkNormalList(checkingList, value) {
        if (value === null || value === undefined) throw new TypeError('missing value');
        if (value >= 0x100 || value < 0) return false;
        return checkingList[value];
    }

    static divideData(data, lengths) {
        const divData = [];
        const totalLengths = GSCUtilsMisc.calcDivideLengths(lengths);
        for (let i = 0; i < lengths.length; i++) divData.push(pySlice(data, totalLengths[i], totalLengths[i + 1]));
        return divData;
    }

    static calcDivideLengths(lengths) {
        const totalLengths = [];
        let currLen = 0;
        for (let i = 0; i < lengths.length; i++) {
            totalLengths.push(currLen);
            currLen += lengths[i];
        }
        totalLengths.push(currLen);
        return totalLengths;
    }

    static defaultIfNone(data, defaultData) {
        if (data !== null && data !== undefined) return data;
        return defaultData;
    }
}

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
    static trading_pokemon_mail_sender_pos = 0xC6; // In section 3 (0x21-byte mail layout)

    // Party patches, 0x41-byte mail, Japanese mail, 0x21-byte mail
    static patch_set_base_pos = [0x13, 0x186, 0, 0xC6];
    static patch_set_start_info_pos = [7, 0x1DA, 0xFC, 0x11A];

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

    /**
     * Turn every 0xFE of the data into 0xFF and record its position in the
     * patch set. isOldMailData picks the 0x21-byte (0x181 section) mail
     * layout; left undefined, a mail section is taken as old when it is too
     * short to hold the 0x41-byte layout's patch list.
     */
    static createPatchesData(data, patchSet, isMail = false, isJapanese = false, isOldMailData = undefined) {
        if (isOldMailData === undefined) isOldMailData = this.isOldMailSection(patchSet, isMail, isJapanese);
        const [numSets, patchSetsIndex] = this.getPatchSetNumIndex(isMail, isJapanese, isOldMailData);
        let patchSetsNum = numSets;

        let base = this.patch_set_base_pos[patchSetsIndex];
        const start = this.patch_set_start_info_pos[patchSetsIndex];
        let i = 0;
        let j = 0;
        while ((patchSetsNum > 0) && ((start + i) < patchSet.length) && ((base + j) < data.length)) {
            const readData = data[base + j];
            if (readData === 0xFE) {
                data[base + j] = 0xFF;
                patchSet[start + i] = j + 1;
                i += 1;
            }
            j += 1;
            if (j === 0xFC) {
                base += 0xFC;
                j = 0;
                // A full patch list just ends here instead of overflowing
                if ((start + i) < patchSet.length) patchSet[start + i] = 0xFF;
                i += 1;
                patchSetsNum -= 1;
            }
        }

        if (j !== 0) {
            if ((start + i) >= patchSet.length) {
                i = patchSet.length - start - 1;
            }
            GSCUtilsMisc.setItem(patchSet, start + i, 0xFF);
            i += 1;
        }
    }

    static isOldMailSection(patchSet, isMail, isJapanese) {
        if (!isMail || isJapanese) return false;
        return patchSet.length <= this.patch_set_start_info_pos[1];
    }

    // ==================== DATA MODEL ====================

    static BASE_FOLDER = '/data/gsc/';
    // Files a generation doesn't ship (skipped instead of fetched)
    static ABSENT_FILES = new Set();
    static NUM_ENTRIES = 0x100;  // 256
    static NUM_STATS = 6;
    static NAME_SIZE = 0x0B;  // 11
    static MIN_LEVEL = 2;
    static MAX_LEVEL = 100;
    static HP_STAT_ID = 0;
    static EVERSTONE_ID = 0x70;
    static EGG_ID = 0xFD;
    static EGG_VALUE = 0x38;

    // Stat ID conversion tables
    static STAT_ID_BASE_CONV_TABLE = [0, 1, 2, 5, 3, 4];
    static STAT_ID_IV_CONV_TABLE = [0, 0, 1, 2, 3, 3];
    static STAT_ID_EXP_CONV_TABLE = [0, 1, 2, 3, 4, 4];

    // Bit 31 of a language mask: the Korean name is in the 2-byte charset
    static KOREAN_LANGUAGE_2_BYTES_SPECIAL_LANGUAGE = 0x1F;
    static KOREAN_SPECIAL_REPLACEMENT = 0x6B;
    static KOREAN_PATCHED_SPECIAL_REPLACEMENT = 0x6C;
    static NUM_VALID_USER_INPUT_TABLES = 0xC;
    static EOL_USER_INPUT_TABLE_VALUE = 0xC;
    static JPN_NAME_LEN = 5;
    static START_VALID_USER_INPUT_TABLES_BYTE = 0x100 - (0xC * 0xC);
    static PROHIBITED_CHAR = 0xFE;
    static PROHIBITED_CHAR_REPLACEMENT = 0x2D;

    // Loaded data (populated by load())
    static baseStats = null;       // [256][6] base stats per species
    static expGroups = null;       // [256] EXP group per species
    static expLists = null;        // [num_groups][100] EXP required per level
    static evolutionIds = null;    // [256] = [canEvolve, itemNeeded, evolvesInto]
    static mailIds = null;         // [256] boolean - is mail item
    static learnsets = null;       // Map species -> Map level -> [moves]
    static noMailSection = null;   // Empty 0x41-byte-mail section (0x241 bytes)
    static noMailSectionOld = null; // Empty 0x21-byte-mail section (0x181 bytes)
    static baseRandomSection = null; // Base random section (10 bytes)
    static eggNick = null;         // Egg nickname bytes
    static textConv = null;        // Text conversion dictionary
    static movesPpList = null;     // [256] PP values for each move
    static badIdsTextSpecialToKor = null;
    static badIdsTextSpecialFromKor = null;
    static badIdsTextKorFullList = null;

    static loaded = false;

    /**
     * Load all utility data files, plus the shared text tables.
     */
    static async load() {
        if (Object.prototype.hasOwnProperty.call(this, 'loaded') && this.loaded) return true;

        try {
            const statsData = await this.loadBinaryFile('stats.bin');
            this.baseStats = statsData ? GSCUtilsLoaders.prepareStats(statsData, this.NUM_STATS, this.NUM_ENTRIES) : null;

            this.expGroups = await this.loadBinaryFile('pokemon_exp_groups.bin');

            const expText = await this.loadTextFile('pokemon_exp.txt');
            this.expLists = expText ? GSCUtilsLoaders.prepareExpLists(expText.split('\n'), this.MAX_LEVEL) : null;

            this.evolutionIds = GSCUtilsLoaders.prepareEvolutionCheckList(await this.loadBinaryFile('evolution_ids.bin'));
            this.mailIds = GSCUtilsLoaders.prepareCheckList(await this.loadBinaryFile('ids_mail.bin'));

            this.noMailSection = this.toList(await this.loadBinaryFile('no_mail_section.bin'));
            this.noMailSectionOld = this.toList(await this.loadBinaryFile('no_mail_section_old.bin'));
            this.movesPpList = await this.loadBinaryFile('moves_pp_list.bin');
            this.baseRandomSection = await this.loadBinaryFile('base_random_section.bin');

            const learnsetData = await this.loadBinaryFile('learnset_evos.bin');
            this.learnsets = learnsetData ? GSCUtilsLoaders.prepareLearnsets(learnsetData) : null;

            const specialKor = await this.loadBinaryFile('bad_ids_and_replacement_text_special_kor.bin');
            [this.badIdsTextSpecialToKor, this.badIdsTextSpecialFromKor] = GSCUtilsLoaders.loadReplacementDataDoubleDict(specialKor || []);
            this.badIdsTextKorFullList = this.toList(await this.loadBinaryFile('bad_ids_text_full_kor.bin'));

            // Web-only tables kept for the older byte-level helpers
            this.eggNick = await this.loadBinaryFile('egg_nick.bin');
            const textConvText = await this.loadTextFile('text_conv.txt');
            this.textConv = textConvText ? this.prepareTextConv(textConvText) : null;
            const namesText = await this.loadTextFile('pokemon_names.txt');
            if (namesText && this.textConv) {
                this.pokemonNames = this.namesToByteArrays(namesText, this.textConv);
            }
            await this.loadJapaneseMailData();

            try {
                await PokemonNamesForGen.load();
            } catch (e) {
                console.warn('[GSCUtils] Text tables not loaded:', e);
            }

            this.loaded = true;
            return true;
        } catch (e) {
            console.error('[GSCUtils] Error loading utility data:', e);
            return false;
        }
    }

    static toList(data) {
        return data ? Array.from(data) : null;
    }

    // ==================== DATA LOADING HELPERS ====================

    static async loadBinaryFile(filename) {
        if (this.ABSENT_FILES.has(filename)) return null;
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
        if (this.ABSENT_FILES.has(filename)) return null;
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
        return GSCUtilsLoaders.prepareStats(data, numStats, numEntries);
    }

    static prepareExpLists(text) {
        return GSCUtilsLoaders.prepareExpLists(text.split('\n'), this.MAX_LEVEL);
    }

    static prepareEvolutionList(data) {
        return GSCUtilsLoaders.prepareEvolutionCheckList(data);
    }

    static prepareCheckList(data) {
        return GSCUtilsLoaders.prepareCheckList(data);
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
        return GSCUtilsLoaders.prepareLearnsets(data);
    }

    // ==================== STAT & LEVEL CALCULATION ====================

    static getLevelExp(species, exp) {
        let start = this.MIN_LEVEL;
        let end = this.MAX_LEVEL;
        if (exp < this.getExpLevel(species, start + 1)) return start;
        if (exp >= this.getExpLevel(species, end)) return end;
        for (;;) {
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
    }

    static getExpLevel(species, level) {
        return pyIndex(pyIndex(this.expLists, pyIndex(this.expGroups, species)), level - 1);
    }

    static finalStatCalcStep(statId, level) {
        if (statId !== this.HP_STAT_ID) return 5;
        return level + 10;
    }

    static getIv(iv, statId) {
        if (statId !== this.HP_STAT_ID) return pyIndex(iv, pyIndex(this.STAT_ID_IV_CONV_TABLE, statId));
        return ((iv[0] & 1) << 3) | ((iv[1] & 1) << 2) | ((iv[2] & 1) << 1) | (iv[3] & 1);
    }

    static getIV(iv, statId) {
        return this.getIv(iv, statId);
    }

    static getExp(statExp, statId) {
        return pyIndex(statExp, pyIndex(this.STAT_ID_EXP_CONV_TABLE, statId));
    }

    static getBaseStat(species, statId) {
        return pyIndex(pyIndex(this.baseStats, species), pyIndex(this.STAT_ID_BASE_CONV_TABLE, statId));
    }

    static getStatExpContribution(statExp) {
        let val = Math.ceil(Math.sqrt(statExp));
        if (val >= 0x100) val = 0xFF;
        return Math.floor(val / 4);
    }

    static statCalculation(statId, species, ivs, statExp, level, doExp = true) {
        let interValue = (this.getBaseStat(species, statId) + this.getIv(ivs, statId)) * 2;
        if (doExp) interValue += this.getStatExpContribution(this.getExp(statExp, statId));
        interValue = Math.floor((interValue * level) / 100);
        return interValue + this.finalStatCalcStep(statId, level);
    }

    // ==================== EVOLUTION ====================

    static isEvolving(species, item) {
        if (species >= this.NUM_ENTRIES || species < 0) return false;
        if (!this.evolutionIds) return false;
        const evoInfo = this.evolutionIds[species];
        if (evoInfo[0]) {
            if (item !== this.EVERSTONE_ID) {
                if ((evoInfo[1] === null) || (item === evoInfo[1])) return true;
            }
        }
        return false;
    }

    static getEvolution(species, item) {
        if (!this.isEvolving(species, item)) return null;
        return this.evolutionIds[species][2];
    }

    /**
     * Get moves learned on evolution to a level.
     */
    static getLearnset(species, level) {
        if (!this.learnsets || !this.learnsets.has(species)) return null;
        return this.learnsets.get(species).get(level) || null;
    }

    // ==================== MAIL ====================

    static isItemMail(item) {
        if (!this.mailIds) return false;
        return GSCUtilsMisc.checkNormalList(this.mailIds, item);
    }

    /**
     * Get Pokemon name as byte array.
     */
    static getPokemonName(species) {
        if (!this.pokemonNames || species >= this.NUM_ENTRIES) return null;
        return this.pokemonNames[species];
    }

    // ==================== PATCH HANDLING ====================

    static getPatchSetNumIndex(isMail, isJapanese = false, isOldMailData = false) {
        let patchSetsNum = 2;
        let patchSetsIndex = 0;
        if (isMail) {
            patchSetsNum = 1;
            patchSetsIndex = 1;
            if (isOldMailData) patchSetsIndex = 3;
            // Japanese mail only has one layout
            if (isJapanese) patchSetsIndex = 2;
        }
        return [patchSetsNum, patchSetsIndex];
    }

    /**
     * Restore the 0xFE bytes listed in the patch set. isOldMailData as in
     * createPatchesData().
     */
    static applyPatches(data, patchSet, isMail = false, isJapanese = false, isOldMailData = undefined) {
        if (isOldMailData === undefined) isOldMailData = this.isOldMailSection(patchSet, isMail, isJapanese);
        let [patchSetsNum, patchSetsIndex] = this.getPatchSetNumIndex(isMail, isJapanese, isOldMailData);

        let base = this.patch_set_base_pos[patchSetsIndex];
        const start = this.patch_set_start_info_pos[patchSetsIndex];
        let i = 0;
        while ((patchSetsNum > 0) && ((start + i) < patchSet.length)) {
            const readPos = patchSet[start + i];
            i += 1;
            if (readPos === 0xFF) {
                patchSetsNum -= 1;
                base += 0xFC;
            } else if (readPos > 0 && (readPos + base) <= data.length) {
                data[readPos + base - 1] = 0xFE;
            }
        }
    }

    // ==================== SINGLE POKEMON TRANSFERS ====================

    static convertLanguageIntToList(languagesInt) {
        const retVal = [];
        let value = languagesInt >>> 0;
        let index = 0;
        while (value !== 0) {
            if ((value >>> index) & 1) {
                value = (value & ~(1 << index)) >>> 0;
                if (index !== GSCUtils.KOREAN_LANGUAGE_2_BYTES_SPECIAL_LANGUAGE) retVal.push(index);
            }
            index += 1;
        }
        return retVal;
    }

    static convertLanguageListToInt(languagesList, monData, gen) {
        let retVal = 0;
        const mon = monData[0];
        languagesList = Array.from(languagesList);
        if (languagesList.length <= 0) return retVal;

        for (const language of languagesList) {
            retVal = (retVal | (2 ** language)) >>> 0;
            if (language === PokemonNamesForGen.KOREAN_LANGUAGE) {
                let [, isPartial] = PokemonTextConversions.convertGenxCharToChar(pyIndex(mon.nickname.values, 0), gen, language);
                if (isPartial) {
                    [, isPartial] = PokemonTextConversions.convertGenxCharToChar(pyIndex(mon.otName.values, 0), gen, language);
                }
                if (isPartial) {
                    retVal = (retVal | (2 ** GSCUtils.KOREAN_LANGUAGE_2_BYTES_SPECIAL_LANGUAGE)) >>> 0;
                }
            }
        }
        return retVal;
    }

    static getSinglePokemonInfoClass() {
        return GSCPokemonInfo;
    }

    /**
     * Run singleMonFromData() under every game language and keep the result
     * whose names read back unchanged.
     * @returns {Array|null} [mon, isEgg, languageMask]
     */
    static singleMonFromDataMultilanguage(checks, data) {
        const languageMatchList = [];
        const languageRetDataDict = new Map();
        const gen = this.getSinglePokemonInfoClass().REFERENCE_GEN;

        for (const language of PokemonNamesForGen.ALL_LANGUAGES_LIST) {
            const nonChecked = this.getSinglePokemonInfoClass().setData(data);
            nonChecked.applyAllTextTransformsToAll(language);

            checks.language = language;
            const retData = this.singleMonFromData(checks, data);

            if (retData === null) continue;

            languageRetDataDict.set(language, retData);

            if (retData[0].nickname.getLength() > PokemonNamesForGen.getPokemonMaxNicknameLength(gen, language)) continue;
            if (retData[0].otName.getLength() > PokemonNamesForGen.getTrainerMaxNameLength(gen, language)) continue;

            if (retData[0].isTextEqual(nonChecked, false)) languageMatchList.push(language);
        }

        if (languageRetDataDict.size <= 0) return null;

        let languageRefList = languageMatchList;
        if (languageMatchList.length <= 0) languageRefList = Array.from(languageRetDataDict.keys());
        const monDataOut = languageRetDataDict.get(languageRefList[0]);

        return monDataOut.concat([GSCUtils.convertLanguageListToInt(languageRefList, monDataOut, gen)]);
    }

    /**
     * Sanity-check a single-Pokémon record (CHC/pool): the 0x41-byte mail
     * layout when it is longer than the old record, else the 0x21-byte one.
     * @returns {Array|null} [mon, isEgg]
     */
    static singleMonFromData(checks, data) {
        let ret = null;

        checks.resetSpeciesItemList();
        checks.setSingleTeamSize();
        checks.resetTextBuffers();
        checks.preparePatchSetsBuffer();
        checks.prepareSpeciesBuffer();
        let checker = checks.singlePokemonChecksMap;
        let hasNewMailData = true;
        if (data.length <= checker.length) {
            checker = checks.singlePokemonChecksMapOld;
            hasNewMailData = false;
        }

        if (data.length > checker.length) {
            const raw = GSCPokemonInfo.setData(data, hasNewMailData);

            let isEgg = false;
            if (data[checker.length] === GSCUtils.EGG_VALUE) isEgg = true;

            if (isEgg) checks.speciesCleaner(GSCUtils.EGG_ID);
            else checks.speciesCleaner(data[0]);
            checks.prepareSpeciesBuffer();

            // A converted Korean mail already carries its own newline/EOL
            if (raw.hasMail()) {
                if (raw.mail.getMailLanguage() === PokemonNamesForGen.KOREAN_LANGUAGE) checks.doMailNewlineChecks = false;
            }

            const purifiedData = checks.applyChecksToData(checker, data);
            const mon = GSCPokemonInfo.setData(purifiedData, hasNewMailData);

            if (!mon.hasChangedSignificantly(raw)) ret = [mon, isEgg];
        }
        return ret;
    }

    static singleMonToData(mon, isEgg, useNewMailData = true) {
        let eggVal = 0;
        if (isEgg) eggVal = GSCUtils.EGG_VALUE;
        return mon.getData(useNewMailData).concat([eggVal]);
    }

    // ==================== KOREAN/JAPANESE NAME PROTECTION ====================

    static processFromKoreanSpecialTableValue(inData, isFirstNybble) {
        let tableValue = 0;
        const diff = inData - this.START_VALID_USER_INPUT_TABLES_BYTE;
        const n = this.NUM_VALID_USER_INPUT_TABLES;
        if (isFirstNybble) tableValue = (((diff % n) + n) % n) + 1;
        else tableValue = Math.floor(diff / n) + 1;
        if (tableValue === this.EOL_USER_INPUT_TABLE_VALUE) tableValue = this.END_OF_LINE;
        if (inData === this.END_OF_LINE) tableValue = this.END_OF_LINE;
        return tableValue;
    }

    static applyTextTransformProtectInternationalFromKoreanSpecial(inCharList, processingObj) {
        const n = inCharList.length;
        if (n === 1) return [inCharList[0] & 0xF];
        if (n === 2) {
            const corrMask = (inCharList[0] << 3) & 0x80;
            return [inCharList[1] & (~corrMask)];
        }
        if (n === 3) return [this.processFromKoreanSpecialTableValue(inCharList[2], true)];
        if (n === 4) {
            const corrMask = (inCharList[0] << 2) & 0x80;
            return [inCharList[3] & (~corrMask)];
        }
        if (n === 5) return [this.processFromKoreanSpecialTableValue(inCharList[2], false)];
        if (n === 6) {
            // A Korean name cut short by a Japanese game: force the end
            if ((inCharList[5] === this.END_OF_LINE) && (!processingObj.hasEncounteredEol)) {
                processingObj.isKoreanSpecialWasJapaneseTruncated = true;
                return [0xF0];
            }
            processingObj.isKoreanSpecialWasJapaneseTruncated = false;
            return [inCharList[5]];
        }
        if (n === 7) {
            if (processingObj.isKoreanSpecialWasJapaneseTruncated) return [this.END_OF_LINE];
            return [this.processFromKoreanSpecialTableValue(inCharList[6], true)];
        }
        if (n === 8) return [inCharList[7]];
        if (n === 9) return [this.processFromKoreanSpecialTableValue(inCharList[6], false), inCharList[8]];
        return [pyIndex(inCharList, -1)];
    }

    static applyTextTransformProtectKoreanFromJpnSpecial(inCharList) {
        if (inCharList.length === 1) return [];
        if ((inCharList.length >= 2) && (inCharList.length < (2 + this.JPN_NAME_LEN))) {
            const index = inCharList.length - 2;
            const corrMask = (inCharList[0] << (7 - index)) & 0x80;
            const outValue = [inCharList[1 + index] & (~corrMask)];
            if (index === (this.JPN_NAME_LEN - 1)) outValue.push(this.END_OF_LINE, this.END_OF_LINE);
            return outValue;
        }
        return [pyIndex(inCharList, -1)];
    }

    static replaceFeInPatchedOutData(textEntry) {
        for (let i = 0; i < textEntry.values.length; i++) {
            if (textEntry.values[i] === this.PROHIBITED_CHAR) textEntry.values[i] = this.PROHIBITED_CHAR_REPLACEMENT;
        }
    }

    static patchOutBadCharsProtectInternationalFromKoreanBufferedOnly(textEntry) {
        const values = textEntry.values;
        if (pyIndex(values, 0) === this.KOREAN_SPECIAL_REPLACEMENT) return;

        const firstBytes = [];
        const secondBytes = [];
        const corrBits = [];
        for (let i = 0; i < 5; i++) {
            firstBytes.push(pyIndex(values, i * 2));
            if (firstBytes[i] === this.END_OF_LINE) firstBytes[i] = this.EOL_USER_INPUT_TABLE_VALUE;
            if (firstBytes[i] > this.NUM_VALID_USER_INPUT_TABLES) firstBytes[i] = this.EOL_USER_INPUT_TABLE_VALUE - 1;
            if (i !== 0) firstBytes[i] -= 1;
            secondBytes.push(pyIndex(values, (i * 2) + 1));
            if ((secondBytes[i] < 0x60) && (secondBytes[i] !== this.END_OF_LINE)) corrBits.push(1);
            else corrBits.push(0);
        }

        if (corrBits[0] !== 0) secondBytes[0] |= 0x80;
        if (corrBits[1] !== 0) secondBytes[1] |= 0x80;

        const set = (i, v) => GSCUtilsMisc.setItem(values, i, v);
        set(0, this.KOREAN_SPECIAL_REPLACEMENT);
        set(1, firstBytes[0] | (corrBits[0] << 4) | (corrBits[1] << 5) | 0x80);
        set(2, secondBytes[0]);
        set(3, this.START_VALID_USER_INPUT_TABLES_BYTE + firstBytes[1] + (firstBytes[2] * this.NUM_VALID_USER_INPUT_TABLES));
        set(4, secondBytes[1]);
        set(5, this.END_OF_LINE);
        set(6, secondBytes[2]);
        set(7, this.START_VALID_USER_INPUT_TABLES_BYTE + firstBytes[3] + (firstBytes[4] * this.NUM_VALID_USER_INPUT_TABLES));
        set(8, secondBytes[3]);
        set(9, secondBytes[4]);

        this.replaceFeInPatchedOutData(textEntry);
    }

    // Needs the name's language, so only possible with buffered data
    static patchOutBadCharsProtectKoreanFromJpnBufferedOnly(textEntry) {
        const values = textEntry.values;
        if (pyIndex(values, 0) === this.KOREAN_PATCHED_SPECIAL_REPLACEMENT) return;

        let hasBadChars = false;
        const badCharsList = [];
        for (let i = 0; i < values.length; i++) {
            if (values[i] === this.END_OF_LINE) break;
            if (this.badIdsTextKorFullList.includes(values[i])) {
                hasBadChars = true;
                badCharsList.push(1);
            } else {
                badCharsList.push(0);
            }
        }
        if (!hasBadChars) return;

        const tempValues = values.slice();
        let corrBitValue = 0;
        for (let i = 0; i < badCharsList.length; i++) {
            corrBitValue |= badCharsList[i] << i;
            if (badCharsList[i] === 1) tempValues[i] |= 0x80;
        }

        GSCUtilsMisc.setItem(values, 0, this.KOREAN_PATCHED_SPECIAL_REPLACEMENT);
        GSCUtilsMisc.setItem(values, 1, corrBitValue | 0x80);
        for (let i = 0; i < badCharsList.length; i++) GSCUtilsMisc.setItem(values, 2 + i, tempValues[i]);
        for (let i = 2 + badCharsList.length; i < values.length; i++) values[i] = this.END_OF_LINE;

        this.replaceFeInPatchedOutData(textEntry);
    }

    static getGeneralStringReadyForCountingLinesAndChars(targetStr) {
        const linesToProcess = targetStr.split('\n');
        const processedLines = [];
        for (const line of linesToProcess) {
            const lineInterruptions = line.replaceAll('<', '>').split('>');
            let finalLine = '';
            // Anything between <> counts as one character
            for (let i = 0; i < lineInterruptions.length; i++) {
                if ((i % 2) === 0) finalLine += lineInterruptions[i];
                else finalLine += '1';
            }
            processedLines.push(finalLine);
        }
        return processedLines;
    }

    static getBasicChecks() {
        return new GSCChecks([0, 0, 0], true, { useStrictLanguageChecks: true });
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
            this.mailConvJpToEn = await this.loadBinaryFile('mail_conversion_table_jp_to_en_int.bin');

            if (this.mailConvEnToJp && this.mailConvJpToEn) {
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

