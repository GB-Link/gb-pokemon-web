/**
 * GSCChecks - Sanity checks and cleaning of received Gen 2 trading data.
 *
 * checksMap/checksMapOld (whole sections, 0x41/0x21-byte mail layouts) and
 * singlePokemonChecksMap(Old) list one check function per byte; a check
 * function may return 0..n bytes, so a cleaned buffer can change length.
 *
 * Call `await GSCChecks.load()` (or `await checks.load()`) once; after that
 * new instances are ready as soon as they are constructed.
 */
import { GSCUtils, GSCUtilsLoaders, GSCUtilsMisc, pyIndex, pyLen, pySlice } from './GSCUtils.js?v=98';
import { PokemonNamesForGen, PokemonTextConversions, PokemonBadWordsFilter } from './TextConversions.js?v=98';

const DATA_FILES = {
    badIdsItems: 'bad_ids_items.bin',
    badIdsMoves: 'bad_ids_moves.bin',
    badIdsPokemon: 'bad_ids_pokemon.bin',
    badIdsText: 'bad_ids_text.bin',
    checksMap: 'checks_map.bin',
    checksMapOld: 'checks_map_old.bin',
    singlePokemonChecksMap: 'single_pokemon_checks_map.bin',
    singlePokemonChecksMapOld: 'single_pokemon_checks_map_old.bin',
    movesChecksMap: 'moves_checks_map.bin',
    pokemonPatchSet0: 'pokemon_patch_set_0.bin',
    pokemonPatchSet1: 'pokemon_patch_set_1.bin',
    mailPatchSet: 'mail_patch_set.bin',
    mailPatchSetOld: 'mail_patch_set_old.bin',
    japaneseMailPatchSet: 'japanese_mail_patch_set.bin',
};

// Python's str.isupper()
function pyIsUpper(text) {
    let cased = false;
    for (const ch of text) {
        if (/\p{Lowercase}|\p{Lt}/u.test(ch)) return false;
        if (/\p{Uppercase}/u.test(ch)) cased = true;
    }
    return cased;
}

function byCodePoint(a, b) {
    return a.codePointAt(0) - b.codePointAt(0);
}

export class GSCChecks {
    static BASE_FOLDER = '/data/gsc/';
    // Files a generation doesn't ship (skipped instead of fetched)
    static ABSENT_FILES = new Set();

    static CURR_EXP_POS_MASKS = [0, 0xFF0000, 0xFFFF00];
    static FREE_VALUE_SPECIES = 0xFF;
    static EMPTY_VALUE_SPECIES = 0x00;
    static FREE_VALUE_MOVES = 0x00;
    static NO_CONVERSION_PATCH = 0x00;
    static END_OF_PATCH = 0xFF;
    static PATCH_SET_COVER = 0xFC;
    static TRAINER_NAME_ID = 0x5D; // "TRAINER" - Korean has no such character
    static TACKLE_ID = 0x21;
    static RATTATA_ID = 0x13;
    static QUESTION_MARK = 0xE6;
    static QUESTION_MARK_KOR = [0x0B, 0x67];
    static NEWLINE = 0x4E;
    static NEWLINE_KOR = 0x59;
    static MAIL_REPLACED_FE = 0x21;
    static MAIL_REPLACED_FE_KOR = 0x51;
    static MAX_MAIL_LINE_LENGTH = 16;
    static REFERENCE_GEN = 2;
    static MAIL_TEXT_NULL = 0;
    static EGG_ID = 0xFD;

    // Random, party, patches, mail - 0x41-byte and 0x21-byte mail layouts
    static SECTION_LENGTHS = [0xA, 0x1BC, 0xC5, 0x241];
    static SECTION_LENGTHS_OLD = [0xA, 0x1BC, 0xC5, 0x181];

    static data = null;

    static getUtilsClass() {
        return GSCUtils;
    }

    /**
     * Load the check tables of this generation (and its utils/text tables).
     */
    static async load() {
        if (Object.prototype.hasOwnProperty.call(this, 'data') && this.data) return true;
        const utilsLoaded = await this.getUtilsClass().load();
        if (!utilsLoaded) throw new Error(`${this.name}: utility data not loaded`);
        await PokemonNamesForGen.load();
        const entries = await Promise.all(Object.entries(DATA_FILES).map(async ([key, name]) => [key, await this.readData(name)]));
        this.data = Object.fromEntries(entries);
        return true;
    }

    static async readData(name) {
        if (this.ABSENT_FILES.has(name)) return null;
        try {
            const response = await fetch(this.BASE_FOLDER + name);
            if (!response.ok) return null;
            return Array.from(new Uint8Array(await response.arrayBuffer()));
        } catch (e) {
            return null;
        }
    }

