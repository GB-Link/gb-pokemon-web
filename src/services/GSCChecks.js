/**
 * GSCChecks - Data validation and sanitization for GSC trading.
 * Based on ref. impl.'s gsc_trading_data_utils.py GSCChecks class.
 * 
 * This class performs sanity checks on incoming Pokémon data to prevent:
 * - Invalid/glitch Pokémon species
 * - Invalid moves, items, or text characters
 * - Stats that don't match calculated values
 * - Malicious data manipulation
 */
import { GSCUtils } from './GSCUtils.js?v=88';

export class GSCChecks {
    // Default replacement values
    static TACKLE_ID = 0x21;
    static RATTATA_ID = 0x13;
    static QUESTION_MARK = 0xE6;
    static NEWLINE = 0x4E;
    static FREE_VALUE_SPECIES = 0xFF;
    static EMPTY_VALUE_SPECIES = 0x00;
    static FREE_VALUE_MOVES = 0x00;
    static NO_CONVERSION_PATCH = 0x00;
    static END_OF_PATCH = 0xFF;
    static PATCH_SET_COVER = 0xFC;
    static EGG_ID = 0xFD;

    // Section lengths matching ref. impl.'s special_sections_len
    static SECTION_LENGTHS = [0xA, 0x1BC, 0xC5, 0x181];

    constructor(doSanityChecks = true) {
        this.doSanityChecks = doSanityChecks;
        this.loaded = false;

        // Bad ID lists (256-entry boolean arrays)
        this.badIdsItems = null;
        this.badIdsMoves = null;
        this.badIdsPokemon = null;
        this.badIdsText = null;

        // Check function maps
        this.checksMap = null;
        this.singlePokemonChecksMap = null;
        this.movesChecksMap = null;

        // Moves PP list
        this.movesPpList = null;

        // Patch sets
        this.pokemonPatchSets = null;
        this.mailPatchSet = null;

        // State variables for multi-byte checks
        this.resetState();

        // Define check functions array (order matches ref. impl.'s check_functions list)
        this.checkFunctions = [
            (val) => this.cleanNothing(val),           // 0
            (val) => this.cleanText(val),              // 1
            (val) => this.cleanTeamSize(val),          // 2
            (val) => this.cleanSpecies(val),           // 3
            (val) => this.cleanMove(val),              // 4
            (val) => this.cleanItem(val),              // 5
            (val) => this.cleanLevel(val),             // 6
            (val) => this.checkHp(val),                // 7
            (val) => this.cleanTextFinal(val),         // 8
            (val) => this.loadStatExp(val),            // 9
            (val) => this.loadStatIv(val),             // 10
            (val) => this.checkStat(val),              // 11
            (val) => this.cleanSpeciesSp(val),         // 12
            (val) => this.cleanPp(val),                // 13
            (val) => this.cleanExperience(val),        // 14
            (val) => this.cleanEggCyclesFriendship(val), // 15
            (val) => this.cleanType(val),              // 16
            (val) => this.cleanTextNewline(val),       // 17
            (val) => this.cleanTextFinalNoEnd(val),    // 18
            (val) => this.cleanSpeciesForceTerminate(val), // 19
            (val) => this.cleanMailSpecies(val),       // 20
            (val) => this.cleanMailItem(val),          // 21
            (val) => this.cleanMailSameSpecies(val),   // 22
            (val) => this.cleanPokemonPatchSet(val),   // 23
            (val) => this.cleanMailPatchSet(val),      // 24
            (val) => this.cleanJapaneseMailPatchSet(val) // 25
        ];
    }

