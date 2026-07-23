
import { RSESPUtils } from './RSESPUtils.js?v=88';

export class RSESPChecks {
    constructor(doSanityChecks = true) {
        this.doSanityChecks = doSanityChecks;
        this.sectionSizes = [0x380];
    }

    resetSpeciesItemList() {
        // Reset any tracking state between trades
    }

    cleanSpecies(species) {
        if (!this.doSanityChecks) return species;
        if (!RSESPUtils.isSpeciesValid(species)) {
            return 0;
        }
        return species;
    }

    isEgg(mon) {
        if (mon && mon.misc) {
            return (mon.misc[7] & 0x40) !== 0;
        }
        return false;
    }
}