    /**
     * new GSCChecks(sectionSizes, doSanityChecks, { language, setDefaultNickname,
     *     setDefaultOt, setDefaultPartner, doProfanityChecks, useStrictLanguageChecks,
     *     sectionSizesOld, useStrictLanguageChecksMail })
     * new GSCChecks(doSanityChecks) uses SECTION_LENGTHS / SECTION_LENGTHS_OLD.
     */
    constructor(sectionSizes = null, doSanityChecks = true, options = {}) {
        if (sectionSizes !== null && sectionSizes !== undefined && !Array.isArray(sectionSizes)) {
            doSanityChecks = sectionSizes;
            sectionSizes = null;
        }
        const C = this.constructor;
        let sectionSizesOld = options.sectionSizesOld ?? null;
        if (sectionSizes === null || sectionSizes === undefined) {
            sectionSizes = C.SECTION_LENGTHS;
            if (sectionSizesOld === null) sectionSizesOld = C.SECTION_LENGTHS_OLD;
        }
        if (sectionSizesOld === null) sectionSizesOld = sectionSizes;
        this.sectionSizes = sectionSizes;
        this.sectionSizesOld = sectionSizesOld;

        this.language = options.language ?? PokemonNamesForGen.ENGLISH_LANGUAGE;
        this.setDefaultNickname = options.setDefaultNickname ?? false;
        this.setDefaultOt = options.setDefaultOt ?? false;
        this.setDefaultPartner = options.setDefaultPartner ?? false;
        this.doProfanityChecks = options.doProfanityChecks ?? false;
        this.useStrictLanguageChecks = options.useStrictLanguageChecks ?? false;
        this.useStrictLanguageChecksMail = options.useStrictLanguageChecksMail ?? false;
        this.doMailNewlineChecks = true;

        this.utilsClass = C.getUtilsClass();
        this.doSanityChecks = doSanityChecks;
        this.loaded = false;

        this.badIdsItems = null;
        this.badIdsMoves = null;
        this.badIdsPokemon = null;
        this.badIdsText = null;
        this.pokemonPatchSets = null;
        this.mailPatchSet = null;
        this.mailPatchSetOld = null;
        this.japaneseMailPatchSet = null;
        this.checksMap = null;
        this.checksMapOld = null;
        this.singlePokemonChecksMap = null;
        this.singlePokemonChecksMapOld = null;
        this.movesChecksMap = null;

        // Same order as the reference check_functions: the map files index it
        this.checkFunctions = [
            (v) => this.cleanNothing(v),                          // 0
            (v) => this.cleanText(v),                             // 1
            (v) => this.cleanTeamSize(v),                         // 2
            (v) => this.cleanSpecies(v),                          // 3
            (v) => this.cleanMove(v),                             // 4
            (v) => this.cleanItem(v),                             // 5
            (v) => this.cleanLevel(v),                            // 6
            (v) => this.checkHp(v),                               // 7
            (v) => this.cleanTextFinal(v),                        // 8
            (v) => this.loadStatExp(v),                           // 9
            (v) => this.loadStatIv(v),                            // 10
            (v) => this.checkStat(v),                             // 11
            (v) => this.cleanSpeciesSp(v),                        // 12
            (v) => this.cleanPp(v),                               // 13
            (v) => this.cleanExperience(v),                       // 14
            (v) => this.cleanEggCyclesFriendship(v),              // 15
            (v) => this.cleanType(v),                             // 16
            (v) => this.cleanTextNewline(v),                      // 17
            (v) => this.cleanTextFinalNoEnd(v),                   // 18
            (v) => this.cleanSpeciesForceTerminate(v),            // 19
            (v) => this.cleanMailSpecies(v),                      // 20
            (v) => this.cleanMailItem(v),                         // 21
            (v) => this.cleanMailSameSpecies(v),                  // 22
            (v) => this.cleanPokemonPatchSet(v),                  // 23
            (v) => this.cleanMailPatchSet(v),                     // 24
            (v) => this.cleanJapaneseMailPatchSet(v),             // 25
            (v) => this.cleanTextPartner(v),                      // 26
            (v) => this.cleanTextPartnerMaybeFinal(v),            // 27
            (v) => this.cleanTextNickname(v),                     // 28
            (v) => this.cleanTextNicknameFinal(v),                // 29
            (v) => this.cleanTextOt(v),                           // 30
            (v) => this.cleanTextOtMaybeFinal(v),                 // 31
            (v) => this.cleanTextPartnerFinal(v),                 // 32
            (v) => this.cleanTextOtFinal(v),                      // 33
            (v) => this.cleanTextOtMaybeFinalNoEnd(v),            // 34
            (v) => this.cleanTextMail(v),                         // 35
            (v) => this.cleanTextMailCheckNewlineInt(v),          // 36
            (v) => this.cleanTextMailCheckNewlineKorFinalInt(v),  // 37
            (v) => this.cleanTextMailFinal(v),                    // 38
            (v) => this.cleanTextNicknameSpecialCharCheck(v),     // 39
            (v) => this.cleanTextOtSpecialCharCheck(v),           // 40
            (v) => this.cleanTextPartnerSpecialCharCheck(v),      // 41
            (v) => this.cleanTextOtFinalNoEnd(v),                 // 42
            (v) => this.cleanTextOtMailStart(v),                  // 43
        ];
        this.speciesCleaner = (v) => this.cleanSpeciesSp(v);

        this.resetState();

        if (Object.prototype.hasOwnProperty.call(C, 'data') && C.data) this.buildTables();
    }

    get referenceGen() {
        return this.constructor.REFERENCE_GEN;
    }

    /**
     * Load the tables (shared by every instance of this class) and build
     * this instance's check maps. Resolves to false when the files are
     * missing.
     */
    async load() {
        if (this.loaded) return true;
        try {
            await this.constructor.load();
            this.buildTables();
            return true;
        } catch (e) {
            console.error(`[${this.constructor.name}] Error loading check data:`, e);
            return false;
        }
    }

    buildTables() {
        const d = this.constructor.data;
        const fns = this.checkFunctions;
        this.badIdsItems = GSCUtilsLoaders.prepareCheckList(d.badIdsItems);
        this.badIdsMoves = GSCUtilsLoaders.prepareCheckList(d.badIdsMoves);
        this.badIdsPokemon = GSCUtilsLoaders.prepareCheckList(d.badIdsPokemon);
        this.badIdsText = GSCUtilsLoaders.prepareCheckList(d.badIdsText);
        this.pokemonPatchSets = [GSCUtilsLoaders.prepareCheckList(d.pokemonPatchSet0), GSCUtilsLoaders.prepareCheckList(d.pokemonPatchSet1)];
        this.mailPatchSet = [GSCUtilsLoaders.prepareCheckList(d.mailPatchSet)];
        this.mailPatchSetOld = [GSCUtilsLoaders.prepareCheckList(d.mailPatchSetOld)];
        // The Japanese mail layout has its own patch positions
        this.japaneseMailPatchSet = [GSCUtilsLoaders.prepareCheckList(d.japaneseMailPatchSet)];
        this.checksMap = this.prepareChecksMap(d.checksMap, this.sectionSizes, fns);
        this.checksMapOld = this.prepareChecksMap(d.checksMapOld, this.sectionSizesOld, fns);
        this.singlePokemonChecksMap = this.prepareFunctionsMap(d.singlePokemonChecksMap, fns);
        this.singlePokemonChecksMapOld = this.prepareFunctionsMap(d.singlePokemonChecksMapOld, fns);
        this.movesChecksMap = this.prepareFunctionsMap(d.movesChecksMap, fns);
        this.loaded = true;
    }