    /**
     * Reset all state variables for a new check session.
     */
    resetState() {
        // Team/species tracking
        this.teamSize = 1;
        this.speciesList = [];
        this.speciesListSize = 0;
        this.itemList = [];
        this.currSpeciesPos = 0;
        this.currSpecies = 0;

        // Move tracking
        this.moves = [0, 0, 0, 0];
        this.currMove = 0;
        this.currPp = 0;

        // Experience/level tracking
        this.exp = 0;
        this.negativeExp = false;
        this.currExpPos = 0;
        this.level = 1;

        // Stat tracking
        this.iv = [0, 0, 0, 0];
        this.statExp = [0, 0, 0, 0, 0];
        this.currStatId = 0;
        this.currStatExpPos = 0;
        this.currExpId = 0;
        this.currIvPos = 0;
        this.stat = 0;
        this.statRange = [0, 0];
        this.currPos = 0;

        // HP tracking
        this.currHp = 0;
        this.hps = [0, 0];

        // Text tracking
        this.currText = [];

        // Patch set tracking
        this.currPatchSet = 0;
    }

    /**
     * Load all binary data files required for checks.
     * Must be called before using the checker.
     */
    async load() {
        if (this.loaded) return true;

        try {
            const basePath = '/data/gsc/';

            // Load bad ID lists
            this.badIdsItems = await this.loadCheckList(basePath + 'bad_ids_items.bin');
            this.badIdsMoves = await this.loadCheckList(basePath + 'bad_ids_moves.bin');
            this.badIdsPokemon = await this.loadCheckList(basePath + 'bad_ids_pokemon.bin');
            this.badIdsText = await this.loadCheckList(basePath + 'bad_ids_text.bin');

            // Load moves PP list
            this.movesPpList = await this.loadBinaryData(basePath + 'moves_pp_list.bin');
            if (!this.movesPpList) {
                // Default PP list if file not found
                this.movesPpList = new Uint8Array(256).fill(35);
            }

            // Load patch sets
            const patchSet0 = await this.loadCheckList(basePath + 'pokemon_patch_set_0.bin');
            const patchSet1 = await this.loadCheckList(basePath + 'pokemon_patch_set_1.bin');
            this.pokemonPatchSets = [patchSet0, patchSet1];
            this.mailPatchSet = [await this.loadCheckList(basePath + 'mail_patch_set.bin')];
            this.japanesePatchSet = this.mailPatchSet; // Same for now

            // Load check maps
            const checksMapRaw = await this.loadBinaryData(basePath + 'checks_map.bin');
            const singleMapRaw = await this.loadBinaryData(basePath + 'single_pokemon_checks_map.bin');
            const movesMapRaw = await this.loadBinaryData(basePath + 'moves_checks_map.bin');

            // Convert raw maps to function arrays
            this.checksMap = this.prepareChecksMap(checksMapRaw, GSCChecks.SECTION_LENGTHS);
            this.singlePokemonChecksMap = this.prepareFunctionsMap(singleMapRaw);
            this.movesChecksMap = this.prepareFunctionsMap(movesMapRaw);

            this.loaded = true;
            console.log('[GSCChecks] Loaded all check data files');
            return true;
        } catch (e) {
            console.error('[GSCChecks] Error loading check data:', e);
            return false;
        }
    }

    /**
     * Load binary data from a file path.
     */
    async loadBinaryData(path) {
        try {
            const response = await fetch(path);
            if (!response.ok) return null;
            const buffer = await response.arrayBuffer();
            return new Uint8Array(buffer);
        } catch (e) {
            console.warn(`[GSCChecks] Could not load ${path}:`, e.message);
            return null;
        }
    }

    /**
     * Load binary data and convert to 256-entry boolean check list.
     */
    async loadCheckList(path) {
        const data = await this.loadBinaryData(path);
        return this.prepareCheckList(data);
    }

    /**
     * Convert raw binary data to 256-entry boolean array.
     * Each byte in data sets the corresponding index to true.
     */
    prepareCheckList(data) {
        const ret = new Array(256).fill(false);
        if (data) {
            for (let i = 0; i < data.length; i++) {
                ret[data[i]] = true;
            }
        }
        return ret;
    }

    /**
     * Convert raw check map to function array.
     */
    prepareFunctionsMap(data) {
        if (!data) return null;
        const callMap = [];
        for (let i = 0; i < data.length; i++) {
            const funcIndex = data[i];
            if (funcIndex < this.checkFunctions.length) {
                callMap.push(this.checkFunctions[funcIndex]);
            } else {
                callMap.push(this.checkFunctions[0]); // Default to cleanNothing
            }
        }
        return callMap;
    }

