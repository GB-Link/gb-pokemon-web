/**
 * DefaultNames.js - Default Gen 1/2 Pokemon names per language.
 * Derived the way Pokemon-Gen3-to-Gen-X does it:
 * the species' Gen 3 name for the target language, converted through the
 * Gen 3 -> Gen 1/2 charset table and capped to the Gen 1/2 name length.
 * Uses that project's packed name tables verbatim (data/names/).
 */

export class DefaultNames {
    static BASE_FOLDER = '/data/names/';

    static GEN3_EOL = 0xFF;
    static GEN2_EOL = 0x50;
    static NUM_LANGUAGES = 8;
    static NUM_POKEMON_NAME_LANGUAGES = 4;
    static JAPANESE_LANGUAGE = 1;
    static ENGLISH_LANGUAGE = 2;
    static LAST_VALID_GEN_1_MON = 151;
    static LAST_VALID_GEN_2_MON = 251;
    static EGG_SPECIES = 412;
    static MR_MIME_SPECIES = 122;
    static MR_MIME_OLD_NAME_POS = 446;
    static UNOWN_SPECIES = 201;
    static UNOWN_REAL_NAME_POS = 445;
    static STRING_GEN2_INT_SIZE = 11;
    static STRING_GEN2_JP_SIZE = 6;

    static loaded = false;
    static pokemonNames = null;
    static eggNames = null;
    static languageNamesIndex = null;
    static textGen3ToGen12Int = null;
    static textGen3ToGen12Jp = null;
    static gen1To3ConvTable = null;
    static trainerNames = null;

    static async load() {
        if (this.loaded) return true;
        const fetchBin = async (name) => {
            const response = await fetch(this.BASE_FOLDER + name);
            if (!response.ok) throw new Error(`${name}: ${response.status}`);
            return new Uint8Array(await response.arrayBuffer());
        };
        try {
            [this.pokemonNames, this.eggNames, this.languageNamesIndex,
                this.textGen3ToGen12Int, this.textGen3ToGen12Jp, this.gen1To3ConvTable] = await Promise.all([
                fetchBin('pokemon_names.bin'), fetchBin('egg_names.bin'), fetchBin('language_names_index.bin'),
                fetchBin('text_gen3_to_gen12_int.bin'), fetchBin('text_gen3_to_gen12_jp.bin'),
                fetchBin('gen1_to_3_conv_table.bin'),
            ]);
            this.trainerNames = await fetchBin('trainer_names.bin');
            this.loaded = true;
            return true;
        } catch (e) {
            console.warn('[DefaultNames] Could not load name tables:', e);
            return false;
        }
    }

    /**
     * Packed table lookup: returns the byte offset of an entry's string.
     */
    static getTablePointer(table, entry) {
        const sizeInitialOffset = (table[0] & 1) + 1;
        const sizeOffsets = ((table[0] >> 1) & 1) + 1;
        const offsetShifter = (table[0] >> 2) & 7;
        const offsetShifterInitialOffset = table[0] >> 5;
        let initialOffset;
        let offsetTablePos = 2;
        if (sizeInitialOffset === 1) {
            initialOffset = table[1] << offsetShifterInitialOffset;
        } else {
            initialOffset = (table[2] | (table[3] << 8)) << offsetShifterInitialOffset;
            offsetTablePos = 4;
        }
        let entries = initialOffset - offsetTablePos;
        if (sizeOffsets === 2) entries >>= 1;
        if (entry >= entries) entry = 0;
        let offset;
        if (sizeOffsets === 1) {
            offset = table[offsetTablePos + entry] << offsetShifter;
        } else {
            const pos = offsetTablePos + entry * 2;
            offset = (table[pos] | (table[pos + 1] << 8)) << offsetShifter;
        }
        return initialOffset + offset;
    }

    static getValidLanguage(language) {
        return language >= this.NUM_LANGUAGES ? this.ENGLISH_LANGUAGE : language;
    }

    // Gen 3-encoded name (0xFF terminated) as a view into the packed table
    static getPokemonNameLanguage(index, language) {
        language = this.getValidLanguage(language);
        if (index === this.EGG_SPECIES) {
            return this.eggNames.subarray(this.getTablePointer(this.eggNames, language));
        }
        const entry = index * this.NUM_POKEMON_NAME_LANGUAGES + this.languageNamesIndex[language];
        return this.pokemonNames.subarray(this.getTablePointer(this.pokemonNames, entry));
    }

    static getMonIndexGen2(index, isEgg) {
        if (index > this.LAST_VALID_GEN_2_MON) return 0;
        if (isEgg) return this.EGG_SPECIES;
        return index;
    }

    // "MR.MIME" gen 1/2 == "MR. MIME" gen 3; Unown uses its real name entry
    static getPokemonNameGen2Gen3Enc(index, isEgg, language) {
        let monIndex = this.getMonIndexGen2(index, isEgg);
        if (monIndex === this.MR_MIME_SPECIES) monIndex = this.MR_MIME_OLD_NAME_POS;
        if (monIndex === this.UNOWN_SPECIES) monIndex = this.UNOWN_REAL_NAME_POS;
        return this.getPokemonNameLanguage(monIndex, language);
    }

    // Charset conversion, stopping at the terminator
    static textGen3ToGen12(src, dst, srcSize, dstSize, isJp) {
        const table = isJp ? this.textGen3ToGen12Jp : this.textGen3ToGen12Int;
        for (let i = 0; i < srcSize && i < dstSize; i++) {
            if (src[i] === this.GEN3_EOL) {
                dst[i] = this.GEN2_EOL;
                break;
            }
            dst[i] = table[src[i]];
        }
        if (srcSize < dstSize) dst[srcSize] = this.GEN2_EOL;
    }

    /**
     * The 11-byte Gen 1/2 trainer-name field a game of the given language
     * uses by default ("TRAINER" in English).
     */
    static getDefaultTrainerNameField(isJapanese) {
        const field = new Uint8Array(this.STRING_GEN2_INT_SIZE).fill(this.GEN2_EOL);
        if (!this.loaded || !this.trainerNames) return field;
        const language = isJapanese ? this.JAPANESE_LANGUAGE : this.ENGLISH_LANGUAGE;
        const src = this.trainerNames.subarray(this.getTablePointer(this.trainerNames, this.getValidLanguage(language)));
        const cap = (isJapanese ? this.STRING_GEN2_JP_SIZE : this.STRING_GEN2_INT_SIZE) - 1;
        this.textGen3ToGen12(src, field, cap, cap, isJapanese);
        return field;
    }

    /**
     * The 11-byte Gen 1/2 nickname field (name + 0x50 fill) a game of the
     * given language uses for a species. gen 1 species are internal ids.
     */
    static getDefaultNameField(gen, speciesId, isEgg, isJapanese) {
        const field = new Uint8Array(this.STRING_GEN2_INT_SIZE).fill(this.GEN2_EOL);
        if (!this.loaded) return field;
        let index = speciesId;
        if (gen === 1) {
            index = this.gen1To3ConvTable[speciesId & 0xFF];
            if (index > this.LAST_VALID_GEN_1_MON) index = 0;
        }
        const language = isJapanese ? this.JAPANESE_LANGUAGE : this.ENGLISH_LANGUAGE;
        const src = this.getPokemonNameGen2Gen3Enc(index, isEgg, language);
        const cap = (isJapanese ? this.STRING_GEN2_JP_SIZE : this.STRING_GEN2_INT_SIZE) - 1;
        this.textGen3ToGen12(src, field, cap, cap, isJapanese);
        return field;
    }
}