    prepareFunctionsMap(data, functions = this.checkFunctions) {
        if (data === null || data === undefined) throw new TypeError('missing check map');
        return GSCUtilsLoaders.prepareFunctionsMap(data, functions);
    }

    prepareChecksMap(data, lengths, functions = this.checkFunctions) {
        const rawDataSections = GSCUtilsMisc.divideData(data, lengths);
        const callMap = [[], [], [], []];
        for (let i = 0; i < rawDataSections.length; i++) {
            GSCUtilsMisc.setItem(callMap, i, this.prepareFunctionsMap(rawDataSections[i], functions));
        }
        return callMap;
    }

    /**
     * Run the per-byte check functions; each output (0..n bytes) is appended.
     */
    applyChecksToData(checker, data) {
        const newData = [];
        for (let j = 0; j < checker.length; j++) {
            const checkedValue = checker[j](pyIndex(data, j));
            if (Array.isArray(checkedValue)) newData.push(...checkedValue);
            else newData.push(checkedValue);
        }
        return newData;
    }

    /**
     * Section checker: the 0x21-byte mail layout's map unless isNewFormat.
     */
    getChecker(sectionIndex, isNewFormat = false) {
        const map = isNewFormat ? this.checksMap : this.checksMapOld;
        if (!map) return null;
        return map[sectionIndex];
    }

    // ==================== Buffers ====================

    resetState() {
        this.resetSpeciesItemList();
        this.setSingleTeamSize();
        this.resetTextBuffers();
        this.preparePatchSetsBuffer();
        this.prepareSpeciesBuffer();
        this.currSpecies = 0;
        this.level = this.utilsClass.MAX_LEVEL;
        this.iv = [0, 0, 0, 0];
        this.statExp = [0, 0, 0, 0, 0];
        this.moves = [0, 0, 0, 0];
        this.currMove = 0;
        this.currPp = 0;
        this.exp = 0;
        this.expRange = [0, 0];
        this.negativeExp = false;
        this.currExpPos = 0;
        this.currHp = 0;
        this.hps = [0, 0];
        this.currPos = 0;
        this.currStatId = 0;
        this.stat = 0;
        this.statRange = [0, 0];
        this.currIvPos = 0;
        this.currExpId = 0;
        this.currStatExpPos = 0;
    }

    prepareTextBuffer() {
        this.currText = [];
        this.lastTextConverted = '';
        this.isBadTextRedeemable = false;
        this.lastConsideredChar = null;
        this.isCurrTextTwoBytes = null;
        this.lastTwoBytesError = false;
        this.forceDefaultName = false;
        this.forceNextEol = false;
        this.isMail = false;
        this.isMailOt = false;
        this.doSpecialCharsCheck = false;
        this.isKoreanSpecial = false;
        this.isPatchedForKoreanSpecial = false;
        this.specialCharsList = [];
        this.isKoreanSpecialWasJapaneseTruncated = false;
    }

    resetSpeciesItemList() {
        this.speciesList = [];
        this.speciesListSize = 0;
        this.itemList = [];
        // The name counters index speciesList, so they restart with it
        this.currSpeciesNickname = 0;
        this.lastSpeciesNickname = -1;
        this.currSpeciesOt = 0;
        this.lastSpeciesOt = -1;
    }

    resetTextBuffers() {
        this.prepareTextBuffer();
        this.hasEncounteredEol = false;
        this.hasEncounteredNewline = false;
        this.currSpeciesNickname = 0;
        this.lastSpeciesNickname = -1;
        this.currSpeciesOt = 0;
        this.lastSpeciesOt = -1;
        this.doMailNewlineChecks = true;
    }

    setSingleTeamSize() {
        this.teamSize = 1;
    }

    addToSpeciesList(species) {
        if ((species !== GSCChecks.FREE_VALUE_SPECIES) && (species !== GSCChecks.EMPTY_VALUE_SPECIES)) this.speciesListSize += 1;
        this.speciesList.push(species);
    }

    prepareSpeciesBuffer() {
        this.currSpeciesPos = 0;
    }

    preparePatchSetsBuffer() {
        this.currPatchSet = 0;
    }

    // ==================== Legacy helpers ====================

    /**
     * Clean one single-Pokémon record (0x21- or 0x41-byte mail layout, picked
     * by length); bytes after the checked part (the egg flag) are kept.
     */
    cleanSinglePokemon(data) {
        if (!this.singlePokemonChecksMap) return Array.from(data);
        const U = this.utilsClass;
        this.resetSpeciesItemList();
        this.setSingleTeamSize();
        this.resetTextBuffers();
        this.preparePatchSetsBuffer();
        this.prepareSpeciesBuffer();
        let checker = this.singlePokemonChecksMap;
        let isNew = true;
        if (data.length <= checker.length) {
            checker = this.singlePokemonChecksMapOld;
            isNew = false;
        }
        if (data.length < checker.length) return Array.from(data);
        const isEgg = data.length > checker.length && data[checker.length] === U.EGG_VALUE;
        this.speciesCleaner(isEgg ? U.EGG_ID : data[0]);
        this.prepareSpeciesBuffer();
        const raw = U.getSinglePokemonInfoClass().setData(data, isNew);
        if (raw.hasMail() && raw.mail && raw.mail.getMailLanguage() === PokemonNamesForGen.KOREAN_LANGUAGE) {
            this.doMailNewlineChecks = false;
        }
        return this.applyChecksToData(checker, data).concat(pySlice(data, checker.length));
    }

    /**
     * Clean MVS move data: [species, 4 moves, 4 PPs].
     */
    cleanMoves(data) {
        if (!this.movesChecksMap) return Array.from(data);
        this.prepareSpeciesBuffer();
        return this.applyChecksToData(this.movesChecksMap, data);
    }

    divideData(data, lengths) {
        return GSCUtilsMisc.divideData(data, lengths);
    }

    checkNormalList(checkingList, value) {
        return GSCUtilsMisc.checkNormalList(checkingList, value);
    }

    // ==================== Check functions ====================

