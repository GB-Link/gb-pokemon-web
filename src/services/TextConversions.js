/**
 * TextConversions.js - Species and text conversions between Gen 1, 2 and 3,
 * default Pokémon/Egg/Trainer names per game language, and the bad words
 * filter. Call load() once before using anything else.
 *
 * Static methods name their class instead of using `this`, so they keep
 * working when passed around as callbacks.
 */

export const TEXT_CONV_TOTAL_GENS = 3;

const BASE_FOLDER = '/data/text/';
const DATA_FILES = [
    'gen1_to_3_conv_table.bin', 'gen3_to_1_conv_table.bin',
    'pokemon_names.bin', 'language_names_index.bin', 'pokemon_names_kr_gen2.bin',
    'egg_names.bin', 'egg_name_kr_gen2.bin', 'trainer_names.bin', 'trainer_name_kr_gen2.bin',
    'text_gen3_to_gen12_int.bin', 'text_gen3_to_gen12_int_jp.bin',
    'text_gen3_to_gen12_jp.bin', 'text_gen3_to_gen12_jp_int.bin',
    'text_gen3_to_general_int.txt', 'text_gen3_to_general_jp.txt', 'text_gen2_to_general_kor.txt',
    'text_gen12_to_gen3_int.bin', 'text_gen12_to_gen3_jp.bin',
    'text_general_to_gen3_int.bin', 'text_general_to_gen3_jp.bin',
    'bad_words_replacement_list.txt', 'blacklisted_regexes.bin',
    'letters_blacklist_dict.txt', 'whitelisted_words.txt',
];

let loadPromise = null;

