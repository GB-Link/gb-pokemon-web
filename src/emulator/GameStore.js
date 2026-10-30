/**
 * The emulator's games kept in this browser's IndexedDB: each ROM with its
 * battery save, so they can be played again later. Nothing leaves the device.
 * Every call fails soft: private windows and blocked storage just keep nothing.
 */
import { identifyRom } from './RomInfo.js?v=103';

const DB_NAME = 'gblink-emulator';
const DB_VERSION = 2;
// id -> { id, name, info, romSize, save, saveSize, addedAt, playedAt, unsaved }
// (unsaved: the game saved since its save was last downloaded)
const GAMES = 'library';
// id -> ROM bytes (kept apart so listing the games doesn't read the ROMs)
const ROMS = 'roms';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
        t[i] = c >>> 0;
    }
    return t;
})();

/** The id a ROM is kept under: its CRC-32. */
export function gameId(rom) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < rom.length; i++) c = CRC_TABLE[(c ^ rom[i]) & 0xFF] ^ (c >>> 8);
    return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = req.result;
            const create = () => {
                db.createObjectStore(GAMES, { keyPath: 'id' });
                db.createObjectStore(ROMS);
            };
            if (e.oldVersion < 1 || !db.objectStoreNames.contains('games')) {
                create();
                return;
            }
            // Version 1 kept only the last game, under 'last'
            req.transaction.objectStore('games').get('last').onsuccess = (got) => {
                const last = got.target.result;
                db.deleteObjectStore('games');
                create();
                if (!last || !last.rom) return;
                const rom = new Uint8Array(last.rom);
                const id = gameId(rom);
                const at = last.savedAt ?? Date.now();
                req.transaction.objectStore(ROMS).put(last.rom, id);
                req.transaction.objectStore(GAMES).put({ id, name: last.name, info: identifyRom(rom), romSize: rom.length,
                    save: last.save ?? null, saveSize: last.saveSize ?? 0, addedAt: at, playedAt: at, unsaved: true });
            };
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function run(stores, mode, fn) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(stores, mode);
            let result;
            fn(tx, (value) => { result = value; });
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

/** Changes one kept game's record; nothing happens when it isn't kept. */
function change(id, fn) {
    return run([GAMES], 'readwrite', (tx, done) => {
        const games = tx.objectStore(GAMES);
        games.get(id).onsuccess = (e) => {
            const game = e.target.result;
            if (!game) return;
            fn(game);
            games.put(game);
            done(true);
        };
    });
}

export const GameStore = {
    /** The kept games without their ROMs, last played first. */
    async list() {
        try {
            const games = await run([GAMES], 'readonly', (tx, done) => {
                tx.objectStore(GAMES).getAll().onsuccess = (e) => done(e.target.result);
            });
            return (games ?? []).sort((a, b) => b.playedAt - a.playedAt);
        } catch (_) {
            return [];
        }
    },

    /** One kept game with its ROM, or null. */
    async get(id) {
        try {
            return await run([GAMES, ROMS], 'readonly', (tx, done) => {
                tx.objectStore(GAMES).get(id).onsuccess = (e) => {
                    const game = e.target.result;
                    if (!game) return;
                    tx.objectStore(ROMS).get(id).onsuccess = (r) => done(r.target.result ? { ...game, rom: new Uint8Array(r.target.result) } : null);
                };
            }) ?? null;
        } catch (_) {
            return null;
        }
    },

    /** Keeps a game that was just started (its ROM is stored once). Returns false when the browser can't keep it. */
    async put({ id, name, info, rom, save, saveSize, unsaved }) {
        try {
            const now = Date.now();
            await run([GAMES, ROMS], 'readwrite', (tx) => {
                const games = tx.objectStore(GAMES);
                games.get(id).onsuccess = (e) => {
                    const old = e.target.result;
                    if (!old) tx.objectStore(ROMS).put(rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength), id);
                    games.put({ id, name, info, romSize: rom.length, save, saveSize, unsaved, addedAt: old?.addedAt ?? now, playedAt: now });
                };
            });
            return true;
        } catch (_) {
            return false;
        }
    },

    /** The game saved: its new save hasn't been downloaded yet. */
    async updateSave(id, save) {
        try {
            return !!(await change(id, (game) => {
                game.save = save;
                game.unsaved = true;
            }));
        } catch (_) {
            return false;
        }
    },

    async markDownloaded(id) {
        try {
            return !!(await change(id, (game) => { game.unsaved = false; }));
        } catch (_) {
            return false;
        }
    },

    async remove(id) {
        try {
            await run([GAMES, ROMS], 'readwrite', (tx) => {
                tx.objectStore(GAMES).delete(id);
                tx.objectStore(ROMS).delete(id);
            });
            return true;
        } catch (_) {
            return false;
        }
    },
};
