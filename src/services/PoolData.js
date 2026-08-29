/**
 * PoolData.js - Fetch and decode the server's pool dumps.
 *
 * The server serves /pooldata{1,2,3} as a 20-byte header (magic, format
 * version, gen, entry size, count) followed by fixed-size records, each one
 * the same single-Pokemon payload a pool trade sends. Every generation is
 * normalized here into one shape for display.
 */

import { PoolNames } from './PoolNames.js?v=91';
import { GSCUtils } from './GSCUtils.js?v=91';
import { RSESPUtils, RSESPTradingPokemonInfo } from './RSESPUtils.js?v=91';
import { RSESPChecks } from './RSESPChecks.js?v=91';

export class PoolData {
    static MAGIC = 0x35678292;
    static SUPPORTED_VERSION = 1;
    static GEN2_EGG_VALUE = 0x38;
    // Gen 2 mail items have no Gen 3 equivalent to take a name from
    static GEN2_MAIL_ITEMS = new Set([0x9E, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD]);

    static byteToChar = null;

    /**
     * Gen 1/2 text bytes to characters. The shipped text_conv.txt only covers
     * what the client needs to write (uppercase and a few symbols), so player
     * nicknames - which are mixed case - need the full character set.
     */
    static buildTextTable() {
        if (this.byteToChar) return;
        const map = { 0x7F: ' ', 0x9A: '(', 0x9B: ')', 0x9C: ':', 0x9D: ';', 0x9E: '[', 0x9F: ']' };
        for (let i = 0; i < 26; i++) {
            map[0x80 + i] = String.fromCharCode(65 + i);
            map[0xA0 + i] = String.fromCharCode(97 + i);
        }
        Object.assign(map, {
            0xBA: 'e', 0xBB: "'d", 0xBC: "'l", 0xBD: "'s", 0xBE: "'t", 0xBF: "'v",
            0xE0: "'", 0xE1: 'PK', 0xE2: 'MN', 0xE3: '-', 0xE4: "'r", 0xE5: "'m",
            0xE6: '?', 0xE7: '!', 0xE8: '.', 0xE9: '&', 0xEA: 'e', 0xEF: '\u2642',
            0xF0: '\u00A5', 0xF1: '\u00D7', 0xF2: '.', 0xF3: '/', 0xF4: ',', 0xF5: '\u2640',
        });
        for (let i = 0; i < 10; i++) map[0xF6 + i] = String.fromCharCode(48 + i);
        this.byteToChar = map;
    }

    static gscText(bytes) {
        this.buildTextTable();
        let s = '';
        for (const b of bytes) {
            if (b === 0x50) break;
            s += this.byteToChar[b] ?? '';
        }
        return s.trim();
    }

    /**
     * Load one generation's pool. baseUrl is the server's http(s) origin.
     */
    static async fetch(baseUrl, gen) {
        await PoolNames.load();
        this.buildTextTable();
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
        if (version !== this.SUPPORTED_VERSION) throw new Error(`unsupported pool format version ${version}`);
        const gen = dv.getUint32(8, true) + 1;
        const entrySize = dv.getUint32(12, true);
        const count = dv.getUint32(16, true);
        if (!entrySize || 20 + entrySize * count > bytes.length) throw new Error('pool data truncated');

        const decode = { 1: (e, i) => this.decodeGen1(e, i), 2: (e, i) => this.decodeGen2(e, i), 3: (e, i) => this.decodeGen3(e, i) }[gen];
        if (!decode) throw new Error(`unsupported generation ${gen}`);

        const mons = [];
        for (let i = 0; i < count; i++) {
            const entry = bytes.subarray(20 + i * entrySize, 20 + (i + 1) * entrySize);
            try {
                const mon = decode(entry, i);
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

    static decodeGen1(e, slot) {
        const internal = e[0];
        const national = PoolNames.gen1ToNational(internal);
        const ivs = (e[27] << 8) | e[28];
        const stats = ['HP', 'Attack', 'Defense', 'Speed', 'Special'].map((n, i) => [n, (e[34 + i * 2] << 8) | e[35 + i * 2]]);
        return {
            slot, gen: 1, national,
            speciesName: PoolNames.speciesName(national),
            otName: this.gscText(e.subarray(44, 55)),
            nickname: this.gscText(e.subarray(55, 66)),
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

    static decodeGen2(e, slot) {
        const species = e[0];
        const ivs = (e[0x15] << 8) | e[0x16];
        const isEgg = e[117] === this.GEN2_EGG_VALUE;
        const stats = ['HP', 'Attack', 'Defense', 'Speed', 'Sp. Attack', 'Sp. Defense']
            .map((n, i) => [n, (e[36 + i * 2] << 8) | e[37 + i * 2]]);
        const itemId = e[1];
        return {
            slot, gen: 2, national: species,
            speciesName: PoolNames.speciesName(isEgg ? PoolNames.EGG_SPECIES : species),
            hatchName: isEgg ? PoolNames.speciesName(species) : null,
            nickname: this.gscText(e.subarray(59, 70)),
            otName: this.gscText(e.subarray(48, 59)),
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
        return {
            slot, gen: 3, national,
            speciesName: PoolNames.speciesName(isEgg ? PoolNames.EGG_SPECIES : (mon.getMonIndex ? mon.getMonIndex() : species)),
            hatchName: isEgg ? PoolNames.speciesName(mon.getMonIndex ? mon.getMonIndex() : species) : null,
            nickname: PoolNames.gen3Text(e, RSESPTradingPokemonInfo.NICKNAME_POS, RSESPTradingPokemonInfo.NICKNAME_LEN),
            otName: PoolNames.gen3Text(e, RSESPTradingPokemonInfo.OT_NAME_POS, RSESPTradingPokemonInfo.OT_NAME_LEN),
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

    static SPRITE_BASE = 'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/versions';
    static EGG_SPRITE = 'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/egg.png';

    /**
     * Sprite from the PokeAPI set, using art from the matching era. The Gen 1
     * and 2 sets are opaque white by default; their "transparent" variants are
     * both alpha-masked and higher resolution, so they suit either theme.
     */
    static spriteUrl(mon) {
        if (!mon.national) return null;
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