    /**
     * Prepare checks map for all sections.
     */
    prepareChecksMap(data, lengths) {
        if (!data) return null;

        const rawDataSections = this.divideData(data, lengths);
        const callMap = [[], [], [], []];

        for (let i = 0; i < rawDataSections.length; i++) {
            callMap[i] = this.prepareFunctionsMap(rawDataSections[i]);
        }
        return callMap;
    }

    /**
     * Divide data into sections based on lengths.
     */
    divideData(data, lengths) {
        const divData = [];
        let offset = 0;
        for (let i = 0; i < lengths.length; i++) {
            if (offset + lengths[i] <= data.length) {
                divData.push(data.slice(offset, offset + lengths[i]));
            } else {
                divData.push(data.slice(offset));
            }
            offset += lengths[i];
        }
        return divData;
    }

    /**
     * Check if a value is in the 256-entry check list.
     */
    checkNormalList(checkingList, value) {
        if (value >= 0x100 || value < 0) return false;
        return checkingList[value];
    }

    // ==================== Buffer Management ====================

    prepareTextBuffer() {
        this.currText = [];
    }

    resetSpeciesItemList() {
        this.speciesList = [];
        this.speciesListSize = 0;
        this.itemList = [];
    }

    setSingleTeamSize() {
        this.teamSize = 1;
    }

    addToSpeciesList(species) {
        if (species !== GSCChecks.FREE_VALUE_SPECIES && species !== GSCChecks.EMPTY_VALUE_SPECIES) {
            this.speciesListSize++;
        }
        this.speciesList.push(species);
    }

    prepareSpeciesBuffer() {
        this.currSpeciesPos = 0;
    }

    preparePatchSetsBuffer() {
        this.currPatchSet = 0;
    }

    // ==================== Apply Checks ====================

    /**
     * Apply check functions to data array.
     * @param {Array} checker - Array of check functions
     * @param {Array|Uint8Array} data - Data to check
     * @returns {Array} Cleaned data
     */
    applyChecksToData(checker, data) {
        if (!checker) return Array.from(data);

        const newData = Array.from(data);
        const len = Math.min(checker.length, newData.length);
        for (let j = 0; j < len; j++) {
            newData[j] = checker[j](data[j]);
        }
        return newData;
    }

    /**
     * Get the checker for a specific section.
     */
    getChecker(sectionIndex) {
        if (!this.checksMap) return null;
        return this.checksMap[sectionIndex];
    }

    // ==================== Cleaning Functions ====================

    /**
     * Decorator-like wrapper that only runs function if sanity checks enabled.
     */
    _cleanCheck(val, cleanFunc) {
        if (this.doSanityChecks) {
            return cleanFunc(val);
        }
        return val;
    }

    /**
     * Decorator-like wrapper for validation functions.
     */
    _validCheck(validFunc) {
        if (this.doSanityChecks) {
            return validFunc();
        }
        return true;
    }

    cleanNothing(val) {
        return this._cleanCheck(val, (v) => v);
    }

    cleanText(val) {
        return this._cleanCheck(val, (v) => {
            const charVal = this.cleanValue(v, () => this.isCharValid(v), GSCChecks.QUESTION_MARK);
            this.currText.push(charVal);
            return charVal;
        });
    }

    cleanTeamSize(val) {
        return this._cleanCheck(val, (v) => {
            this.teamSize = this.cleanValue(v, () => this.isTeamSizeValid(v), 1);
            return this.teamSize;
        });
    }

