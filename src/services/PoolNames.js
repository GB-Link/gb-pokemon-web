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
    static UNOWN_SPECIES = 201;
    static UNOWN_B_START = 415;

    static loaded = false;
    static gen3ToAscii = null;
    static moveNames = null;
    static itemNames = null;
    static dexConversion = null;
    static itemGen12To3 = null;
    static natureNames = null;
    static natureStats = null;
    static gen3JpChars = null;

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
        [this.itemGen12To3, this.natureNames, this.natureStats] = await Promise.all([
            fetchBin('item_gen12_to_3.bin'), fetchBin('nature_names.bin'),
            fetchBin('pokemon_natures.bin'),
        ]);
        this.buildGen3JapaneseTable();
        this.loaded = true;
        return true;
    }

    // Gen 3-encoded string -> ASCII
    static buildGen3JapaneseTable() {
        if (this.gen3JpChars) return;
        const table = new Array(256).fill('');
        const put = (start, chars) => [...chars].forEach((c, i) => { table[start + i] = c; });
        put(0x01, 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん');
        put(0x2F, 'ぁぃぅぇぉゃゅょ');
        put(0x37, 'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ');
        table[0x50] = 'っ';
        put(0x51, 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン');
        put(0x7F, 'ァィゥェォャュョ');
        put(0x87, 'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ');
        table[0xA0] = 'ッ';
        this.gen3JpChars = table;
    }

    static gen3Text(table, start, maxLen = Infinity, japanese = false) {
        let s = '';
        const end = Math.min(table.length, start + maxLen);
        for (let i = start; i < end; i++) {
            const c = table[i];
            if (c === this.GEN3_EOL) break;
            const kana = japanese ? this.gen3JpChars[c] : '';
            if (kana) {
                s += kana;
                continue;
            }
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

    static unownName(letter) {
        return this.speciesName(letter ? this.UNOWN_B_START + letter - 1 : this.UNOWN_SPECIES);
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

    // Order of pokemon_natures.bin's stat ids, which is not the order the
    // Gen 3 stat block itself uses (there Speed comes before the special stats)
    static NATURE_STAT_NAMES = ['HP', 'Attack', 'Defense', 'Sp. Attack', 'Sp. Defense', 'Speed'];

    /** Nature name for an index, i.e. Gen 3's PID modulo 25. */
    static natureName(index) {
        if (!this.loaded || index === null || index === undefined) return null;
        return this.asciiText(this.natureNames, DefaultNames.getTablePointer(this.natureNames, index)) || null;
    }

    /**
     * The stats a nature raises and lowers, as names. Null for the five
     * neutral natures, which raise and lower the same stat.
     */
    static natureStatEffect(index) {
        if (!this.loaded || index === null || index === undefined) return null;
        const pos = index * 2;
        if (pos + 1 >= this.natureStats.length) return null;
        const boosted = this.natureStats[pos];
        const nerfed = this.natureStats[pos + 1];
        if (boosted === nerfed) return null;
        return { boosted: this.NATURE_STAT_NAMES[boosted], nerfed: this.NATURE_STAT_NAMES[nerfed] };
    }

    /** Nature as shown in the pool, e.g. "Adamant (+Attack, -Sp. Attack)". */
    static natureDescription(index) {
        const name = this.natureName(index);
        if (!name) return null;
        const effect = this.natureStatEffect(index);
        return effect ? `${name} (+${effect.boosted}, \u2212${effect.nerfed})` : name;
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
