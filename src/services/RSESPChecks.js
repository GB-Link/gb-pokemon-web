/**
 * RSESPChecks - Gen 3 checks. The Pokémon themselves are validated while
 * being decrypted (RSESPTradingPokemonInfo); this mainly carries the
 * language and the sanity checks switch.
 */
import { GSCChecks } from './GSCChecks.js?v=93';
import { RSESPUtils } from './RSESPUtils.js?v=93';

export class RSESPChecks extends GSCChecks {
    static BASE_FOLDER = '/data/rse/';
    static RATTATA_ID = 0xA5;
    static MAX_EVS = 0xFFFF;
    static MAX_IVS = 0xF;
    static REFERENCE_GEN = 3;

    static SECTION_LENGTHS = [0x380];
    static SECTION_LENGTHS_OLD = [0x380];

    static data = null;

    static getUtilsClass() {
        return RSESPUtils;
    }

    /**
     * new RSESPChecks(sectionSizes, doSanityChecks, { language, useStrictLanguageChecks })
     * new RSESPChecks(doSanityChecks)
     */
    constructor(sectionSizes = null, doSanityChecks = true, options = {}) {
        super(sectionSizes, doSanityChecks, { language: options.language, useStrictLanguageChecks: options.useStrictLanguageChecks });
    }

    cleanSpecies(species) {
        return this.sanity(species, () => {
            this.typePos = 0;
            const val = super.cleanSpecies(species);
            const C = this.constructor;
            this.iv = [C.MAX_IVS, C.MAX_IVS, C.MAX_IVS, C.MAX_IVS];
            this.statExp = [C.MAX_EVS, C.MAX_EVS, C.MAX_EVS, C.MAX_EVS, C.MAX_EVS];
            this.level = this.utilsClass.MAX_LEVEL;
            return val;
        });
    }

    isEgg(index) {
        return false;
    }

    cleanSpeciesSp(species) {
        return this.sanity(species, () => {
            const FREE = GSCChecks.FREE_VALUE_SPECIES;
            if (species === FREE || this.speciesListSize >= this.teamSize) {
                this.addToSpeciesList(FREE);
                this.currSpeciesPos += 1;
                return FREE;
            }
            const foundSpecies = this.cleanValue(species, (v) => this.isSpeciesValid(v), this.constructor.RATTATA_ID);
            this.addToSpeciesList(foundSpecies);
            this.currSpeciesPos += 1;
            return foundSpecies;
        });
    }

    cleanItem(item) {
        return this.sanity(item, () => item);
    }

    cleanType(typing) {
        return this.sanity(typing, () => {
            const ret = this.utilsClass.typesList[this.currSpecies][this.typePos];
            this.typePos += 1;
            return ret;
        });
    }
}