    // Only runs fn when the sanity checks are on, else passes val through
    sanity(val, fn) {
        if (this.doSanityChecks) return fn();
        return val;
    }

    // Validators always pass with the sanity checks off
    valid(fn) {
        if (this.doSanityChecks) return fn();
        return true;
    }

    cleanNothing(val) {
        return this.sanity(val, () => val);
    }

    cleanLevel(level) {
        return this.sanity(level, () => {
            this.level = this.utilsClass.getLevelExp(this.currSpecies, this.exp);
            return this.level;
        });
    }

    expRangeCalculations() {
        const U = this.utilsClass;
        return [U.getExpLevel(this.currSpecies, U.MIN_LEVEL), U.getExpLevel(this.currSpecies, U.MAX_LEVEL)];
    }

    cleanExperience(val) {
        return this.sanity(val, () => {
            if (this.currExpPos === 0) {
                this.expRange = this.expRangeCalculations();
                if (val >= 0x80) this.negativeExp = true;
            }
            if (this.negativeExp) val = 0;
            const currReadVal = val << (8 * (2 - this.currExpPos));
            const expMask = pyIndex(GSCChecks.CURR_EXP_POS_MASKS, this.currExpPos);
            this.exp = this.checkRange(this.expRange, (this.exp & expMask) | currReadVal);
            val = (this.exp >> (8 * (2 - this.currExpPos))) & 0xFF;
            this.currExpPos += 1;
            return val;
        });
    }

    cleanTeamSize(teamSize) {
        this.teamSize = this.cleanValue(teamSize, (v) => this.isTeamSizeValid(v), 1);
        return this.teamSize;
    }

    cleanItem(item) {
        return this.sanity(item, () => {
            const cleanedItem = this.cleanValue(item, (v) => this.isItemValid(v), 0);
            this.itemList.push(cleanedItem);
            return cleanedItem;
        });
    }

    cleanPp(pp) {
        return this.sanity(pp, () => {
            const currentPp = pp & 0x3F;
            const ppUps = (pp >> 6) & 3;
            const maxBasePp = pyIndex(this.utilsClass.movesPpList, pyIndex(this.moves, this.currPp));
            let ppIncrement = Math.floor(maxBasePp / 5);
            if (maxBasePp === 40) ppIncrement -= 1;
            const maxPp = maxBasePp + (ppIncrement * ppUps);
            let finalPp = pp;
            if (currentPp > maxPp) finalPp = (ppUps << 6) | maxPp;
            this.currPp += 1;
            return finalPp;
        });
    }

    cleanMove(move) {
        return this.sanity(move, () => {
            if (move === GSCChecks.FREE_VALUE_MOVES && this.currMove > 0) {
                GSCUtilsMisc.setItem(this.moves, this.currMove, GSCChecks.FREE_VALUE_MOVES);
                this.currMove += 1;
                return move;
            }
            const finalMove = this.cleanValue(move, (v) => this.isMoveValid(v), this.constructor.TACKLE_ID);
            GSCUtilsMisc.setItem(this.moves, this.currMove, finalMove);
            this.currMove += 1;
            return finalMove;
        });
    }

    cleanSpecies(species) {
        return this.sanity(species, () => {
            this.currSpecies = this.cleanValue(species, (v) => this.isSpeciesValid(v), this.constructor.RATTATA_ID);
            this.currSpeciesPos += 1;
            this.currStatId = 0;
            this.iv = [0, 0, 0, 0];
            this.statExp = [0, 0, 0, 0, 0];
            this.moves = [0, 0, 0, 0];
            this.currMove = 0;
            this.currPp = 0;
            this.exp = 0;
            this.negativeExp = false;
            this.currExpPos = 0;
            this.currHp = 0;
            this.currPos = 0;
            this.currIvPos = 0;
            this.currExpId = 0;
            this.currStatExpPos = 0;
            return this.currSpecies;
        });
    }

    getSpeciesIsEgg(species) {
        return species === this.utilsClass.EGG_ID;
    }

    cleanSpeciesSp(species) {
        const FREE = GSCChecks.FREE_VALUE_SPECIES;
        if (species === FREE || this.speciesListSize >= this.teamSize) {
            this.addToSpeciesList(FREE);
            this.currSpeciesPos += 1;
            if (this.doSanityChecks) return FREE;
            return species;
        }
        let foundSpecies = this.cleanValue(species, (v) => this.isSpeciesValid(v), this.constructor.RATTATA_ID);
        if (this.getSpeciesIsEgg(species)) foundSpecies = species;
        this.addToSpeciesList(foundSpecies);
        this.currSpeciesPos += 1;
        if (this.doSanityChecks) return foundSpecies;
        return species;
    }

    cleanSpeciesForceTerminate(species) {
        this.prepareSpeciesBuffer();
        if (this.doSanityChecks) return GSCChecks.FREE_VALUE_SPECIES;
        return species;
    }

    loadStatExp(val) {
        return this.sanity(val, () => {
            const calcVal = val << (8 * (1 - (this.currStatExpPos & 1)));
            if (this.currStatExpPos === 0) {
                GSCUtilsMisc.setItem(this.statExp, this.currExpId, calcVal);
                this.currStatExpPos += 1;
            } else {
                GSCUtilsMisc.setItem(this.statExp, this.currExpId, pyIndex(this.statExp, this.currExpId) | calcVal);
                this.currStatExpPos = 0;
                this.currExpId += 1;
            }
            return val;
        });
    }

    loadStatIv(val) {
        return this.sanity(val, () => {
            const calcVal = GSCUtilsMisc.readNybbles(val);
            GSCUtilsMisc.setItem(this.iv, this.currIvPos * 2, calcVal[0]);
            GSCUtilsMisc.setItem(this.iv, (this.currIvPos * 2) + 1, calcVal[1]);
            this.currIvPos += 1;
            return val;
        });
    }

    cleanMailSpecies(species) {
        return this.sanity(species, () => {
            this.currSpeciesPos += 1;
            return pyIndex(this.speciesList, this.currSpeciesPos - 1);
        });
    }

    cleanMailSameSpecies(species) {
        return this.sanity(species, () => pyIndex(this.speciesList, this.currSpeciesPos - 1));
    }

