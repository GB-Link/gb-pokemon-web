/**
 * PoolNames.js - Species, move and item names plus dex conversions, for
 * displaying pool contents.
 *
 * Species names come from Pokemon-Gen3-to-Gen-X's packed table (Gen 3 text
 * encoding); move and item names from its plain ASCII tables. Game text is
 * decoded per language with PokemonGB_Online_Trades' alphabet tables: Gen 1/2
 * bytes go through the Gen 3 charset, except Korean, which has its own
 * two-byte table. The dex tables convert a game's own species index to the
 * national number the sprite CDN uses.
 */

import { DefaultNames } from './DefaultNames.js?v=102';

export class PoolNames {
    static BASE_FOLDER = '/data/names/';
    static JAPANESE_LANGUAGE = 1;
    static ENGLISH_LANGUAGE = 2;
    static KOREAN_LANGUAGE = 6;
    static LANGUAGES = {
        1: { name: 'Japanese', short: 'JPN' }, 2: { name: 'English', short: 'ENG' },
        3: { name: 'French', short: 'FRE' }, 4: { name: 'Italian', short: 'ITA' },
        5: { name: 'German', short: 'GER' }, 6: { name: 'Korean', short: 'KOR' },
        7: { name: 'Spanish', short: 'SPA' },
    };
    static NUM_POKEMON_NAME_LANGUAGES = 4;
    static GEN3_EOL = 0xFF;
    static GEN2_EOL = 0x50;
    static GEN2_NEWLINE = 0x4E;
    static GEN2_NEWLINE_KOREAN = 0x59;
    static EGG_SPECIES = 412;
    static MR_MIME_SPECIES = 122;
    static UNOWN_SPECIES = 201;
    static UNOWN_B_START = 415;
    static UNOWN_FORMS_GEN3 = 28;
    static UNOWN_REAL_NAME_POS = 445;
    static MR_MIME_OLD_NAME_POS = 446;
    static LAST_GEN2_SPECIES = 251;
    static KOREAN_NAME_SIZE = 10;

    static loaded = false;
    static moveNames = null;
    static itemNames = null;
    static dexConversion = null;
    static itemGen12To3 = null;
    static natureNames = null;
    static natureStats = null;
    static gen3AlphabetInt = null;
    static gen3AlphabetJp = null;
    static gen2AlphabetKor = null;
    static gen12ToGen3Int = null;
    static gen12ToGen3Jp = null;
    static koreanNames = null;
    static koreanEggName = null;

    static async load() {
        if (this.loaded) return true;
        const fetchFile = async (name) => {
            const r = await fetch(this.BASE_FOLDER + name);
            if (!r.ok) throw new Error(`${name}: ${r.status}`);
            return r;
        };
        const fetchBin = async (name) => new Uint8Array(await (await fetchFile(name)).arrayBuffer());
        const fetchAlphabet = async (name) => this.parseAlphabet(await (await fetchFile(name)).text());
        await DefaultNames.load();
        [this.moveNames, this.itemNames, this.dexConversion, this.itemGen12To3, this.natureNames, this.natureStats] = await Promise.all([
            fetchBin('move_names.bin'), fetchBin('item_names.bin'), fetchBin('dex_conversion.bin'),
            fetchBin('item_gen12_to_3.bin'), fetchBin('nature_names.bin'), fetchBin('pokemon_natures.bin'),
        ]);
        [this.gen3AlphabetInt, this.gen3AlphabetJp, this.gen2AlphabetKor] = await Promise.all([
            fetchAlphabet('text_gen3_to_general_int.txt'), fetchAlphabet('text_gen3_to_general_jp.txt'),
            fetchAlphabet('text_gen2_to_general_kor.txt'),
        ]);
        [this.gen12ToGen3Int, this.gen12ToGen3Jp, this.koreanNames, this.koreanEggName] = await Promise.all([
            fetchBin('text_gen12_to_gen3_int.bin'), fetchBin('text_gen12_to_gen3_jp.bin'),
            fetchBin('pokemon_names_kr_gen2.bin'), fetchBin('egg_name_kr_gen2.bin'),
        ]);
        this.loaded = true;
        return true;
    }

    /**
     * An alphabet file is 16 rows of 16 '#'-terminated characters, one per
     * byte. <TABLE> marks a lead byte whose next byte indexes "# TABLE n".
     */
    static parseAlphabet(text) {
        const lines = text.split(/\r?\n/);
        const readTable = (header) => {
            let i = 0;
            if (header) {
                i = lines.findIndex(line => line.trim() === header);
                if (i < 0) return new Array(256).fill('?');
                i++;
            }
            while (i < lines.length && (lines[i].startsWith('#') || !lines[i].trim())) i++;
            const out = [];
            for (let row = 0; row < 16; row++) out.push(...(lines[i + row] || '').split('#').slice(0, 16));
            return out;
        };
        return readTable(null).map((token, i) => token === '<TABLE>'
            ? readTable(`# TABLE ${i}`).map(t => this.displayChar(t))
            : this.displayChar(token));
    }