async function loadAll() {
    const contents = await Promise.all(DATA_FILES.map(async (name) => {
        const response = await fetch(BASE_FOLDER + name);
        if (!response.ok) throw new Error(`${name}: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
    }));
    const files = new Map(DATA_FILES.map((name, i) => [name, contents[i]]));
    new PokemonSpeciesConversions(files);
    new PokemonTextConversions(files);
    new PokemonNamesForGen(files);
    new PokemonBadWordsFilter(files);
    return true;
}

function loadTextConversions() {
    if (!loadPromise) {
        loadPromise = loadAll().catch((e) => {
            loadPromise = null;
            throw e;
        });
    }
    return loadPromise;
}

function notLoaded() {
    return new Error('TextConversions: await load() before use');
}

// Python list indexing: negative indexes count from the end, anything else
// out of range throws.
function pyIndex(seq, index) {
    const i = index < 0 ? seq.length + index : index;
    if (!Number.isInteger(i) || i < 0 || i >= seq.length) throw new RangeError(`index ${index} out of range`);
    return seq[i];
}

function ord(value) {
    if (typeof value !== 'string') throw new TypeError('ord() expected a character');
    const codePoint = value.codePointAt(0);
    if (codePoint === undefined || String.fromCodePoint(codePoint).length !== value.length) {
        throw new TypeError('ord() expected a single character');
    }
    return codePoint;
}

function readShortLE(data, pos) {
    return pyIndex(data, pos) + (pyIndex(data, pos + 1) << 8);
}

function fromNBytesLE(data, nBytes, start = 0) {
    let out = 0;
    for (let i = 0; i < nBytes; i++) out += pyIndex(data, start + i) * (2 ** (8 * i));
    return out;
}

// Same lines as Python's readlines() on a UTF-8 text file: universal
// newlines, each line keeps its '\n', and a BOM is not stripped.
function readTextLines(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n?/g, '\n');
    const lines = text.split('\n').map((line, i, all) => (i < all.length - 1 ? line + '\n' : line));
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function compileBlacklist(alternatives) {
    const toJs = (pattern) => {
        let out = '';
        for (let i = 0; i < pattern.length; i++) {
            const c = pattern[i];
            if (c === '\\') out += c + pattern[++i];
            else if (c === '.') out += '[\\s\\S]';
            else if (c === '$') out += '(?=\\n?$)';
            else out += c;
        }
        return out;
    };
    const anywhere = [];
    const parts = [];
    for (let alternative of alternatives) {
        if (alternative.endsWith('.*') && !alternative.endsWith('\\.*')) alternative = alternative.slice(0, -2);
        if (alternative.startsWith('.*')) anywhere.push(toJs(alternative.slice(2)));
        else parts.push(toJs(alternative));
    }
    if (anywhere.length) parts.unshift(`[\\s\\S]*(?:${anywhere.join('|')})`);
    return new RegExp(`^(?:${parts.join('|')})`, 'u');
}

// Pointer to an entry of a packed table from Pokémon Gen 3 to Gen X
export function getTablePointerPG3TGX(table, entry) {
    const controlByte = table[0];
    const sizeInitialOffset = (controlByte & 1) + 1;
    const sizeOffsets = ((controlByte >> 1) & 1) + 1;
    const offsetShifter = (controlByte >> 2) & 7;
    const offsetShifterInitialOffset = controlByte >> 5;

    let initialOffset = table[1] << offsetShifterInitialOffset;
    let offsetTablePos = 2;
    if (sizeInitialOffset === 2) {
        initialOffset = readShortLE(table, 2) << offsetShifterInitialOffset;
        offsetTablePos = 4;
    }

    const entries = (initialOffset - offsetTablePos) >> (sizeOffsets - 1);

    if (entry >= entries) return null;

    let offset = pyIndex(table, offsetTablePos + entry) << offsetShifter;
    if (sizeOffsets === 2) offset = readShortLE(table, offsetTablePos + (entry << 1)) << offsetShifter;

    return initialOffset + offset;
}

/**
 * Converts the Pokémon species to/from the games.
 */
export class PokemonSpeciesConversions {
    static LAST_VALID_GEN_2_MON = 251;
    static GEN2_EGG = 253;
    static GEN2_NO_MON = 255;
    static MR_MIME_SPECIES = 122;
    static UNOWN_SPECIES = 201;
    static DEOXYS_SPECIES = 410;
    static EGG_SPECIES = 412;
    static UNOWN_B_START = 415;

    static DEOXYS_FORMS_POS = 442;
    static UNOWN_REAL_NAME_POS = 445;
    static MR_MIME_OLD_NAME_POS = 446;

    static NUM_UNOWN_LETTERS_GEN3 = 28;
    static NUM_UNOWN_LETTERS_GEN2 = 26;

    static ownInstance = null;

    static async load() {
        return loadTextConversions();
    }

    constructor(files) {
        this.gen1To3 = files.get('gen1_to_3_conv_table.bin');
        this.gen3To1 = files.get('gen3_to_1_conv_table.bin');
        PokemonSpeciesConversions.ownInstance = this;
    }

    static getSelf() {
        if (PokemonSpeciesConversions.ownInstance === null) throw notLoaded();
        return PokemonSpeciesConversions.ownInstance;
    }

    _convertGen2SpeciesToGen3(value, letter = 0, form = 0, isForNickname = false) {
        const C = PokemonSpeciesConversions;
        if (value === C.GEN2_EGG) return C.EGG_SPECIES;
        if (isForNickname) {
            if (value === C.MR_MIME_SPECIES) return C.MR_MIME_OLD_NAME_POS;
            if (value === C.UNOWN_SPECIES) return C.UNOWN_REAL_NAME_POS;
        }
        if (value === C.UNOWN_SPECIES && letter > 0 && letter < C.NUM_UNOWN_LETTERS_GEN2) {
            return C.UNOWN_B_START + letter - 1;
        }
        if (value <= 0) return 0;
        if (value > C.LAST_VALID_GEN_2_MON) return 0;
        return value;
    }

    _convertGen3SpeciesToGen2(value) {
        const C = PokemonSpeciesConversions;
        if (value === C.MR_MIME_OLD_NAME_POS) value = C.MR_MIME_SPECIES;
        if (value >= C.UNOWN_B_START && value < C.UNOWN_B_START + C.NUM_UNOWN_LETTERS_GEN2) return C.UNOWN_SPECIES;
        if (value <= 0) return 0;
        if (value > C.LAST_VALID_GEN_2_MON) return 0;
        return value;
    }

    _convertGen1SpeciesToGen3(value, letter = 0, form = 0, isForNickname = false) {
        if (value <= 0) return 0;
        if (value >= this.gen1To3.length) return 0;
        const outValue = pyIndex(this.gen1To3, value);
        if (isForNickname && outValue === PokemonSpeciesConversions.MR_MIME_SPECIES) {
            return PokemonSpeciesConversions.MR_MIME_OLD_NAME_POS;
        }
        return outValue;
    }

    _convertGen3SpeciesToGen1(value) {
        if (value === PokemonSpeciesConversions.MR_MIME_OLD_NAME_POS) value = PokemonSpeciesConversions.MR_MIME_SPECIES;
        if (value <= 0) return 0;
        if (value >= this.gen3To1.length) return 0;
        return pyIndex(this.gen3To1, value);
    }

    _convertGen2SpeciesToGen1(value) {
        return this._convertGen3SpeciesToGen1(this._convertGen2SpeciesToGen3(value));
    }

    _convertGen1SpeciesToGen2(value) {
        return this._convertGen3SpeciesToGen2(this._convertGen1SpeciesToGen3(value));
    }

    static convertGenxSpeciesToGeny(value, genx, geny, letter = 0, form = 0, isForNickname = false) {
        if (genx <= 0) return 0;
        if (genx > TEXT_CONV_TOTAL_GENS) return 0;
        if (geny <= 0) return 0;
        if (geny > TEXT_CONV_TOTAL_GENS) return 0;

        const self = PokemonSpeciesConversions.getSelf();
        if (genx === 1) {
            if (geny === 2) return self._convertGen1SpeciesToGen2(value);
            if (geny === 3) return self._convertGen1SpeciesToGen3(value, letter, form, isForNickname);
        }
        if (genx === 2) {
            if (geny === 1) return self._convertGen2SpeciesToGen1(value);
            if (geny === 3) return self._convertGen2SpeciesToGen3(value, letter, form, isForNickname);
        }
        if (genx === 3) {
            if (geny === 1) return self._convertGen3SpeciesToGen1(value);
            if (geny === 2) return self._convertGen3SpeciesToGen2(value);
            if (geny === 3 && isForNickname && value === PokemonSpeciesConversions.UNOWN_SPECIES) {
                return PokemonSpeciesConversions.UNOWN_REAL_NAME_POS;
            }
        }
        return value;
    }
}

/**
 * Pokémon/Egg/Trainer names in the format of a specific game.
 */
export class PokemonNamesForGen {
    static NUM_LANGUAGES = 8;
    static NUM_POKEMON_NAME_LANGUAGES = 4;
    static FIRST_VALID_LANGUAGE = 1;
    static FIRST_INTERNATIONAL_VALID_LANGUAGE = 2;
    static UNKNOWN_LANGUAGE = 0xFF;
    static JAPANESE_LANGUAGE = 1;
    static ENGLISH_LANGUAGE = 2;
    static FRENCH_LANGUAGE = 3;
    static ITALIAN_LANGUAGE = 4;
    static GERMAN_LANGUAGE = 5;
    static KOREAN_LANGUAGE = 6;
    static SPANISH_LANGUAGE = 7;
    static JAPANESE_LANGUAGE_STR = 'Japanese';
    static ENGLISH_LANGUAGE_STR = 'English';

    static NUM_GEN1_NAME_CHECKS = 256;
    static NUM_GEN2_NAME_CHECKS = 256;
    static NUM_GEN3_NAME_CHECKS = 447;

    static NAME_SIZE_INT = 11;
    static NAME_SIZE_OT_INT = 8;
    static NAME_SIZE_JP = 6;
    static NAME_SIZE_KOR_FILE = 10;

    static ALL_LANGUAGES_LIST = [
        PokemonNamesForGen.ENGLISH_LANGUAGE, PokemonNamesForGen.JAPANESE_LANGUAGE, PokemonNamesForGen.FRENCH_LANGUAGE,
        PokemonNamesForGen.ITALIAN_LANGUAGE, PokemonNamesForGen.GERMAN_LANGUAGE, PokemonNamesForGen.KOREAN_LANGUAGE,
        PokemonNamesForGen.SPANISH_LANGUAGE,
    ];
    static SORTED_LANGUAGES_LIST = [
        PokemonNamesForGen.JAPANESE_LANGUAGE, PokemonNamesForGen.ENGLISH_LANGUAGE, PokemonNamesForGen.FRENCH_LANGUAGE,
        PokemonNamesForGen.ITALIAN_LANGUAGE, PokemonNamesForGen.GERMAN_LANGUAGE, PokemonNamesForGen.KOREAN_LANGUAGE,
        PokemonNamesForGen.SPANISH_LANGUAGE,
    ];

    static LANGUAGE_STR_LIST = [PokemonNamesForGen.JAPANESE_LANGUAGE_STR, PokemonNamesForGen.ENGLISH_LANGUAGE_STR, 'French', 'Italian', 'German', 'Korean', 'Spanish'];
    static LANGUAGE_STR_SHORT_LIST = ['JPN', 'ENG', 'FRE', 'ITA', 'GER', 'KOR', 'SPA'];
    // From the Pokémon cartridge labels
    static LANGUAGE_STR_SHORT_LIST_ALT = ['JPN', 'USA', 'FRA', 'ITA', 'NDE', 'KOR', 'ESP'];
    // Used in GSC mail data
    static LANGUAGE_STR_SHORT_LIST_SMALL = ['J', 'E', 'F', 'I', 'G', 'K', 'S'];
    // Easier to recognize; not for mail
    static LANGUAGE_STR_SHORT_LIST_SMALL_ALT = ['J', 'U', 'F', 'I', 'D', 'K', 'S'];

    static LANGUAGE_STRINGS_LIST = [
        PokemonNamesForGen.LANGUAGE_STR_LIST, PokemonNamesForGen.LANGUAGE_STR_SHORT_LIST,
        PokemonNamesForGen.LANGUAGE_STR_SHORT_LIST_ALT, PokemonNamesForGen.LANGUAGE_STR_SHORT_LIST_SMALL,
        PokemonNamesForGen.LANGUAGE_STR_SHORT_LIST_SMALL_ALT,
    ];

    static ownInstance = null;

    static async load() {
        return loadTextConversions();
    }

    constructor(files) {
        const C = PokemonNamesForGen;
        const pokemonNames = files.get('pokemon_names.bin');
        const languageNamesIndex = files.get('language_names_index.bin');
        const pokemonNamesKrGen2 = files.get('pokemon_names_kr_gen2.bin');
        const eggNames = files.get('egg_names.bin');
        const eggNameKrGen2 = files.get('egg_name_kr_gen2.bin');
        const trainerNames = files.get('trainer_names.bin');
        const trainerNameKrGen2 = files.get('trainer_name_kr_gen2.bin');

        this.pokemonNames = [];
        for (let i = 0; i < C.NUM_LANGUAGES; i++) {
            this.pokemonNames.push(this.getAllPokemonNamesForLanguage(pokemonNames, i, languageNamesIndex));
        }
        this.replaceKoreanPokemonNames(pokemonNamesKrGen2);

        this.trainerNames = [];
        for (let i = 0; i < C.NUM_LANGUAGES; i++) this.trainerNames.push(this.getNameForLanguage(trainerNames, i));
        this.replaceKoreanName(this.trainerNames, trainerNameKrGen2);

        this.eggNames = [];
        for (let i = 0; i < C.NUM_LANGUAGES; i++) this.eggNames.push(this.getNameForLanguage(eggNames, i));
        this.replaceKoreanName(this.eggNames, eggNameKrGen2);

        PokemonNamesForGen.ownInstance = this;
    }

    static getSelf() {
        if (PokemonNamesForGen.ownInstance === null) throw notLoaded();
        return PokemonNamesForGen.ownInstance;
    }

    // One Map per gen: species index -> name bytes
    getAllPokemonNamesForLanguage(pokemonNames, language, languageNamesIndex) {
        const C = PokemonNamesForGen;
        if (language < 0) return null;
        if (language >= languageNamesIndex.length) return null;
        const languageGen3Index = languageNamesIndex[language];
        const numNameChecks = [C.NUM_GEN1_NAME_CHECKS, C.NUM_GEN2_NAME_CHECKS, C.NUM_GEN3_NAME_CHECKS];
        const outPokemonNames = [];
        for (let i = 0; i < TEXT_CONV_TOTAL_GENS; i++) {
            outPokemonNames.push(new Map());
            const gen = i + 1;
            for (let j = 0; j < numNameChecks[i]; j++) {
                const correspondingIndexGen3 = PokemonSpeciesConversions.convertGenxSpeciesToGeny(j, gen, 3, 0, 0, true);
                if (correspondingIndexGen3 === 0) continue;
                const posName = getTablePointerPG3TGX(pokemonNames, (correspondingIndexGen3 * C.NUM_POKEMON_NAME_LANGUAGES) + languageGen3Index);
                const pokemonName = this.extractNameFromGen3Data(pokemonNames, posName, gen, language === C.JAPANESE_LANGUAGE);
                if (pokemonName !== null) outPokemonNames[i].set(j, pokemonName);
            }
        }
        return outPokemonNames;
    }

    replaceKoreanPokemonNames(pokemonNamesKrGen2) {
        const C = PokemonNamesForGen;
        for (let i = 0; i < 2; i++) {
            const gen = i + 1;
            const oldDict = this.pokemonNames[C.KOREAN_LANGUAGE][i];
            const newDict = new Map();
            this.pokemonNames[C.KOREAN_LANGUAGE][i] = newDict;
            for (const monIndex of oldDict.keys()) {
                let convertedIndex = monIndex;
                if (gen === 1) convertedIndex = PokemonSpeciesConversions.convertGenxSpeciesToGeny(monIndex, gen, 2);
                newDict.set(monIndex, this.copyGen2NameToArray(pokemonNamesKrGen2, C.NAME_SIZE_KOR_FILE * convertedIndex, C.NAME_SIZE_KOR_FILE));
            }
        }
    }

    replaceKoreanName(names, krDataGen2) {
        for (let i = 0; i < 2; i++) {
            names[PokemonNamesForGen.KOREAN_LANGUAGE][i] = this.copyGen2NameToArray(krDataGen2, 0, krDataGen2.length);
        }
    }

    getNameForLanguage(namesData, language) {
        if (language < 0) return null;
        if (language >= PokemonNamesForGen.NUM_LANGUAGES) return null;
        const outNames = [];
        for (let i = 0; i < TEXT_CONV_TOTAL_GENS; i++) {
            const gen = i + 1;
            outNames.push(null);
            const posName = getTablePointerPG3TGX(namesData, language);
            const actualName = this.extractNameFromGen3Data(namesData, posName, gen, language === PokemonNamesForGen.JAPANESE_LANGUAGE);
            if (actualName !== null) outNames[i] = actualName;
        }
        return outNames;
    }

    // Gen 1/2 names are converted and padded with their terminator,
    // Gen 3 names keep 0xFF and are padded with 0.
    extractNameFromGen3Data(data, offset, gen, isJp) {
        if (offset === null) return null;
        if (gen <= 0) return null;
        if (gen > TEXT_CONV_TOTAL_GENS) return null;

        const maxNameSize = isJp ? PokemonNamesForGen.NAME_SIZE_JP : PokemonNamesForGen.NAME_SIZE_INT;
        let conversionMethod = PokemonTextConversions.convertGen3CharToGen12Char;
        let postEndChar = null;
        if (gen === 3) {
            conversionMethod = null;
            postEndChar = 0;
        }

        const outName = [];
        for (let k = 0; k < maxNameSize; k++) {
            const inChar = pyIndex(data, offset + k);
            let outChar = inChar;
            if (conversionMethod !== null) outChar = conversionMethod(inChar, isJp, isJp);
            outName.push(outChar);
            if (PokemonTextConversions.isGen3Eol(inChar)) {
                if (postEndChar === null) postEndChar = outChar;
                for (let pad = k; pad < maxNameSize - 1; pad++) outName.push(postEndChar);
                break;
            }
        }
        return outName;
    }

    copyGen2NameToArray(data, offset, sizeData, isJp = false) {
        const outArray = [];
        const maxNameSize = isJp ? PokemonNamesForGen.NAME_SIZE_JP : PokemonNamesForGen.NAME_SIZE_INT;
        for (let i = 0; i < sizeData; i++) {
            outArray.push(pyIndex(data, offset + i));
            if (i === sizeData - 1) {
                for (let pad = i; pad < maxNameSize - 1; pad++) outArray.push(PokemonTextConversions.GEN2_EOL);
            }
        }
        return outArray;
    }

    getGenericNameForGen(data, gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        if (gen <= 0) return null;
        if (gen > TEXT_CONV_TOTAL_GENS) return null;
        if (language < 0) return null;
        if (language >= PokemonNamesForGen.NUM_LANGUAGES) return null;
        return data[language][gen - 1];
    }

    static getPokemonNameForGen(species, gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        const self = PokemonNamesForGen.getSelf();
        const selectedDict = self.getGenericNameForGen(self.pokemonNames, gen, language);
        if (selectedDict == null) return null;
        const speciesReal = PokemonSpeciesConversions.convertGenxSpeciesToGeny(species, gen, gen, 0, 0, true);
        if (!selectedDict.has(speciesReal)) return null;
        return selectedDict.get(speciesReal);
    }

    static getTrainerNameForGen(gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        const self = PokemonNamesForGen.getSelf();
        return self.getGenericNameForGen(self.trainerNames, gen, language);
    }

    static getEggNameForGen(gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        const self = PokemonNamesForGen.getSelf();
        return self.getGenericNameForGen(self.eggNames, gen, language);
    }

    static convertGenericNameGeneralForGen(currList, gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        if (currList == null) return '';
        if (language === PokemonNamesForGen.KOREAN_LANGUAGE && (gen === 1 || gen === 2)) {
            return PokemonNamesForGen.convertKoreanNameGeneralForGen12(currList);
        }
        let outStr = '';
        let convMethod = PokemonTextConversions.convertGen12CharToChar;
        let eolMethod = PokemonTextConversions.isGen12Eol;
        if (gen === 3) {
            eolMethod = PokemonTextConversions.isGen3Eol;
            convMethod = PokemonTextConversions.convertGen3CharToChar;
        }
        for (let i = 0; i < currList.length; i++) {
            if (eolMethod(currList[i])) break;
            outStr += convMethod(currList[i], language === PokemonNamesForGen.JAPANESE_LANGUAGE);
        }
        return outStr;
    }

    static convertKoreanNameGeneralForGen12(currList) {
        if (currList == null) return '';
        let outStr = '';
        let i = 0;
        while (i < currList.length) {
            if (PokemonTextConversions.isGen12Eol(currList[i])) break;
            let charNext = PokemonTextConversions.GEN2_EOL;
            if (i + 1 < currList.length) charNext = currList[i + 1];
            const outCombo = PokemonTextConversions.convertGen12KorCharToChar(currList[i], charNext);
            i += outCombo[0];
            outStr += outCombo[1];
        }
        return outStr;
    }

    static getPokemonNameGeneralForGen(species, gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        const currList = PokemonNamesForGen.getPokemonNameForGen(species, gen, language);
        return PokemonNamesForGen.convertGenericNameGeneralForGen(currList, gen, language);
    }

    static getMethodNameGeneralForGen(method, gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        const currList = method(gen, language);
        return PokemonNamesForGen.convertGenericNameGeneralForGen(currList, gen, language);
    }

    static getEggNameGeneralForGen(gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        return PokemonNamesForGen.getMethodNameGeneralForGen(PokemonNamesForGen.getEggNameForGen, gen, language);
    }

    static getTrainerNameGeneralForGen(gen, language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        return PokemonNamesForGen.getMethodNameGeneralForGen(PokemonNamesForGen.getTrainerNameForGen, gen, language);
    }

    static getTrainerMaxNameLength(gen, language) {
        if (language === PokemonNamesForGen.KOREAN_LANGUAGE) return 10;
        if (language === PokemonNamesForGen.JAPANESE_LANGUAGE) return 5;
        return 7;
    }

    static getPokemonMaxNicknameLength(gen, language) {
        if (language === PokemonNamesForGen.JAPANESE_LANGUAGE) return 5;
        return 10;
    }
}

/**
 * Converts the text to/from the games.
 */
export class PokemonTextConversions {
    static GEN3_EOL = 0xFF;
    static GEN2_EOL = 0x50;
    static GENERIC_EOL = 0;
    static GENERIC_EOL_2 = '\0';

    static GEN3_QUESTION = 0xAC;
    static GEN2_QUESTION = 0xE6;
    static GENERIC_QUESTION = 0x3F;

    static GEN2_NEWLINE_INT = 0x4E;
    static GEN2_NEWLINE_KOR = 0x59;

    static ownInstance = null;

    static async load() {
        return loadTextConversions();
    }

    constructor(files) {
        const readAlphabet = (name) => this.parseAlphabet(readTextLines(files.get(name)));
        this.gen3Gen12Int = files.get('text_gen3_to_gen12_int.bin');
        this.gen3Gen12IntJp = files.get('text_gen3_to_gen12_int_jp.bin');
        this.gen3Gen12Jp = files.get('text_gen3_to_gen12_jp.bin');
        this.gen3Gen12JpInt = files.get('text_gen3_to_gen12_jp_int.bin');
        this.gen3GeneralInt = readAlphabet('text_gen3_to_general_int.txt');
        this.gen3GeneralJp = readAlphabet('text_gen3_to_general_jp.txt');
        this.gen2GeneralKor = readAlphabet('text_gen2_to_general_kor.txt');
        this.generalGen2Kor = this.reverseParseAlphabet(this.gen2GeneralKor);
        this.gen12Gen3Int = files.get('text_gen12_to_gen3_int.bin');
        this.gen12Gen3Jp = files.get('text_gen12_to_gen3_jp.bin');
        this.generalGen3Int = files.get('text_general_to_gen3_int.bin');
        this.generalGen3Jp = files.get('text_general_to_gen3_jp.bin');
        PokemonTextConversions.ownInstance = this;
    }

    // Rows of '#'-terminated entries. With no target, "<TABLE>" entries are
    // collected as lead bytes whose sub-table follows a "# TABLE n" header.
    parseTable(lines, tableRows, tableRowLen, target = null) {
        const tableTotal = tableRows * tableRowLen;
        const tablesFound = [];
        let start = null;
        let hasStartedSearch = target === null;
        for (let i = 0; i < lines.length; i++) {
            const processedLine = lines[i].replaceAll('\n', '').replaceAll('\r', '');
            if (!hasStartedSearch) {
                hasStartedSearch = processedLine.startsWith('# TABLE ' + target);
            } else {
                if (processedLine.startsWith('#')) continue;
                if (processedLine.trim().length === 0) continue;
                start = i;
                break;
            }
        }

        if (start === null) return [new Array(tableTotal).fill(0)];

        const outTable = [];
        for (let i = 0; i < tableRows; i++) {
            const processedLine = lines[start + i].replaceAll('\n', '').replaceAll('\r', '').split('#');
            if (processedLine.length !== tableRowLen + 1) return [new Array(tableTotal).fill(1)];
            for (let j = 0; j < tableRowLen; j++) {
                if (target === null && processedLine[j] === '<TABLE>') {
                    outTable.push([]);
                    tablesFound.push((i * tableRowLen) + j);
                } else {
                    outTable.push(processedLine[j]);
                }
            }
        }

        return [outTable, tablesFound];
    }

    parseAlphabet(lines) {
        const tableRows = 16;
        const tableRowLen = 16;
        const out = this.parseTable(lines, tableRows, tableRowLen);
        if (out[1].length <= 0) return out[0];
        for (const subtable of out[1]) {
            const subOut = this.parseTable(lines, tableRows, tableRowLen, subtable);
            out[0][subtable] = subOut[0];
        }
        return out[0];
    }

    // Character -> every byte sequence that produces it ([byte] or [lead, byte])
    reverseParseAlphabet(table, previousValue = [], currDict = null) {
        const isTop = previousValue.length === 0;
        if (isTop) currDict = new Map();
        const add = (key, value) => {
            if (!currDict.has(key)) currDict.set(key, []);
            currDict.get(key).push(value);
        };
        for (let i = 0; i < table.length; i++) {
            const item = table[i];
            if (Array.isArray(item) && item.length === table.length && isTop) {
                this.reverseParseAlphabet(item, [i], currDict);
            } else if (item !== '?') {
                add(item, [...previousValue, i]);
                if (item === '<?>') add('?', [...previousValue, i]);
            }
        }
        return currDict;
    }

    static getSelf() {
        if (PokemonTextConversions.ownInstance === null) throw notLoaded();
        return PokemonTextConversions.ownInstance;
    }

    static convertGen12CharToChar(value, isJp = false) {
        const self = PokemonTextConversions.getSelf();
        if (value === PokemonTextConversions.GEN2_EOL) return PokemonTextConversions.GENERIC_EOL;
        if (value === PokemonTextConversions.GEN2_NEWLINE_INT) return '\n';
        let convTable1 = self.gen12Gen3Int;
        let convTable2 = self.gen3GeneralInt;
        if (isJp) {
            convTable1 = self.gen12Gen3Jp;
            convTable2 = self.gen3GeneralJp;
        }
        let out = pyIndex(convTable2, pyIndex(convTable1, value));
        if (out === '<?>') out = '?';
        return out;
    }

    // Returns [bytes consumed, character]
    static convertGen12KorCharToChar(value, valueNext) {
        const self = PokemonTextConversions.getSelf();
        const tableUsed = self.gen2GeneralKor;
        if (value === PokemonTextConversions.GEN2_EOL) return [1, PokemonTextConversions.GENERIC_EOL];
        if (value === PokemonTextConversions.GEN2_NEWLINE_INT) return [1, '\n'];
        if (value === PokemonTextConversions.GEN2_NEWLINE_KOR) return [1, '\n'];
        let outValue = pyIndex(tableUsed, value);
        if (!(Array.isArray(outValue) && outValue.length === tableUsed.length)) {
            if (outValue === '<?>') outValue = '?';
            return [1, outValue];
        }
        if (valueNext == null) return [2, '<TABLE>'];
        outValue = pyIndex(outValue, valueNext);
        if (outValue === '<?>') outValue = '?';
        return [2, outValue];
    }

    static convertCharToGen12KorChar(value, numWantedOut) {
        const self = PokemonTextConversions.getSelf();
        const tableUsed = self.generalGen2Kor;
        if (value === PokemonTextConversions.GENERIC_EOL) return [PokemonTextConversions.GEN2_EOL];
        if (!tableUsed.has(value)) return [];
        for (const item of tableUsed.get(value)) {
            if (item.length === numWantedOut) return item;
        }
        return [];
    }

    static convertCharToGen12Char(value, isJp = false) {
        const self = PokemonTextConversions.getSelf();
        if (value === PokemonTextConversions.GENERIC_EOL) return PokemonTextConversions.GEN2_EOL;
        let convTable1 = self.generalGen3Int;
        let convTable2 = self.gen3Gen12Int;
        if (isJp) {
            convTable1 = self.generalGen3Jp;
            convTable2 = self.gen3Gen12Jp;
        }
        return pyIndex(convTable2, pyIndex(convTable1, ord(value)));
    }

    static convertGen3CharToChar(value, isJp = false) {
        const self = PokemonTextConversions.getSelf();
        if (value === PokemonTextConversions.GEN3_EOL) return PokemonTextConversions.GENERIC_EOL;
        const convTable = isJp ? self.gen3GeneralJp : self.gen3GeneralInt;
        let out = pyIndex(convTable, value);
        if (out === '<?>') out = '?';
        return out;
    }

    static convertCharToGen3Char(value, isJp = false) {
        const self = PokemonTextConversions.getSelf();
        if (value === PokemonTextConversions.GENERIC_EOL) return PokemonTextConversions.GEN3_EOL;
        const convTable = isJp ? self.generalGen3Jp : self.generalGen3Int;
        return pyIndex(convTable, ord(value));
    }

    static convertGen3CharToGen12Char(value, isJp = false, toJp = false) {
        const self = PokemonTextConversions.getSelf();
        if (value === PokemonTextConversions.GEN3_EOL) return PokemonTextConversions.GEN2_EOL;
        let convTable = self.gen3Gen12Int;
        if (isJp) {
            convTable = toJp ? self.gen3Gen12Jp : self.gen3Gen12JpInt;
        } else if (toJp) {
            convTable = self.gen3Gen12IntJp;
        }
        return pyIndex(convTable, value);
    }

    static convertGen12CharToGen3Char(value, isJp = false) {
        const self = PokemonTextConversions.getSelf();
        if (value === PokemonTextConversions.GEN2_EOL) return PokemonTextConversions.GEN3_EOL;
        const convTable = isJp ? self.gen12Gen3Jp : self.gen12Gen3Int;
        return pyIndex(convTable, value);
    }

    // Returns [character, isPartial, isQuestionMark]. A Korean lead byte
    // with no lastChar is partial; pass it as lastChar with the next byte.
    static convertGenxCharToChar(value, gen, language, lastChar = null) {
        const L = PokemonNamesForGen;
        let isPartial = false;
        let outValue;
        let isEol;
        if (language == null) language = L.ENGLISH_LANGUAGE;
        if (gen === 3) {
            outValue = PokemonTextConversions.convertGen3CharToChar(value, language === L.JAPANESE_LANGUAGE);
            isEol = PokemonTextConversions.isGen3Eol(value);
        } else {
            if (language === L.KOREAN_LANGUAGE) {
                if (lastChar == null) {
                    outValue = PokemonTextConversions.convertGen12KorCharToChar(value, null);
                    if (outValue[1] === '<TABLE>') isPartial = true;
                } else {
                    outValue = PokemonTextConversions.convertGen12KorCharToChar(lastChar, value);
                }
                outValue = outValue[1];
            } else {
                outValue = PokemonTextConversions.convertGen12CharToChar(value, language === L.JAPANESE_LANGUAGE);
            }
            isEol = PokemonTextConversions.isGen12Eol(value);
        }
        if (isEol) return ['\0', false, false];
        return [outValue, isPartial, outValue === '?'];
    }

    static convertCharToGenxChar(value, gen, language, doTwoBytesOnly = false) {
        const L = PokemonNamesForGen;
        if (language == null) language = L.ENGLISH_LANGUAGE;
        if (PokemonTextConversions.isGenericEol(value)) {
            if (gen === 3) return [PokemonTextConversions.GEN3_EOL];
            return [PokemonTextConversions.GEN2_EOL];
        }
        let outValue;
        if (gen === 3) {
            outValue = [PokemonTextConversions.convertCharToGen3Char(value, language === L.JAPANESE_LANGUAGE)];
        } else if (language === L.KOREAN_LANGUAGE && doTwoBytesOnly) {
            outValue = PokemonTextConversions.convertCharToGen12KorChar(value, 2);
            if (outValue.length === 0) outValue = PokemonTextConversions.convertCharToGen12KorChar('?', 2);
        } else {
            outValue = [PokemonTextConversions.convertCharToGen12Char(value, language === L.JAPANESE_LANGUAGE)];
        }
        return outValue;
    }

    static isGen12Eol(value) {
        return value === PokemonTextConversions.GEN2_EOL;
    }

    static isGen3Eol(value) {
        return value === PokemonTextConversions.GEN3_EOL;
    }

    static isGenericEol(value) {
        if (value === PokemonTextConversions.GENERIC_EOL) return true;
        return value === PokemonTextConversions.GENERIC_EOL_2;
    }
}

export class PokemonBadWordsFilter {
    static ownInstance = null;

    static async load() {
        return loadTextConversions();
    }

    constructor(files) {
        this.badWordsReplacementDict = new Map();
        for (const line of readTextLines(files.get('bad_words_replacement_list.txt'))) {
            const items = line.replaceAll('\n', '').split(' ');
            if (items.length < 2) continue;
            this.badWordsReplacementDict.set(items[0], items[1]);
        }

        this.whitelistedWords = new Set();
        for (const line of readTextLines(files.get('whitelisted_words.txt'))) {
            const considered = line.replaceAll('\n', '');
            if (considered === '') continue;
            this.whitelistedWords.add(considered);
        }

        this.whitelistedWordsMultilettersJpnKor = this._createWhitelistedDict(PokemonNamesForGen.NAME_SIZE_JP - 1);
        this.whitelistedWordsMultilettersIntNickname = this._createWhitelistedDict(PokemonNamesForGen.NAME_SIZE_INT - 1);
        this.whitelistedWordsMultilettersIntOtName = this._createWhitelistedDict(PokemonNamesForGen.NAME_SIZE_OT_INT - 1);

        // The regex list is stored as indexes into a letters table, so the
        // words are not readable in the repository.
        const inData = files.get('blacklisted_regexes.bin');
        const inCharsDict = new Map();
        for (const line of readTextLines(files.get('letters_blacklist_dict.txt'))) {
            if (line.length === 0) continue;
            const items = line.replaceAll('\n', '').split('#');
            inCharsDict.set(Number.parseInt(items[1], 10), items[0]);
        }

        const numBytes = fromNBytesLE(inData, 4);
        const numBytesPerWord = fromNBytesLE(inData, 2, 4);
        const linebreak = fromNBytesLE(inData, numBytesPerWord, 6);

        let currPos = 8;
        const inLines = [];
        let currLine = '';
        while (currPos < numBytes) {
            const currChar = fromNBytesLE(inData, numBytesPerWord, currPos);
            currPos += numBytesPerWord;
            if (currChar === linebreak) {
                if (currLine !== '') {
                    inLines.push(currLine);
                    currLine = '';
                }
            } else if (inCharsDict.has(currChar)) {
                currLine += inCharsDict.get(currChar);
            }
        }

        this.reString = '(?:' + inLines.join('|') + ')';
        this.re = compileBlacklist(inLines);

        PokemonBadWordsFilter.ownInstance = this;
    }

    static getSelf() {
        if (PokemonBadWordsFilter.ownInstance === null) throw notLoaded();
        return PokemonBadWordsFilter.ownInstance;
    }

    // Entry i maps every (i + 1)-character prefix to the whitelisted words
    // of at most maxSize characters that start with it.
    _createWhitelistedDict(maxSize) {
        const whitelistSubset = new Set();
        for (const word of this.whitelistedWords) {
            if (Array.from(word).length <= maxSize) whitelistSubset.add(word);
        }
        const dictList = [];
        for (let i = 0; i < maxSize + 1; i++) {
            const prefixes = new Map();
            dictList.push(prefixes);
            for (const word of whitelistSubset) {
                const letters = Array.from(word);
                if (i < letters.length) {
                    const key = letters.slice(0, i + 1).join('');
                    if (!prefixes.has(key)) prefixes.set(key, []);
                    prefixes.get(key).push(word);
                }
            }
        }
        return dictList;
    }

    static _getRootWhitelistedWords(word, dictToUse) {
        const wordToCheck = word.toLowerCase();
        const wordLen = Array.from(wordToCheck).length;
        const dictIndex = wordLen - 1;
        if (dictIndex < 0) return [''];
        if (dictIndex >= dictToUse.length) return null;
        if (dictToUse[dictIndex].has(wordToCheck)) return dictToUse[dictIndex].get(wordToCheck);
        return null;
    }

    static getRootWhitelistedWordsOfMonName(word, language, isTwoBytes) {
        const self = PokemonBadWordsFilter.getSelf();
        let dictToUse = self.whitelistedWordsMultilettersIntNickname;
        if (language === PokemonNamesForGen.JAPANESE_LANGUAGE) dictToUse = self.whitelistedWordsMultilettersJpnKor;
        if (language === PokemonNamesForGen.KOREAN_LANGUAGE && isTwoBytes) dictToUse = self.whitelistedWordsMultilettersJpnKor;
        return PokemonBadWordsFilter._getRootWhitelistedWords(word, dictToUse);
    }

    static getRootWhitelistedWordsOfOtName(word, language, isTwoBytes) {
        const self = PokemonBadWordsFilter.getSelf();
        let dictToUse = self.whitelistedWordsMultilettersIntOtName;
        if (language === PokemonNamesForGen.JAPANESE_LANGUAGE) dictToUse = self.whitelistedWordsMultilettersJpnKor;
        if (language === PokemonNamesForGen.KOREAN_LANGUAGE && isTwoBytes) dictToUse = self.whitelistedWordsMultilettersJpnKor;
        return PokemonBadWordsFilter._getRootWhitelistedWords(word, dictToUse);
    }

    static getIsRootWhitelistedOfMonName(word, language, isTwoBytes) {
        return PokemonBadWordsFilter.getRootWhitelistedWordsOfMonName(word, language, isTwoBytes) !== null;
    }

    static getIsRootWhitelistedOfOtName(word, language, isTwoBytes) {
        return PokemonBadWordsFilter.getRootWhitelistedWordsOfOtName(word, language, isTwoBytes) !== null;
    }

    static isBadWord(word) {
        const self = PokemonBadWordsFilter.getSelf();
        let wordToCheck = word.toLowerCase();

        if (self.whitelistedWords.has(wordToCheck)) return false;

        if (self.re.test(wordToCheck)) return true;

        for (const [replacementKey, replacement] of self.badWordsReplacementDict) {
            wordToCheck = wordToCheck.split(replacementKey).join(replacement);
        }

        return self.re.test(wordToCheck);
    }
}