    cleanMailItem(item) {
        return this.sanity(item, () => pyIndex(this.itemList, this.currSpeciesPos - 1));
    }

    cleanCharEol(char) {
        return this.sanity(char, () => {
            // Anything goes after the end of the text
            let charVal = char;
            if (!this.hasEncounteredEol) {
                charVal = this.utilsClass.END_OF_LINE;
                this.hasEncounteredEol = true;
            }
            return charVal;
        });
    }

    cleanText(char) {
        const U = this.utilsClass;
        if (this.doSpecialCharsCheck) {
            if ((char === U.KOREAN_SPECIAL_REPLACEMENT) && (this.language === PokemonNamesForGen.KOREAN_LANGUAGE)) {
                this.isKoreanSpecial = true;
                return [];
            }
            if ((char === U.KOREAN_PATCHED_SPECIAL_REPLACEMENT) && (this.language !== PokemonNamesForGen.KOREAN_LANGUAGE)) {
                this.isPatchedForKoreanSpecial = true;
                return [];
            }
        }
        const charVal = this.cleanTextValue(char, (v) => this.isCharValid(v));
        this.currText.push(charVal);
        if (this.lastConsideredChar === null) {
            this.lastTextConverted = PokemonNamesForGen.convertGenericNameGeneralForGen(this.currText, this.referenceGen, this.language);
        }
        return charVal;
    }

    cleanTextFinal(char) {
        const charVal = this.cleanCharEol(char);
        this.currText.push(charVal);
        this.prepareTextBuffer();
        return charVal;
    }

    getCharCheckIfBadTextRedeemable(char, methodGet) {
        if ((!this.isBadTextRedeemable) || this.hasEncounteredEol || (!this.doProfanityChecks)) return char;

        const toCheckText = this.lastTextConverted.toLowerCase();
        const wordsRedeemable = methodGet(this.lastTextConverted, this.language, this.isCurrTextTwoBytes) ?? [];
        const possibleContinuations = new Set();

        if (wordsRedeemable.includes(toCheckText)) possibleContinuations.add('\0');

        const lastLen = pyLen(this.lastTextConverted);
        const isUpper = pyIsUpper(this.lastTextConverted);
        for (let word of wordsRedeemable) {
            if (word !== toCheckText) {
                if (isUpper) word = word.toUpperCase();
                possibleContinuations.add(pyIndex(Array.from(word), lastLen));
            }
        }

        // The reference iterates a set here, so its order is arbitrary:
        // code point order keeps the choice of the default stable
        const convertedPossibleContinuations = [];
        for (const possibleChar of Array.from(possibleContinuations).sort(byCodePoint)) {
            let convertedChar;
            try {
                convertedChar = PokemonTextConversions.convertCharToGenxChar(possibleChar, this.referenceGen, this.language, this.isCurrTextTwoBytes);
            } catch (e) {
                // A whitelisted word in another script has no bytes in this game
                continue;
            }
            if ((convertedChar.length === 1) && this.isCurrTextTwoBytes && (this.lastConsideredChar !== null)) continue;
            if (this.isCurrTextTwoBytes && (this.lastConsideredChar !== null) && (this.lastConsideredChar !== pyIndex(convertedChar, 0))) continue;
            if (this.lastConsideredChar !== null) convertedPossibleContinuations.push(pyIndex(convertedChar, 1));
            else convertedPossibleContinuations.push(pyIndex(convertedChar, 0));
        }

        if (!convertedPossibleContinuations.includes(char)) {
            char = this.utilsClass.END_OF_LINE;
            if (convertedPossibleContinuations.length > 0) char = convertedPossibleContinuations[0];
        }
        return char;
    }

    getCharCheckIfBadText(char, methodIs, methodGet, maxNameLen) {
        char = this.getCharCheckIfBadTextRedeemable(char, methodGet);

        if ((this.lastTextConverted.length <= 0) || (this.isCurrTextTwoBytes && (this.lastConsideredChar === null)) || this.hasEncounteredEol || (!this.doProfanityChecks)) {
            return char;
        }

        const nextText = PokemonNamesForGen.convertGenericNameGeneralForGen(this.currText.concat([char]), this.referenceGen, this.language);
        if (!PokemonBadWordsFilter.isBadWord(nextText)) return char;

        // A bad prefix may still turn into a good word if there is room left
        if ((char !== this.utilsClass.END_OF_LINE) && ((this.currText.length + 1) < maxNameLen) && (!PokemonBadWordsFilter.isBadWord(nextText + '?'))) {
            return char;
        }

        if (methodIs(this.lastTextConverted, this.language, this.isCurrTextTwoBytes)) {
            if (!this.isBadTextRedeemable) {
                this.isBadTextRedeemable = true;
                char = this.getCharCheckIfBadTextRedeemable(char, methodGet);
            }
        } else {
            char = GSCChecks.QUESTION_MARK;
            if ((this.language === PokemonNamesForGen.KOREAN_LANGUAGE) && this.isCurrTextTwoBytes) char = GSCChecks.QUESTION_MARK_KOR[1];
        }
        return char;
    }

    handleSpecialText(char) {
        const U = this.utilsClass;
        if ((!this.isKoreanSpecial) && (!this.isPatchedForKoreanSpecial)) return [char];

        if (char === U.PROHIBITED_CHAR_REPLACEMENT) char = U.PROHIBITED_CHAR;
        this.specialCharsList.push(char);

        if (this.isPatchedForKoreanSpecial) return U.applyTextTransformProtectKoreanFromJpnSpecial(this.specialCharsList);
        if (this.isKoreanSpecial) return U.applyTextTransformProtectInternationalFromKoreanSpecial(this.specialCharsList, this);
        return [char];
    }

    processAndCleanReplacableText(actualChar, doNameReplacement, replacementName, methodIs, methodGet, maxNameLen) {
        const currPos = this.currText.length;
        if (doNameReplacement) {
            if (currPos < pyLen(replacementName)) actualChar = replacementName[currPos];
            else actualChar = this.utilsClass.END_OF_LINE;
        }
        actualChar = this.getCharCheckIfBadText(actualChar, methodIs, methodGet, maxNameLen);
        return this.cleanText(actualChar);
    }

