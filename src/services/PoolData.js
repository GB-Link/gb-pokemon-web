/**
 * PoolData.js - Fetch and decode the server's pool dumps.
 *
 * The server serves /pooldata{1,2,3} as a 20-byte header (magic, format
 * version, gen, entry size, count) followed by fixed-size records, each one
 * the same single-Pokemon payload a pool trade sends. From format version 2,
 * Gen 1/2 records also end in a 4-byte mask of the game languages their names
 * are valid in, which decides how the names are read. Every generation is
 * normalized here into one shape for display.
 */

import { PoolNames } from './PoolNames.js?v=103';
import { GSCUtils } from './GSCUtils.js?v=103';
import { RSESPUtils, RSESPTradingPokemonInfo } from './RSESPUtils.js?v=103';
import { RSESPChecks } from './RSESPChecks.js?v=103';

export class PoolData {
    static MAGIC = 0x35678292;
    static SUPPORTED_VERSIONS = new Set([1, 2]);
    static LANGUAGE_MASK_LEN = 4;
    static GEN2_EGG_VALUE = 0x38;
    // Gen 2 mail items have no Gen 3 equivalent to take a name from
    static GEN2_MAIL_ITEMS = new Set([0x9E, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD]);
    static LANGUAGE_ORDER = [1, 2, 3, 4, 5, 6, 7];

    /**
     * Picks the language a Gen 1/2 Pokemon's names are read in from the
     * server's mask: one whose default species name the nickname still is,
     * else English when listed, else the first listed - the server's own
     * choice. Null without a mask (older servers).
     */
    static gen12Language(mask, nickname, nameIndex) {
        if (mask === undefined) return null;
        const listed = this.LANGUAGE_ORDER.filter(language => mask & (1 << language));
        if (!listed.length) return null;
        const prefer = (languages) => languages.includes(PoolNames.ENGLISH_LANGUAGE) ? PoolNames.ENGLISH_LANGUAGE : languages[0];
        const unnamed = listed.filter(language =>
            PoolNames.gen12Text(nickname, language) === PoolNames.defaultGen12Name(nameIndex, language));
        return prefer(unnamed.length ? unnamed : listed);
    }

    /** The species name in the Pokemon's own language, when that differs. */
    static localSpeciesName(tableIndex, language, englishName) {
        if (!language || language === PoolNames.ENGLISH_LANGUAGE) return null;
        const name = PoolNames.speciesName(tableIndex, language);
        return name && name !== englishName ? name : null;
    }

