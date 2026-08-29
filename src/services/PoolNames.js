/**
 * PoolNames.js - Species, move and item names plus dex conversions, for
 * displaying pool contents.
 *
 * Species names come from Pokemon-Gen3-to-Gen-X's packed table (Gen 3 text
 * encoding, converted to ASCII here); move and item names from its plain
 * ASCII tables. The dex tables convert a game's own species index to the
 * national number the sprite CDN uses.
 */

import { DefaultNames } from './DefaultNames.js?v=91';

export class PoolNames {
    static BASE_FOLDER = '/data/names/';
    static ENGLISH_LANGUAGE = 2;
    static NUM_POKEMON_NAME_LANGUAGES = 4;
    static GEN3_EOL = 0xFF;
    static EGG_SPECIES = 412;

    static loaded = false;
    static gen3ToAscii = null;
    static moveNames = null;
    static itemNames = null;
    static dexConversion = null;
    static itemGen12To3 = null;

    static async load() {
        if (this.loaded) return true;
        const fetchBin = async (name) => {
            const r = await fetch(this.BASE_FOLDER + name);
            if (!r.ok) throw new Error(`${name}: ${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
        };
        await DefaultNames.load();
        [this.gen3ToAscii, this.moveNames, this.itemNames, this.dexConversion] = await Promise.all([
            fetchBin('text_gen3_to_general_int.bin'), fetchBin('move_names.bin'),
            fetchBin('item_names.bin'), fetchBin('dex_conversion.bin'),
        ]);
        this.itemGen12To3 = await fetchBin('item_gen12_to_3.bin');
        this.loaded = true;
        return true;
    }

    // Gen 3-encoded string -> ASCII
    static gen3Text(table, start, maxLen = Infinity) {
        let s = '';
        const end = Math.min(table.length, start + maxLen);
        for (let i = start; i < end; i++) {
            const c = table[i];
            if (c === this.GEN3_EOL) break;
            const ascii = this.gen3ToAscii[c];
            if (!ascii) break;
            s += String.fromCharCode(ascii);
        }
        return s;
    }

    // NUL-terminated ASCII string
    static asciiText(table, start) {
        let s = '';
        for (let i = start; i < table.length; i++) {
            if (!table[i]) break;
            s += String.fromCharCode(table[i]);
        }
        return s;
    }

    /** Name for a species by its entry in the shared name table. */
    static speciesName(tableIndex) {
        if (!this.loaded) return '?';
        if (tableIndex === this.EGG_SPECIES) {
            return this.gen3Text(DefaultNames.eggNames, DefaultNames.getTablePointer(DefaultNames.eggNames, this.ENGLISH_LANGUAGE));
        }
        const entry = tableIndex * this.NUM_POKEMON_NAME_LANGUAGES + DefaultNames.languageNamesIndex[this.ENGLISH_LANGUAGE];
        return this.gen3Text(DefaultNames.pokemonNames, DefaultNames.getTablePointer(DefaultNames.pokemonNames, entry));
    }

    static moveName(id) {
        if (!this.loaded || !id) return null;
        return this.asciiText(this.moveNames, DefaultNames.getTablePointer(this.moveNames, id)) || null;
    }

    static itemName(id) {
        if (!this.loaded || !id) return null;
        // An id past the table clamps to entry 0 ("Nothing"), which means the
        // item has no name here rather than being called Nothing
        const name = this.asciiText(this.itemNames, DefaultNames.getTablePointer(this.itemNames, id));
        return (!name || name === 'Nothing') ? null : name;
    }

    /**
     * Gen 1/2 item ids differ from Gen 3's, so they are mapped before the
     * name lookup. Items with no Gen 3 equivalent return null.
     */
    static itemNameForGen(gen, id) {
        if (!this.loaded || !id) return null;
        if (gen === 3) return this.itemName(id);
        const pos = id * 2;
        if (pos + 1 >= this.itemGen12To3.length) return null;
        const mapped = this.itemGen12To3[pos] | (this.itemGen12To3[pos + 1] << 8);
        return (mapped === 0xFFFF || !mapped) ? null : this.itemName(mapped);
    }

    /** Gen 1 stores internal species ids; everything else wants the dex number. */
    static gen1ToNational(internalId) {
        if (!this.loaded) return 0;
        return DefaultNames.gen1To3ConvTable[internalId & 0xFF] || 0;
    }

    /** Gen 3 species index -> national dex number (0 when the index is unused). */
    static gen3ToNational(species) {
        if (!this.loaded) return 0;
        const pos = species * 2;
        if (pos + 1 >= this.dexConversion.length) return 0;
        const v = this.dexConversion[pos] | (this.dexConversion[pos + 1] << 8);
        return v === 0xFFFF ? 0 : v + 1;
    }
}
