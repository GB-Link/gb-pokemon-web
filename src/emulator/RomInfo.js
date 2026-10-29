/**
 * Identifies a Gen 1/2 Pokémon cartridge from its ROM header: generation,
 * version and game language (the trade engine's language ids).
 */
const JAPANESE = 1, ENGLISH = 2, FRENCH = 3, ITALIAN = 4, GERMAN = 5, KOREAN = 6, SPANISH = 7;

// European Red and Blue keep the English titles; their global checksums differ
const GEN1_CHECKSUM_LANGUAGES = {
    0x91E6: ENGLISH, 0x7AFC: FRENCH, 0x5CDC: GERMAN, 0x89D2: ITALIAN, 0x384A: SPANISH,
    0x9D0A: ENGLISH, 0x56A4: FRENCH, 0x2EBC: GERMAN, 0x5E9C: ITALIAN, 0x14D7: SPANISH,
};
const CODE_LANGUAGES = { E: ENGLISH, F: FRENCH, D: GERMAN, I: ITALIAN, S: SPANISH, J: JAPANESE, K: KOREAN };
const GEN1_VERSIONS = { RED: 'Red', GREEN: 'Green', BLUE: 'Blue', YELLOW: 'Yellow' };
const GEN2_VERSIONS = { POKEMON_GLD: 'Gold', POKEMON_SLV: 'Silver', PM_CRYSTAL: 'Crystal' };

/** Returns { gen, version, language } (language null when unknown), or null. */
export function identifyRom(bytes) {
    if (!bytes || bytes.length < 0x150) return null;
    const text = String.fromCharCode(...bytes.subarray(0x134, 0x143));
    const destination = bytes[0x14A];
    const checksum = (bytes[0x14E] << 8) | bytes[0x14F];

    const gen1 = /^POKEMON (RED|GREEN|BLUE|YELLOW)\0*$/.exec(text);
    if (gen1) {
        const version = GEN1_VERSIONS[gen1[1]];
        let language = null;
        if (destination === 0) language = JAPANESE;
        else if (version === 'Yellow') language = ENGLISH;
        else language = GEN1_CHECKSUM_LANGUAGES[checksum] ?? null;
        return { gen: 1, version, language };
    }
    const yellow = /^POKEMON YELAPS([A-Z])$/.exec(text);
    if (yellow) return { gen: 1, version: 'Yellow', language: CODE_LANGUAGES[yellow[1]] ?? null };

    for (const [prefix, version] of Object.entries(GEN2_VERSIONS)) {
        if (text.startsWith(prefix)) return { gen: 2, version, language: CODE_LANGUAGES[text[14]] ?? null };
    }
    return null;
}

const LANGUAGE_NAMES = { [JAPANESE]: 'Japanese', [ENGLISH]: 'English', [FRENCH]: 'French', [ITALIAN]: 'Italian', [GERMAN]: 'German', [KOREAN]: 'Korean', [SPANISH]: 'Spanish' };

/** "Pokémon Gold (English)" */
export function gameTitle(info) {
    return `Pokémon ${info.version}${info.language ? ` (${LANGUAGE_NAMES[info.language]})` : ''}`;
}