    processAndCleanReplacableTextMon(actualChar, doNameReplacement, replacementName) {
        return this.processAndCleanReplacableText(actualChar, doNameReplacement, replacementName,
            PokemonBadWordsFilter.getIsRootWhitelistedOfMonName, PokemonBadWordsFilter.getRootWhitelistedWordsOfMonName,
            PokemonNamesForGen.getPokemonMaxNicknameLength(this.referenceGen, this.language));
    }

    processAndCleanReplacableTextOt(actualChar, doNameReplacement, replacementName) {
        return this.processAndCleanReplacableText(actualChar, doNameReplacement, replacementName,
            PokemonBadWordsFilter.getIsRootWhitelistedOfOtName, PokemonBadWordsFilter.getRootWhitelistedWordsOfOtName,
            PokemonNamesForGen.getTrainerMaxNameLength(this.referenceGen, this.language));
    }

    cleanTextPartner(char, setCheckForSpecialChars = false) {
        const trainerName = PokemonNamesForGen.getTrainerNameForGen(this.referenceGen, this.language);

        this.doSpecialCharsCheck = setCheckForSpecialChars;
        const charsToProcess = this.handleSpecialText(char);
        const outValues = [];
        for (const c of charsToProcess) {
            const doNameReplacement = this.setDefaultPartner || this.forceDefaultName;
            outValues.push(this.processAndCleanReplacableTextOt(c, doNameReplacement, trainerName));
        }
        if (charsToProcess.length === 1) return outValues[0];
        return outValues;
    }

    cleanTextPartnerSpecialCharCheck(char) {
        return this.cleanTextPartner(char, true);
    }

    cleanTextPartnerMaybeFinal(char) {
        if (!this.isCurrTextTwoBytes) return this.cleanTextPartnerFinal(char);
        return this.cleanTextPartner(char);
    }

    cleanTextPartnerFinal(char) {
        return this.cleanTextFinal(char);
    }

    cleanTextNickname(char, setCheckForSpecialChars = false) {
        const FREE = GSCChecks.FREE_VALUE_SPECIES;
        const EMPTY = GSCChecks.EMPTY_VALUE_SPECIES;
        this.lastSpeciesNickname = this.currSpeciesNickname;
        const monSpecies = pyIndex(this.speciesList, this.currSpeciesNickname);
        const isAnEgg = this.isEgg(this.currSpeciesNickname);
        let pokemonName = null;
        if ((monSpecies !== FREE) && (monSpecies !== EMPTY)) {
            if (isAnEgg) pokemonName = PokemonNamesForGen.getEggNameForGen(this.referenceGen, this.language);
            else pokemonName = PokemonNamesForGen.getPokemonNameForGen(monSpecies, this.referenceGen, this.language);
        }

        this.doSpecialCharsCheck = setCheckForSpecialChars;
        const charsToProcess = this.handleSpecialText(char);
        const outValues = [];
        for (const c of charsToProcess) {
            const doNameReplacement = (monSpecies !== FREE) && (monSpecies !== EMPTY) && (pokemonName != null)
                && ((isAnEgg && this.doSanityChecks) || this.setDefaultNickname || this.forceDefaultName);
            outValues.push(this.processAndCleanReplacableTextMon(c, doNameReplacement, pokemonName));
        }
        if (charsToProcess.length === 1) return outValues[0];
        return outValues;
    }

    cleanTextNicknameSpecialCharCheck(char) {
        return this.cleanTextNickname(char, true);
    }

    cleanTextNicknameFinal(char) {
        if (this.lastSpeciesNickname === this.currSpeciesNickname) this.currSpeciesNickname += 1;
        return this.cleanTextFinal(char);
    }

    cleanTextOt(char, setCheckForSpecialChars = false) {
        this.lastSpeciesOt = this.currSpeciesOt;
        const trainerName = PokemonNamesForGen.getTrainerNameForGen(this.referenceGen, this.language);

        this.doSpecialCharsCheck = setCheckForSpecialChars;
        const charsToProcess = this.handleSpecialText(char);
        const outValues = [];
        for (const c of charsToProcess) {
            // Partner names have no such check
            if ((c === GSCChecks.TRAINER_NAME_ID) && (this.currText.length === 0)) {
                if ((this.language === PokemonNamesForGen.KOREAN_LANGUAGE) && this.doSanityChecks) this.forceDefaultName = true;
            }
            const doNameReplacement = this.setDefaultPartner || this.forceDefaultName;
            outValues.push(this.processAndCleanReplacableTextOt(c, doNameReplacement, trainerName));
        }
        if (charsToProcess.length === 1) return outValues[0];
        return outValues;
    }

    cleanTextOtMailStart(char) {
        this.isMailOt = true;
        return this.cleanTextOt(char);
    }

    cleanTextOtSpecialCharCheck(char) {
        return this.cleanTextOt(char, true);
    }

    cleanTextOtMaybeFinal(char) {
        if (!this.isCurrTextTwoBytes) return this.cleanTextOtFinal(char);
        return this.cleanTextOt(char);
    }

    cleanTextOtFinal(char) {
        if (this.lastSpeciesOt === this.currSpeciesOt) this.currSpeciesOt += 1;
        return this.cleanTextFinal(char);
    }

    // Japanese OT names end without an EOL slot
    cleanTextOtFinalNoEnd(char) {
        if (this.lastSpeciesOt === this.currSpeciesOt) this.currSpeciesOt += 1;
        return this.cleanTextFinalNoEnd(char);
    }

    // Korean mail OT names end without an EOL slot
    cleanTextOtMaybeFinalNoEnd(char) {
        if (!this.isCurrTextTwoBytes) return this.cleanTextOtFinal(char);
        if (this.lastSpeciesOt === this.currSpeciesOt) this.currSpeciesOt += 1;
        return this.cleanTextFinalNoEnd(char);
    }