    /**
     * Load one generation's pool. baseUrl is the server's http(s) origin.
     */
    static async fetch(baseUrl, gen) {
        await PoolNames.load();
        if (gen === 3) {
            await RSESPUtils.load();
            this.rseChecks = this.rseChecks || new RSESPChecks();
        }
        const r = await fetch(`${baseUrl.replace(/\/$/, '')}/pooldata${gen}`);
        if (!r.ok) throw new Error(`server returned ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        return this.parse(bytes, gen);
    }

    static parse(bytes, expectedGen) {
        if (bytes.length < 20) throw new Error('pool data too short');
        const dv = new DataView(bytes.buffer, bytes.byteOffset);
        const magic = dv.getUint32(0, true);
        if (magic !== this.MAGIC) throw new Error(`unexpected pool format (magic 0x${magic.toString(16)})`);
        const version = dv.getUint32(4, true);
        if (!this.SUPPORTED_VERSIONS.has(version)) throw new Error(`unsupported pool format version ${version}`);
        const gen = dv.getUint32(8, true) + 1;
        const entrySize = dv.getUint32(12, true);
        const count = dv.getUint32(16, true);
        if (!entrySize || 20 + entrySize * count > bytes.length) throw new Error('pool data truncated');
        const hasLanguageMask = version >= 2 && gen < 3;
        const monSize = entrySize - (hasLanguageMask ? this.LANGUAGE_MASK_LEN : 0);

        const decode = {
            1: (e, i, mask) => this.decodeGen1(e, i, mask),
            2: (e, i, mask) => this.decodeGen2(e, i, mask),
            3: (e, i) => this.decodeGen3(e, i),
        }[gen];
        if (!decode) throw new Error(`unsupported generation ${gen}`);

        const mons = [];
        for (let i = 0; i < count; i++) {
            const start = 20 + i * entrySize;
            const entry = bytes.subarray(start, start + monSize);
            const mask = hasLanguageMask ? dv.getUint32(start + monSize, true) : undefined;
            try {
                const mon = decode(entry, i, mask);
                if (mon) mons.push(mon);
            } catch (_) { /* skip an entry we cannot read rather than losing the pool */ }
        }
        return { gen, entrySize, count, mons, bytes: bytes.length, expectedGen };
    }

    /**
     * Gen 3 shininess: the trainer and personality halves must xor below 8.
     * PID and OT ID are the first two words of the record.
     */
    static shinyGen3(entry) {
        const dv = new DataView(entry.buffer, entry.byteOffset);
        const pid = dv.getUint32(0, true), otId = dv.getUint32(4, true);
        return (((pid & 0xFFFF) ^ (pid >>> 16) ^ (otId & 0xFFFF) ^ (otId >>> 16)) >>> 0) < 8;
    }

    /**
     * Gen 1 has no shininess of its own, but its DVs decide whether the same
     * Pokemon shows as shiny once it is traded up to Gen 2, so it is worth
     * reporting here.
     */
    static shinyGen2(ivs) {
        const atk = (ivs >> 12) & 0xF, def = (ivs >> 8) & 0xF, spd = (ivs >> 4) & 0xF, spc = ivs & 0xF;
        return def === 10 && spd === 10 && spc === 10 && [2, 3, 6, 7, 10, 11, 14, 15].includes(atk);
    }

    static ivList(ivs, gen) {
        const atk = (ivs >> 12) & 0xF, def = (ivs >> 8) & 0xF, spd = (ivs >> 4) & 0xF, spc = ivs & 0xF;
        // HP's DV is built from the low bit of the other four
        const hp = ((atk & 1) << 3) | ((def & 1) << 2) | ((spd & 1) << 1) | (spc & 1);
        return gen === 1
            ? [['HP', hp], ['Attack', atk], ['Defense', def], ['Speed', spd], ['Special', spc]]
            : [['HP', hp], ['Attack', atk], ['Defense', def], ['Speed', spd], ['Sp. Atk/Def', spc]];
    }

    /**
     * Gen 2 hides Unown's form in the DVs: two bits from each of Attack,
     * Defense, Speed and Special, read as one byte and divided by 10.
     */
    static unownLetterGen2(ivs) {
        const atk = (ivs >> 12) & 0xF, def = (ivs >> 8) & 0xF, spd = (ivs >> 4) & 0xF, spc = ivs & 0xF;
        const packed = (((atk >> 1) & 3) << 6) | (((def >> 1) & 3) << 4)
            | (((spd >> 1) & 3) << 2) | ((spc >> 1) & 3);
        return Math.floor(packed / 10);
    }

    static decodeGen1(e, slot, mask) {
        const internal = e[0];
        const national = PoolNames.gen1ToNational(internal);
        const ivs = (e[27] << 8) | e[28];
        const stats = ['HP', 'Attack', 'Defense', 'Speed', 'Special'].map((n, i) => [n, (e[34 + i * 2] << 8) | e[35 + i * 2]]);
        const nickname = e.subarray(55, 66);
        const nameIndex = this.gen12NameIndex(national, false);
        const language = this.gen12Language(mask, nickname, nameIndex);
        const textLanguage = language ?? PoolNames.ENGLISH_LANGUAGE;
        const speciesName = PoolNames.speciesName(national);
        return {
            slot, gen: 1, national, speciesName,
            localSpeciesName: this.localSpeciesName(nameIndex, language, speciesName),
            language: PoolNames.languageInfo(language),
            otName: PoolNames.gen12Text(e.subarray(44, 55), textLanguage),
            nickname: PoolNames.gen12Text(nickname, textLanguage),
            otId: (e[12] << 8) | e[13],
            level: e[33],
            currHp: (e[1] << 8) | e[2],
            stats,
            moves: [0, 1, 2, 3].map(i => ({ id: e[8 + i], name: PoolNames.moveName(e[8 + i]), pp: e[29 + i] & 0x3F })).filter(m => m.id),
            ivs: this.ivList(ivs, 1),
            exp: (e[14] << 16) | (e[15] << 8) | e[16],
            item: null, isEgg: false,
            isShiny: this.shinyGen2(ivs),
        };
    }

    // The name-table entry a Gen 1/2 game names the species after
    static gen12NameIndex(national, isEgg) {
        if (isEgg) return PoolNames.EGG_SPECIES;
        if (national === PoolNames.MR_MIME_SPECIES) return PoolNames.MR_MIME_OLD_NAME_POS;
        if (national === PoolNames.UNOWN_SPECIES) return PoolNames.UNOWN_REAL_NAME_POS;
        return national;
    }

    static decodeGen2(e, slot, mask) {
        const species = e[0];
        const ivs = (e[0x15] << 8) | e[0x16];
        // The egg flag closes the record; newer servers send longer mail data before it
        const isEgg = e[e.length - 1] === this.GEN2_EGG_VALUE;
        const stats = ['HP', 'Attack', 'Defense', 'Speed', 'Sp. Attack', 'Sp. Defense']
            .map((n, i) => [n, (e[36 + i * 2] << 8) | e[37 + i * 2]]);
        const itemId = e[1];
        const unownLetter = species === PoolNames.UNOWN_SPECIES ? this.unownLetterGen2(ivs) : null;
        const nameIndex = unownLetter !== null ? PoolNames.unownIndex(unownLetter) : species;
        const realName = PoolNames.speciesName(nameIndex);
        const speciesName = isEgg ? PoolNames.speciesName(PoolNames.EGG_SPECIES) : realName;
        const nickname = e.subarray(59, 70);
        const language = this.gen12Language(mask, nickname, this.gen12NameIndex(species, isEgg));
        const textLanguage = language ?? PoolNames.ENGLISH_LANGUAGE;
        const localIndex = unownLetter !== null && !isEgg ? nameIndex : this.gen12NameIndex(species, isEgg);
        return {
            slot, gen: 2, national: species, unownLetter, speciesName,
            localSpeciesName: this.localSpeciesName(localIndex, language, speciesName),
            language: PoolNames.languageInfo(language),
            hatchName: isEgg ? realName : null,
            nickname: PoolNames.gen12Text(nickname, textLanguage),
            otName: PoolNames.gen12Text(e.subarray(48, 59), textLanguage),
            otId: (e[6] << 8) | e[7],
            level: e[31],
            currHp: (e[34] << 8) | e[35],
            stats,
            moves: [0, 1, 2, 3].map(i => ({ id: e[2 + i], name: PoolNames.moveName(e[2 + i]), pp: e[23 + i] & 0x3F })).filter(m => m.id),
            ivs: this.ivList(ivs, 2),
            exp: (e[8] << 16) | (e[9] << 8) | e[10],
            item: itemId ? {
                id: itemId,
                name: this.GEN2_MAIL_ITEMS.has(itemId) ? 'Mail' : PoolNames.itemNameForGen(2, itemId),
            } : null,
            friendship: e[27],
            isEgg,
            isShiny: this.shinyGen2(ivs),
        };
    }

    static gen3Stats(entry) {
        const dv = new DataView(entry.buffer, entry.byteOffset);
        const labels = ['HP', 'Attack', 'Defense', 'Speed', 'Sp. Attack', 'Sp. Defense'];
        return labels.map((name, i) => [name, dv.getUint16(RSESPTradingPokemonInfo.STATS_POS + i * 2, true)]);
    }

    static decodeGen3(e, slot) {
        const parsed = RSESPUtils.singleMonFromData(this.rseChecks || new RSESPChecks(), e);
        if (!parsed) return null;
        const mon = parsed[0];
        const species = mon.getSpecies();
        const isEgg = !!parsed[1];
        const national = PoolNames.gen3ToNational(species);
        const ivs = mon.getIVs ? mon.getIVs() : null;
        const itemId = mon.getItem ? mon.getItem() : 0;
        const unownLetter = (species === RSESPTradingPokemonInfo.UNOWN_SPECIES && mon.getUnownLetter)
            ? mon.getUnownLetter() : null;
        const languageId = e[RSESPTradingPokemonInfo.LANGUAGE_POS];
        const japanese = languageId === RSESPTradingPokemonInfo.JAPANESE_LANGUAGE_ID;
        const monIndex = mon.getMonIndex ? mon.getMonIndex() : species;
        const speciesName = PoolNames.speciesName(isEgg ? PoolNames.EGG_SPECIES : monIndex);
        // An egg's language is a Japanese placeholder until it hatches
        const language = isEgg ? null : PoolNames.languageInfo(languageId);
        return {
            slot, gen: 3, national, unownLetter, speciesName,
            localSpeciesName: language ? this.localSpeciesName(monIndex, language.id, speciesName) : null,
            language,
            hatchName: isEgg ? PoolNames.speciesName(monIndex) : null,
            // Gen 3 eggs always store the Japanese egg name, which the games never show
            nickname: isEgg ? PoolNames.speciesName(PoolNames.EGG_SPECIES)
                : PoolNames.gen3Text(e, RSESPTradingPokemonInfo.NICKNAME_POS, RSESPTradingPokemonInfo.NICKNAME_LEN, japanese),
            otName: PoolNames.gen3Text(e, RSESPTradingPokemonInfo.OT_NAME_POS, RSESPTradingPokemonInfo.OT_NAME_LEN, japanese),
            otId: (new DataView(e.buffer, e.byteOffset)).getUint16(RSESPTradingPokemonInfo.OT_ID_POS, true),
            level: mon.getLevel ? mon.getLevel() : 0,
            currHp: mon.getCurrHp ? mon.getCurrHp() : 0,
            stats: this.gen3Stats(e),
            moves: [0, 1, 2, 3].map(i => {
                const id = mon.getMove ? mon.getMove(i) : 0;
                return { id, name: PoolNames.moveName(id), pp: mon.getPP ? mon.getPP(i) : 0 };
            }).filter(m => m.id),
            ivs: Array.isArray(ivs) ? ['HP', 'Attack', 'Defense', 'Speed', 'Sp. Attack', 'Sp. Defense'].map((n, i) => [n, ivs[i]]).filter(x => x[1] !== undefined) : [],
            exp: mon.getExp ? mon.getExp() : 0,
            item: itemId ? { id: itemId, name: PoolNames.itemNameForGen(3, itemId) } : null,
            nature: mon.getNature ? PoolNames.natureDescription(mon.getNature()) : null,
            isEgg,
            isShiny: !isEgg && this.shinyGen3(e),
        };
    }

    static SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions';
    static EGG_SPRITE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/egg.png';

    static UNOWN_FORMS = [...'abcdefghijklmnopqrstuvwxyz', 'exclamation', 'question'];

    static unownSpritePath(mon) {
        const form = this.UNOWN_FORMS[mon.unownLetter];
        if (!form) return null;
        if (mon.gen === 2) {
            const file = mon.unownLetter === 0 ? '201.png' : `201-${form}.png`;
            return `generation-ii/gold/transparent/${file}`;
        }
        return `generation-iii/emerald/${mon.isShiny ? 'shiny/' : ''}201-${form}.png`;
    }

    static spriteUrl(mon) {
        if (!mon.national) return null;
        if (mon.unownLetter !== null && mon.unownLetter !== undefined) {
            const unown = this.unownSpritePath(mon);
            if (unown) return `${this.SPRITE_BASE}/${unown}`;
        }
        const shiny = mon.isShiny ? 'shiny/' : '';
        const path = {
            1: `generation-i/red-blue/transparent/${mon.national}.png`,
            2: `generation-ii/crystal/transparent/${shiny}${mon.national}.png`,
            3: `generation-iii/emerald/${shiny}${mon.national}.png`,
        }[mon.gen];
        return path ? `${this.SPRITE_BASE}/${path}` : null;
    }

    /** Opaque sprite, used only if the transparent one is missing. */
    static spriteFallbackUrl(mon) {
        if (!mon.national) return null;
        if (mon.unownLetter !== null && mon.unownLetter !== undefined) {
            const unown = this.unownSpritePath(mon);
            if (unown) return `${this.SPRITE_BASE}/${unown}`;
        }
        const shiny = mon.isShiny ? 'shiny/' : '';
        const path = {
            1: `generation-i/red-blue/${mon.national}.png`,
            2: `generation-ii/crystal/${shiny}${mon.national}.png`,
            3: `generation-iii/emerald/${shiny}${mon.national}.png`,
        }[mon.gen];
        return path ? `${this.SPRITE_BASE}/${path}` : null;
    }

    /** Aggregates for the summary strip. */
    static summarize(pool) {
        const species = new Map();
        let shiny = 0, eggs = 0, holding = 0, levelSum = 0;
        for (const m of pool.mons) {
            species.set(m.speciesName, (species.get(m.speciesName) || 0) + 1);
            if (m.isShiny) shiny++;
            if (m.isEgg) eggs++;
            if (m.item) holding++;
            levelSum += m.level || 0;
        }
        const top = [...species.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        return {
            total: pool.mons.length, unique: species.size, shiny, eggs, holding,
            avgLevel: pool.mons.length ? Math.round(levelSum / pool.mons.length) : 0,
            top,
        };
    }
}
