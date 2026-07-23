/**
 * RBYChecks - Data validation and sanitization for RBY (Gen 1) trading.
 * Extends GSCChecks with RBY-specific overrides, matching Python reference's RBYChecks.
 */
import { GSCChecks } from './GSCChecks.js?v=88';
import { RBYUtils } from './RBYUtils.js?v=88';

export class RBYChecks extends GSCChecks {
    // RBY-specific constants (different from GSC)
    static RATTATA_ID = 0xA5;  // Gen1 dex number for Rattata
    static MAX_EVS = 0xFFFF;
    static MAX_IVS = 0xF;

    // RBY section lengths (3 sections, no mail)
    static SECTION_LENGTHS = [0x0A, 0x1A2, 0xC5]; // [10, 418, 197]

    constructor(doSanityChecks = true) {
        super(doSanityChecks);
        this.typePos = 0;
        this.typesData = null;
    }

    /**
     * Load RBY-specific check data files.
     */
    async load() {
        if (this.loaded) return true;

        try {
            const basePath = '/data/rby/';

            // Load bad ID lists
            this.badIdsItems = new Array(256).fill(false); // RBY has no bad items
            this.badIdsMoves = await this.loadCheckList(basePath + 'bad_ids_moves.bin');
            this.badIdsPokemon = await this.loadCheckList(basePath + 'bad_ids_pokemon.bin');
            this.badIdsText = await this.loadCheckList(basePath + 'bad_ids_text.bin');

            // Load moves PP list
            this.movesPpList = await this.loadBinaryData(basePath + 'moves_pp_list.bin');
            if (!this.movesPpList) {
                this.movesPpList = new Uint8Array(256).fill(35);
            }

            // Load types data for RBY type cleaning
            this.typesData = await this.loadBinaryData(basePath + 'types.bin');

            // Load patch sets (RBY only has 2)
            const patchSet0 = await this.loadCheckList(basePath + 'pokemon_patch_set_0.bin');
            const patchSet1 = await this.loadCheckList(basePath + 'pokemon_patch_set_1.bin');
            this.pokemonPatchSets = [patchSet0, patchSet1];
            this.mailPatchSet = []; // No mail in RBY

            // Load check maps
            const checksMapRaw = await this.loadBinaryData(basePath + 'checks_map.bin');
            const singleMapRaw = await this.loadBinaryData(basePath + 'single_pokemon_checks_map.bin');
            const movesMapRaw = await this.loadBinaryData(basePath + 'moves_checks_map.bin');

            // Convert raw maps to function arrays
            this.checksMap = this.prepareChecksMap(checksMapRaw, RBYChecks.SECTION_LENGTHS);
            this.singlePokemonChecksMap = this.prepareFunctionsMap(singleMapRaw);
            this.movesChecksMap = this.prepareFunctionsMap(movesMapRaw);

            this.loaded = true;
            console.log('[RBYChecks] Loaded all RBY check data files');
            return true;
        } catch (e) {
            console.error('[RBYChecks] Error loading check data:', e);
            return false;
        }
    }

    /**
     * RBY has no eggs - always returns false.
     * This matches Python's RBYChecks.is_egg() implementation.
     */
    isEgg() {
        return false;
    }

    /**
     * Override cleanSpecies to use RBY-specific logic.
     * In Gen 1, HP comes before level/IVs, so we set max IVs/EVs initially.
     */
    cleanSpecies(val) {
        return this._cleanCheck(val, (v) => {
            this.typePos = 0;
            const cleanedSpecies = this.cleanValue(v, () => this.isSpeciesValid(v), RBYChecks.RATTATA_ID);
            this.currSpecies = cleanedSpecies;
            this.currSpeciesPos++;
            this.currStatId = 0;

            // In Gen 1, you get current HP before level and IVs/EVs,
            // so the best we can do is set maximum possible values
            this.iv = [RBYChecks.MAX_IVS, RBYChecks.MAX_IVS, RBYChecks.MAX_IVS, RBYChecks.MAX_IVS];
            this.statExp = [RBYChecks.MAX_EVS, RBYChecks.MAX_EVS, RBYChecks.MAX_EVS, RBYChecks.MAX_EVS, RBYChecks.MAX_EVS];
            this.level = RBYUtils.MAX_LEVEL || 100;

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

            return cleanedSpecies;
        });
    }

    /**
     * Override cleanSpeciesSp for RBY.
     * No egg ID check since RBY has no eggs.
     */
    cleanSpeciesSp(val) {
        return this._cleanCheck(val, (v) => {
            if (v === GSCChecks.FREE_VALUE_SPECIES || this.speciesListSize >= this.teamSize) {
                this.addToSpeciesList(GSCChecks.FREE_VALUE_SPECIES);
                this.currSpeciesPos++;
                return GSCChecks.FREE_VALUE_SPECIES;
            }
            const foundSpecies = this.cleanValue(v, () => this.isSpeciesValid(v), RBYChecks.RATTATA_ID);
            // No egg check for RBY - eggs don't exist
            this.addToSpeciesList(foundSpecies);
            this.currSpeciesPos++;
            return foundSpecies;
        });
    }

    /**
     * Override cleanItem - RBY doesn't validate items the same way.
     */
    cleanItem(val) {
        return this._cleanCheck(val, (v) => {
            // RBY has no item validation - all items pass
            this.itemList.push(v);
            return v;
        });
    }

    /**
     * Override cleanType to use RBY types data.
     * Returns the correct type for the current species from types.bin.
     */
    cleanType(val) {
        return this._cleanCheck(val, (v) => {
            if (this.typesData && this.currSpecies < 256) {
                // types.bin has 2 bytes per species (type1, type2)
                const typeOffset = (this.currSpecies * 2) + this.typePos;
                if (typeOffset < this.typesData.length) {
                    const ret = this.typesData[typeOffset];
                    this.typePos++;
                    return ret;
                }
            }
            this.typePos++;
            return v;
        });
    }

    /**
     * Mail-related functions - no-ops for RBY.
     */
    cleanMailSpecies(val) {
        return val;
    }

    cleanMailItem(val) {
        return val;
    }

    cleanMailSameSpecies(val) {
        return val;
    }

    cleanMailPatchSet(val) {
        return val;
    }

    cleanJapaneseMailPatchSet(val) {
        return val;
    }
}