    checkMailCharEolNewline(char) {
        return this.sanity(char, () => {
            if ((this.currText.length === 0) || this.hasEncounteredEol || (!this.doMailNewlineChecks)) return char;
            const linesToProcess = this.utilsClass.getGeneralStringReadyForCountingLinesAndChars(this.lastTextConverted);
            const numCharsCurrline = pyLen(linesToProcess[linesToProcess.length - 1]);
            const numLines = linesToProcess.length;
            if (numCharsCurrline >= GSCChecks.MAX_MAIL_LINE_LENGTH) {
                if (numLines === 1) {
                    if (this.language === PokemonNamesForGen.KOREAN_LANGUAGE) char = GSCChecks.NEWLINE_KOR;
                    else char = GSCChecks.NEWLINE;
                } else {
                    char = this.utilsClass.END_OF_LINE;
                }
            }
            return char;
        });
    }

    cleanTextMail(char) {
        // Mails allow different characters
        this.isMail = true;
        char = this.checkMailCharEolNewline(char);
        let addedNewline = false;
        // A Korean mail must have its newline before it ends
        if ((this.language === PokemonNamesForGen.KOREAN_LANGUAGE) && (!this.hasEncounteredNewline)
            && (char === this.utilsClass.END_OF_LINE) && this.doSanityChecks && this.doMailNewlineChecks) {
            char = GSCChecks.NEWLINE_KOR;
            addedNewline = true;
        }
        const outVal = this.cleanText(char);
        if (addedNewline) this.forceNextEol = true;
        return outVal;
    }

    // Puts the newline at its fixed position, unless the mail already has one
    cleanTextMailCheckNewlineInt(char) {
        if ((this.language !== PokemonNamesForGen.KOREAN_LANGUAGE) && (!this.hasEncounteredNewline) && this.doSanityChecks) {
            char = GSCChecks.NEWLINE;
        }
        return this.cleanTextMail(char);
    }

    cleanTextMailCheckNewlineKorFinalInt(char) {
        if (this.language !== PokemonNamesForGen.KOREAN_LANGUAGE) return this.cleanTextMailFinal(char);
        if ((!this.hasEncounteredNewline) && this.doSanityChecks) char = GSCChecks.NEWLINE_KOR;
        return this.cleanTextMail(char);
    }

    cleanTextMailFinal(char) {
        this.isMail = true;
        char = this.checkMailCharEolNewline(char);
        return this.cleanTextFinalNoEnd(char);
    }

    cleanTextNewline(char) {
        const charVal = GSCChecks.NEWLINE;
        this.currText.push(charVal);
        return charVal;
    }

    cleanTextFinalNoEnd(char) {
        const charVal = this.cleanTextValue(char, (v) => this.isCharValid(v));
        this.currText.push(charVal);
        this.prepareTextBuffer();
        return charVal;
    }

    cleanType(typing) {
        return this.sanity(typing, () => typing);
    }

    checkRange(statRange, currStat) {
        if (currStat > statRange[1]) currStat = statRange[1];
        if (currStat < statRange[0]) currStat = statRange[0];
        return currStat;
    }

    checkStat(val, zeroMin = false, zeroMax = false) {
        return this.sanity(val, () => {
            const U = this.utilsClass;
            if (this.currPos === 0) {
                this.stat = 0;
                let minStat = U.statCalculation(this.currStatId, this.currSpecies, this.iv, this.statExp, this.level, false);
                let maxStat = U.statCalculation(this.currStatId, this.currSpecies, this.iv, this.statExp, this.level);
                if (zeroMin || zeroMax) minStat = 0;
                if (zeroMax) maxStat = 0;
                this.statRange = [minStat, maxStat];
            }
            const currReadVal = val << (8 * (1 - (this.currPos & 1)));
            this.stat = this.checkRange(this.statRange, (this.stat & 0xFF00) | currReadVal);
            val = (this.stat >> (8 * (1 - (this.currPos & 1)))) & 0xFF;
            this.currPos += 1;
            if (this.currPos >= 2) {
                this.currStatId += 1;
                this.currPos = 0;
            }
            return val;
        });
    }

    isEgg(index) {
        return pyIndex(this.speciesList, index) === this.utilsClass.EGG_ID;
    }

    checkHp(val) {
        return this.sanity(val, () => {
            let startZero = false;
            let maxZero = false;
            if (this.currHp === 0) {
                startZero = true;
                maxZero = this.isEgg(this.currSpeciesPos - 1);
            }
            val = this.checkStat(val, startZero, maxZero);
            if (this.currPos === 0) {
                if (this.currHp === 0) {
                    this.hps = [0, 0];
                    this.currStatId -= 1;
                }
                GSCUtilsMisc.setItem(this.hps, this.currHp, this.stat);
                this.currHp += 1;
            }
            return val;
        });
    }

    cleanEggCyclesFriendship(cyclesFriendship) {
        return this.sanity(cyclesFriendship, () => cyclesFriendship);
    }

    checkPatchSet(val, patchSets) {
        if (this.currPatchSet >= patchSets.length) return GSCChecks.NO_CONVERSION_PATCH;
        if (val === GSCChecks.END_OF_PATCH) {
            this.currPatchSet += 1;
            return val;
        }
        if (GSCUtilsMisc.checkNormalList(patchSets[this.currPatchSet], val)) return val;
        return GSCChecks.NO_CONVERSION_PATCH;
    }

    cleanPokemonPatchSet(val) {
        return this.sanity(val, () => this.checkPatchSet(val, this.pokemonPatchSets));
    }

    cleanMailPatchSet(val) {
        return this.sanity(val, () => this.checkPatchSet(val, this.mailPatchSet));
    }

    cleanJapaneseMailPatchSet(val) {
        return this.sanity(val, () => this.checkPatchSet(val, this.japaneseMailPatchSet));
    }

    cleanValue(value, checker, defaultValue) {
        if (checker(value)) return value;
        return defaultValue;
    }