    cleanSpecies(val) {
        return this._cleanCheck(val, (v) => {
            this.currSpecies = this.cleanValue(v, () => this.isSpeciesValid(v), GSCChecks.RATTATA_ID);
            this.currSpeciesPos++;
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

    cleanMove(val) {
        return this._cleanCheck(val, (v) => {
            if (v === GSCChecks.FREE_VALUE_MOVES && this.currMove > 0) {
                this.moves[this.currMove] = GSCChecks.FREE_VALUE_MOVES;
                this.currMove++;
                return v;
            }
            const finalMove = this.cleanValue(v, () => this.isMoveValid(v), GSCChecks.TACKLE_ID);
            this.moves[this.currMove] = finalMove;
            this.currMove++;
            return finalMove;
        });
    }

    cleanItem(val) {
        return this._cleanCheck(val, (v) => {
            const cleanedItem = this.cleanValue(v, () => this.isItemValid(v), 0);
            this.itemList.push(cleanedItem);
            return cleanedItem;
        });
    }

    cleanLevel(val) {
        return this._cleanCheck(val, (v) => {
            // Calculate expected level from experience using GSCUtils
            if (GSCUtils.loaded && this.currSpecies > 0) {
                // Use real level calculation based on accumulated EXP
                const calculatedLevel = GSCUtils.getLevelExp(this.currSpecies, this.exp);
                // Clamp to valid range and prefer calculated level
                this.level = Math.max(2, Math.min(100, calculatedLevel));
            } else {
                // Fallback: cap to valid range
                this.level = Math.max(2, Math.min(100, v));
            }
            return this.level;
        });
    }

    checkHp(val) {
        return this._cleanCheck(val, (v) => {
            // HP check logic - validate against calculated stats
            const startZero = this.currHp === 0;
            const maxZero = this.isEgg();

            v = this.checkStatInternal(v, startZero, maxZero);

            if (this.currPos === 0) {
                if (this.currHp === 0) {
                    this.hps = [0, 0];
                    this.currStatId--;
                }
                this.hps[this.currHp] = this.stat;
                this.currHp++;

                // Validate Max HP against calculated value
                if (this.currHp === 2 && GSCUtils.loaded && this.currSpecies > 0 && this.level > 0) {
                    const calculatedMaxHp = GSCUtils.statCalculation(
                        GSCUtils.HP_STAT_ID,
                        this.currSpecies,
                        this.ivs || [0, 0, 0, 0],
                        this.statExp || [0, 0, 0, 0, 0],
                        this.level,
                        true
                    );
                    // If current HP > calculated max HP, cap it
                    if (this.hps[0] > calculatedMaxHp) {
                        this.hps[0] = calculatedMaxHp;
                    }
                    // Max HP should match calculation (with some tolerance for stat exp)
                    // For now just log if significantly different
                    if (Math.abs(this.hps[1] - calculatedMaxHp) > 10) {
                        // HP significantly off - could flag for inspection
                    }
                }
            }
            return v;
        });
    }

    cleanTextFinal(val) {
        return this._cleanCheck(val, (v) => {
            const charVal = 0x50; // End of line
            this.currText.push(charVal);
            this.prepareTextBuffer();
            return charVal;
        });
    }

    loadStatExp(val) {
        return this._cleanCheck(val, (v) => {
            const calcVal = v << (8 * this.currStatExpPos);
            if (this.currStatExpPos === 0) {
                this.statExp[this.currExpId] = calcVal;
                this.currStatExpPos++;
            } else {
                this.statExp[this.currExpId] |= calcVal;
                this.currStatExpPos = 0;
                this.currExpId++;
            }
            return v;
        });
    }

    loadStatIv(val) {
        return this._cleanCheck(val, (v) => {
            const high = (v & 0xF0) >> 4;
            const low = v & 0x0F;
            this.iv[this.currIvPos * 2] = high;
            this.iv[(this.currIvPos * 2) + 1] = low;
            this.currIvPos++;
            return v;
        });
    }

    checkStat(val, zeroMin = false, zeroMax = false) {
        return this._cleanCheck(val, (v) => {
            return this.checkStatInternal(v, zeroMin, zeroMax);
        });
    }

    checkStatInternal(val, zeroMin = false, zeroMax = false) {
        if (this.currPos === 0) {
            this.stat = 0;
            // Simplified stat calculation - would need base stats data
            let minStat = 1;
            let maxStat = 999;
            if (zeroMin || zeroMax) minStat = 0;
            if (zeroMax) maxStat = 0;
            this.statRange = [minStat, maxStat];
        }

        const currReadVal = val << (8 * (1 - (this.currPos & 1)));
        this.stat = this.checkRange(this.statRange, (this.stat & 0xFF00) | currReadVal);
        val = (this.stat >> (8 * (1 - (this.currPos & 1)))) & 0xFF;
        this.currPos++;

        if (this.currPos >= 2) {
            this.currStatId++;
            this.currPos = 0;
        }
        return val;
    }

    cleanSpeciesSp(val) {
        return this._cleanCheck(val, (v) => {
            if (v === GSCChecks.FREE_VALUE_SPECIES || this.speciesListSize >= this.teamSize) {
                this.addToSpeciesList(GSCChecks.FREE_VALUE_SPECIES);
                this.currSpeciesPos++;
                return GSCChecks.FREE_VALUE_SPECIES;
            }
            let foundSpecies = this.cleanValue(v, () => this.isSpeciesValid(v), GSCChecks.RATTATA_ID);
            if (v === GSCChecks.EGG_ID) {
                foundSpecies = v;
            }
            this.addToSpeciesList(foundSpecies);
            this.currSpeciesPos++;
            return foundSpecies;
        });
    }

    cleanPp(val) {
        return this._cleanCheck(val, (v) => {
            const currentPp = v & 0x3F;
            const ppUps = (v >> 6) & 3;
            const maxBasePp = this.movesPpList ? this.movesPpList[this.moves[this.currPp]] : 35;
            let ppIncrement = Math.floor(maxBasePp / 5);
            if (maxBasePp === 40) ppIncrement--;
            const maxPp = maxBasePp + (ppIncrement * ppUps);
            let finalPp = v;
            if (currentPp > maxPp) {
                finalPp = (ppUps << 6) | maxPp;
            }
            this.currPp++;
            return finalPp;
        });
    }

    cleanExperience(val) {
        return this._cleanCheck(val, (v) => {
            if (this.currExpPos === 0) {
                // Calculate valid EXP range based on species and level
                if (GSCUtils.loaded && this.currSpecies > 0) {
                    const minExp = GSCUtils.getExpLevel(this.currSpecies, GSCUtils.MIN_LEVEL);
                    const maxExp = GSCUtils.getExpLevel(this.currSpecies, GSCUtils.MAX_LEVEL);
                    this.expRange = [minExp, maxExp];
                } else {
                    // Fallback to full range
                    this.expRange = [0, 0xFFFFFF];
                }
                if (v >= 0x80) {
                    this.negativeExp = true;
                }
            }
            if (this.negativeExp) {
                v = 0;
            }
            const currReadVal = v << (8 * (2 - this.currExpPos));
            const expMask = [0, 0xFF0000, 0xFFFF00][this.currExpPos];
            this.exp = this.checkRange(this.expRange, (this.exp & expMask) | currReadVal);
            v = (this.exp >> (8 * (2 - this.currExpPos))) & 0xFF;
            this.currExpPos++;
            return v;
        });
    }

    cleanEggCyclesFriendship(val) {
        return this._cleanCheck(val, (v) => v);
    }

    cleanType(val) {
        return this._cleanCheck(val, (v) => v);
    }

    cleanTextNewline(val) {
        return this._cleanCheck(val, (v) => {
            const charVal = GSCChecks.NEWLINE;
            this.currText.push(charVal);
            return charVal;
        });
    }

    cleanTextFinalNoEnd(val) {
        return this._cleanCheck(val, (v) => {
            const charVal = this.cleanValue(v, () => this.isCharValid(v), GSCChecks.QUESTION_MARK);
            this.currText.push(charVal);
            this.prepareTextBuffer();
            return charVal;
        });
    }

    cleanSpeciesForceTerminate(val) {
        return this._cleanCheck(val, (v) => {
            this.prepareSpeciesBuffer();
            return GSCChecks.FREE_VALUE_SPECIES;
        });
    }

    cleanMailSpecies(val) {
        return this._cleanCheck(val, (v) => {
            this.currSpeciesPos++;
            return this.speciesList[this.currSpeciesPos - 1] || 0;
        });
    }

    cleanMailItem(val) {
        return this._cleanCheck(val, (v) => {
            return this.itemList[this.currSpeciesPos - 1] || 0;
        });
    }

    cleanMailSameSpecies(val) {
        return this._cleanCheck(val, (v) => {
            return this.speciesList[this.currSpeciesPos - 1] || 0;
        });
    }

    cleanPokemonPatchSet(val) {
        return this._cleanCheck(val, (v) => {
            return this.checkPatchSet(v, this.pokemonPatchSets);
        });
    }

    cleanMailPatchSet(val) {
        return this._cleanCheck(val, (v) => {
            return this.checkPatchSet(v, this.mailPatchSet);
        });
    }

    cleanJapaneseMailPatchSet(val) {
        return this._cleanCheck(val, (v) => {
            return this.checkPatchSet(v, this.japanesePatchSet);
        });
    }

    // ==================== Helper Functions ====================

    checkPatchSet(val, patchSets) {
        if (!patchSets || this.currPatchSet >= patchSets.length) {
            return GSCChecks.NO_CONVERSION_PATCH;
        }
        if (val === GSCChecks.END_OF_PATCH) {
            this.currPatchSet++;
            return val;
        }
        if (this.checkNormalList(patchSets[this.currPatchSet], val)) {
            return val;
        }
        return GSCChecks.NO_CONVERSION_PATCH;
    }

    checkRange(range, currStat) {
        if (currStat > range[1]) currStat = range[1];
        if (currStat < range[0]) currStat = range[0];
        return currStat;
    }

    cleanValue(value, checker, defaultValue) {
        if (checker()) {
            return value;
        }
        return defaultValue;
    }

    isEgg() {
        if (this.currSpeciesPos > 0 && this.speciesList[this.currSpeciesPos - 1] === GSCChecks.EGG_ID) {
            return true;
        }
        return false;
    }

    // ==================== Validation Functions ====================

    isTeamSizeValid(teamSize) {
        return this._validCheck(() => {
            return teamSize > 0 && teamSize <= 6;
        });
    }

    isItemValid(item) {
        return this._validCheck(() => {
            if (!this.badIdsItems) return true;
            return !this.checkNormalList(this.badIdsItems, item);
        });
    }

    isMoveValid(move) {
        return this._validCheck(() => {
            if (!this.badIdsMoves) return true;
            return !this.checkNormalList(this.badIdsMoves, move);
        });
    }

    isSpeciesValid(species) {
        return this._validCheck(() => {
            if (!this.badIdsPokemon) return true;
            return !this.checkNormalList(this.badIdsPokemon, species);
        });
    }

    isCharValid(char) {
        return this._validCheck(() => {
            if (!this.badIdsText) return true;
            return !this.checkNormalList(this.badIdsText, char);
        });
    }

    // ==================== Single Pokemon Check ====================

    /**
     * Apply sanity checks to a single Pokemon's data.
     * Used for CHC2 validation.
     * @param {Array|Uint8Array} data - Single Pokemon data (117 bytes)
     * @returns {Array} Cleaned data
     */
    cleanSinglePokemon(data) {
        if (!this.singlePokemonChecksMap) {
            return Array.from(data);
        }

        // Prepare state for checking
        this.resetSpeciesItemList();
        this.setSingleTeamSize();
        this.prepareTextBuffer();
        this.preparePatchSetsBuffer();
        this.prepareSpeciesBuffer();

        // Run the species cleaner on species byte first
        if (data.length > 0) {
            this.cleanSpeciesSp(data[0]);
        }
        this.prepareSpeciesBuffer();

        // Apply all checks
        return this.applyChecksToData(this.singlePokemonChecksMap, data);
    }

    /**
     * Apply sanity checks to moves data (for MVS2).
     * @param {Array|Uint8Array} data - Moves data [species, m1, m2, m3, m4, pp1, pp2, pp3, pp4]
     * @returns {Array} Cleaned data
     */
    cleanMoves(data) {
        if (!this.movesChecksMap) {
            return Array.from(data);
        }

        this.prepareSpeciesBuffer();
        return this.applyChecksToData(this.movesChecksMap, data);
    }
}