    // "<?>" is a literal question mark, "<PK>" a glyph, "<『/“>" a Japanese/other pair
    static displayChar(token) {
        if (token === '<?>') return '?';
        if (token.length > 2 && token.startsWith('<') && token.endsWith('>')) {
            return token.slice(1, -1).split('/').pop();
        }
        return token;
    }

    static gen3Text(table, start, maxLen = Infinity, japanese = false) {
        const alphabet = japanese ? this.gen3AlphabetJp : this.gen3AlphabetInt;
        let s = '';
        const end = Math.min(table.length, start + maxLen);
        for (let i = start; i < end; i++) {
            if (table[i] === this.GEN3_EOL) break;
            s += alphabet[table[i]];
        }
        return s;
    }

    /** Gen 1/2 text (0x50 terminated) as the game of that language shows it. */
    static gen12Text(bytes, language) {
        let s = '';
        for (let i = 0; i < bytes.length && bytes[i] !== this.GEN2_EOL; i++) {
            if (bytes[i] === this.GEN2_NEWLINE || (language === this.KOREAN_LANGUAGE && bytes[i] === this.GEN2_NEWLINE_KOREAN)) {
                s += '\n';
                continue;
            }
            if (language === this.KOREAN_LANGUAGE) {
                const entry = this.gen2AlphabetKor[bytes[i]];
                if (Array.isArray(entry)) {
                    i++;
                    s += entry[i < bytes.length ? bytes[i] : this.GEN2_EOL];
                } else {
                    s += entry;
                }
                continue;
            }
            const japanese = language === this.JAPANESE_LANGUAGE;
            const toGen3 = japanese ? this.gen12ToGen3Jp : this.gen12ToGen3Int;
            s += (japanese ? this.gen3AlphabetJp : this.gen3AlphabetInt)[toGen3[bytes[i]]];
        }
        return s.trim();
    }

    static languageInfo(language) {
        const info = this.LANGUAGES[language];
        return info ? { id: language, ...info } : null;
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

    /**
     * Name for a species by its entry in the shared name table, in a game
     * language. maxLen caps it the way a Gen 1/2 name field would.
     */
    static speciesName(tableIndex, language = this.ENGLISH_LANGUAGE, maxLen = Infinity) {
        if (!this.loaded) return '?';
        if (language === this.KOREAN_LANGUAGE) return this.koreanSpeciesName(tableIndex);
        const japanese = language === this.JAPANESE_LANGUAGE;
        if (tableIndex === this.EGG_SPECIES) {
            return this.gen3Text(DefaultNames.eggNames, DefaultNames.getTablePointer(DefaultNames.eggNames, language), maxLen, japanese);
        }
        const entry = tableIndex * this.NUM_POKEMON_NAME_LANGUAGES + DefaultNames.languageNamesIndex[language];
        return this.gen3Text(DefaultNames.pokemonNames, DefaultNames.getTablePointer(DefaultNames.pokemonNames, entry), maxLen, japanese);
    }

    // Korean names exist only for the Gen 2 species
    static koreanSpeciesName(tableIndex) {
        if (tableIndex === this.EGG_SPECIES) return this.gen12Text(this.koreanEggName, this.KOREAN_LANGUAGE);
        let species = tableIndex;
        if (tableIndex === this.MR_MIME_OLD_NAME_POS) species = this.MR_MIME_SPECIES;
        else if (tableIndex === this.UNOWN_REAL_NAME_POS
            || (tableIndex >= this.UNOWN_B_START && tableIndex < this.UNOWN_B_START + this.UNOWN_FORMS_GEN3 - 1)) species = this.UNOWN_SPECIES;
        if (species < 1 || species > this.LAST_GEN2_SPECIES) return null;
        const start = species * this.KOREAN_NAME_SIZE;
        return this.gen12Text(this.koreanNames.subarray(start, start + this.KOREAN_NAME_SIZE), this.KOREAN_LANGUAGE);
    }

    /**
     * The name a Gen 1/2 game of that language gives the species, i.e. what
     * an un-nicknamed Pokemon carries. Takes the name-table entry.
     */
    static defaultGen12Name(tableIndex, language) {
        return this.speciesName(tableIndex, language, language === this.JAPANESE_LANGUAGE ? 5 : 10);
    }

    static unownIndex(letter) {
        return letter ? this.UNOWN_B_START + letter - 1 : this.UNOWN_SPECIES;
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