    cleanTextValue(value, checker) {
        return this.sanity(value, () => {
            const U = this.utilsClass;
            const KOREAN = PokemonNamesForGen.KOREAN_LANGUAGE;
            const JAPANESE = PokemonNamesForGen.JAPANESE_LANGUAGE;
            if (this.forceNextEol) {
                this.forceNextEol = false;
                value = U.END_OF_LINE;
            }

            const wasLastPartial = this.lastConsideredChar !== null;

            // Korean lacks a few characters Japanese has, and vice versa
            let dictToReplaceBadChars = U.badIdsTextSpecialToKor;
            if (this.language === JAPANESE) dictToReplaceBadChars = U.badIdsTextSpecialFromKor;
            // Leave the second byte of a Korean character alone
            if ((!wasLastPartial) && dictToReplaceBadChars.has(value) && (!this.hasEncounteredEol)) {
                value = dictToReplaceBadChars.get(value);
            }

            if (checker(value)) return value;

            if (this.isMail) {
                if ((value === GSCChecks.MAIL_TEXT_NULL) && (!this.isCurrTextTwoBytes)) return GSCChecks.MAIL_TEXT_NULL;
                if ((((value === GSCChecks.NEWLINE) && (!this.isCurrTextTwoBytes)) || (value === GSCChecks.NEWLINE_KOR)) && (!this.hasEncounteredNewline)) {
                    this.hasEncounteredNewline = true;
                    this.lastTwoBytesError = false;
                    if (this.language === KOREAN) {
                        if (this.isCurrTextTwoBytes === null) this.isCurrTextTwoBytes = true;
                        return GSCChecks.NEWLINE_KOR;
                    }
                    return GSCChecks.NEWLINE;
                }
                // Only reached on errors, which also covers bad data
                if (this.language !== JAPANESE) {
                    if ((value === GSCChecks.MAIL_REPLACED_FE) || (value === GSCChecks.MAIL_REPLACED_FE_KOR)) {
                        if (this.language === KOREAN) return GSCChecks.MAIL_REPLACED_FE_KOR;
                        return GSCChecks.MAIL_REPLACED_FE;
                    }
                }
            }

            if (!this.isCurrTextTwoBytes) return GSCChecks.QUESTION_MARK;

            let bytesOut = null;
            if (this.language === KOREAN) bytesOut = GSCChecks.QUESTION_MARK_KOR;
            if (bytesOut === null) return GSCChecks.QUESTION_MARK;

            let indexOut;
            if (wasLastPartial) {
                // The first byte is already out, so only the second can change
                indexOut = 1;
                this.lastConsideredChar = null;
            } else {
                indexOut = 0;
                // Makes the next byte the second half of the replacement
                this.lastConsideredChar = bytesOut[indexOut];
            }
            return bytesOut[indexOut];
        });
    }

    isTeamSizeValid(teamSize) {
        return this.valid(() => !(teamSize <= 0 || teamSize > 6));
    }

    isItemValid(item) {
        return this.valid(() => !GSCUtilsMisc.checkNormalList(this.badIdsItems, item));
    }

    isMoveValid(move) {
        return this.valid(() => !GSCUtilsMisc.checkNormalList(this.badIdsMoves, move));
    }

    isSpeciesValid(species) {
        return this.valid(() => !GSCUtilsMisc.checkNormalList(this.badIdsPokemon, species));
    }

    convertCharToGeneral(char) {
        const [outValue, isPartial, isQuestionMark] = PokemonTextConversions.convertGenxCharToChar(char, this.referenceGen, this.language, this.lastConsideredChar);
        this.lastConsideredChar = null;
        if (isPartial) this.lastConsideredChar = char;
        // Newlines are handled by the mail code, if allowed at all
        if (outValue === '\n') return ['?', false, true];
        return [outValue, isPartial, isQuestionMark];
    }

    isCharValid(char) {
        return this.valid(() => {
            const U = this.utilsClass;
            const KOREAN = PokemonNamesForGen.KOREAN_LANGUAGE;
            const JAPANESE = PokemonNamesForGen.JAPANESE_LANGUAGE;
            const currTextLen = this.currText.length;
            if (currTextLen === 0) {
                this.hasEncounteredEol = false;
                this.hasEncounteredNewline = false;
            }

            // An error in the first byte also discards the second one
            if (this.lastTwoBytesError) {
                this.lastConsideredChar = null;
                this.lastTwoBytesError = false;
                return false;
            }

            const wasLastPartial = this.lastConsideredChar !== null;
            if ((!wasLastPartial) && (char === U.END_OF_LINE)) {
                // No empty names
                if ((currTextLen === 0) && (!this.isMail)) {
                    this.forceNextEol = true;
                    return false;
                }
                this.hasEncounteredEol = true;
                return true;
            }

            if (this.hasEncounteredEol) {
                // The mail code still has to see its newline
                if (this.isMail && (!this.hasEncounteredNewline) && ((char === GSCChecks.NEWLINE) || (char === GSCChecks.NEWLINE_KOR))) return false;
                return true;
            }

            if (this.isMail && (this.language !== JAPANESE)
                && (((this.language !== KOREAN) && (char === GSCChecks.MAIL_REPLACED_FE)) || ((this.language === KOREAN) && (char === GSCChecks.MAIL_REPLACED_FE_KOR)))) {
                char = 0xFE;
            }

            const [, isPartial, isQuestionMark] = this.convertCharToGeneral(char);

            if ((char === GSCChecks.TRAINER_NAME_ID) && (currTextLen === 0)) {
                // "TRAINER" (not in Korean) only works alone at the start
                this.forceNextEol = true;
                return true;
            }

            // A text is either all single bytes or all double bytes
            if (this.isCurrTextTwoBytes === null) this.isCurrTextTwoBytes = isPartial;
            if ((!this.isCurrTextTwoBytes) && isPartial) {
                this.lastTwoBytesError = true;
                return false;
            }
            if (this.isCurrTextTwoBytes && (!isPartial) && (!wasLastPartial)) {
                this.lastTwoBytesError = true;
                return false;
            }

            if (this.isMail || this.isMailOt) {
                // Mail text belongs to the mail's own language
                if ((!this.useStrictLanguageChecksMail) && (!wasLastPartial)) return !GSCUtilsMisc.checkNormalList(this.badIdsText, char);
            } else if ((!this.useStrictLanguageChecks) && (!wasLastPartial)) {
                return !GSCUtilsMisc.checkNormalList(this.badIdsText, char);
            }

            return !isQuestionMark;
        });
    }
}
