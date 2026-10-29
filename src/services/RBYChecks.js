/**
 * RBYChecks - Sanity checks and cleaning of received Gen 1 trading data.
 */
import { GSCChecks } from './GSCChecks.js?v=98';
import { RBYUtils } from './RBYUtils.js?v=98';

export class RBYChecks extends GSCChecks {
    static BASE_FOLDER = '/data/rby/';
    // Held items and mail are Gen 2 only
    static ABSENT_FILES = new Set(['bad_ids_items.bin', 'japanese_mail_patch_set.bin', 'mail_patch_set.bin', 'mail_patch_set_old.bin']);
    static RATTATA_ID = 0xA5;
    static MAX_EVS = 0xFFFF;
    static MAX_IVS = 0xF;
    static REFERENCE_GEN = 1;

    // Random, party, patches
    static SECTION_LENGTHS = [0x0A, 0x1A2, 0xC5];
    static SECTION_LENGTHS_OLD = [0x0A, 0x1A2, 0xC5];

    static data = null;

    static getUtilsClass() {
        return RBYUtils;
    }

    /**
     * new RBYChecks(sectionSizes, doSanityChecks, { language, setDefaultNickname,
     *     setDefaultOt, setDefaultPartner, doProfanityChecks, useStrictLanguageChecks })
     */
    constructor(sectionSizes = null, doSanityChecks = true, options = {}) {
        const { sectionSizesOld, useStrictLanguageChecksMail, ...rest } = options;
        super(sectionSizes, doSanityChecks, rest);
    }

    cleanSpecies(species) {
        return this.sanity(species, () => {
            this.typePos = 0;
            const val = super.cleanSpecies(species);
            // Gen 1 sends the current HP before the level, IVs and stat
            // experience, so only the highest possible values can bound it
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

    getSpeciesIsEgg(species) {
        return false;
    }

    cleanItem(item) {
        return this.sanity(item, () => item);
    }

    cleanType(typing) {
        return this.sanity(typing, () => {
            const types = this.utilsClass.typesList[this.currSpecies];
            if (this.typePos >= types.length) throw new RangeError('list index out of range');
            const ret = types[this.typePos];
            this.typePos += 1;
            return ret;
        });
    }
}
