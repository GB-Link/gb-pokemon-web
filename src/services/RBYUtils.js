/**
 * RBYUtils.js - Utility functions for Gen 1 (Red/Blue/Yellow) trading.
 * Extends GSCUtils with RBY-specific constants and methods.
 */

import { GSCUtils } from './GSCUtils.js?v=88';

export class RBYUtils extends GSCUtils {
    // ==================== RBY-SPECIFIC STRUCTURE CONSTANTS ====================

    // Pokemon data structure (44 bytes total vs 48 for GSC)
    static trading_pokemon_length = 0x2C; // 44 bytes
    static trading_name_length = 0x0B;    // 11 bytes (same as GSC)
    static trading_mail_length = 0;       // No mail in Gen 1
    static trading_mail_sender_length = 0;

    // Party data positions
    static trader_name_pos = 0;
    static trading_party_info_pos = 0x0B;     // 11
    static trading_party_final_pos = 0x12;    // 18
    static trading_pokemon_pos = 0x13;        // 19 (same as GSC)
    static trading_pokemon_ot_pos = 0x11B;    // 283 (vs 0x135=309 for GSC)
    static trading_pokemon_nickname_pos = 0x15D; // 349 (vs 0x177=375 for GSC)

    // Section lengths: [Random, Pokemon, Patches] - no Mail section
    static SECTION_LENGTHS = [0x0A, 0x1A2, 0xC5]; // [10, 418, 197]

    // Patches positions for RBY
    static patch_set_base_pos = [0x13];
    static patch_set_start_info_pos = [7];

    // ==================== RBY POKEMON DATA OFFSETS ====================
    // Different from GSC due to simpler structure (no held item byte position difference, etc.)

    static item_pos = 7;       // Item slot (same offset, unused in Gen 1 for wild mons)
    static moves_pos = 8;      // Moves start at offset 8
    static pps_pos = 0x1D;     // PP values
    static level_pos = 0x21;   // Level position
    static exp_pos = 0x0E;     // Experience
    static curr_hp_pos = 1;    // Current HP (before level in Gen 1!)
    static stats_pos = 0x22;   // Stats start
    static evs_pos = 0x11;     // EVs (stat exp in Gen 1)
    static ivs_pos = 0x1B;     // IVs (DVs in Gen 1)
    static status_pos = 4;     // Status condition

    // Stats count (5 in Gen 1 vs 6 in GSC - no Special split)
    static num_stats = 5;
    static stat_id_base_conv_table = [0, 1, 2, 3, 4];
    static stat_id_iv_conv_table = [0, 0, 1, 2, 3];
    static stat_id_exp_conv_table = [0, 1, 2, 3, 4];

    // ==================== RBY SPECIAL POKEMON ====================
    // Legendary birds for special handling (Gen 1 dex numbers)
    static articuno_species = 74;
    static zapdos_species = 75;
    static moltres_species = 73;
    static mew_species = 21;
    static special_mons = new Set([73, 74, 75]); // Moltres, Articuno, Zapdos

    // ==================== NO MAIL/EGG IN GEN 1 ====================

    /**
     * Check if item is mail - always false for Gen 1
     */
    static isItemMail(item) {
        return false;
    }

    /**
     * Check if party slot is an egg - always false for Gen 1
     */
    static isMonEgg(partyInfo, pos) {
        return false; // No eggs in Gen 1
    }

    /**
     * Party has mail - always false for Gen 1
     */
    static partyHasMail() {
        return false;
    }

    // ==================== RBY NO-MAIL SECTION ====================
    // Gen 1 has no mail section, so this is null
    static noMailSection = null;

    // ==================== RBY EVOLUTION (SIMPLIFIED) ====================
    // Gen 1 has no evolution items like Metal Coat, King's Rock, etc.

    static getEvolutionItem(species) {
        return null; // No trade evolution items in Gen 1
    }

    // ==================== RBY SINGLE POKEMON DATA FORMAT ====================
    // Single Pokemon for pool/choice transfers (different size)
    // Format: [species] + [pokemon data 44 bytes] + [OT name 11 bytes] + [nickname 11 bytes]
    // Total: 1 + 44 + 11 + 11 = 67 bytes (0x43) vs 118 bytes (0x76) for GSC
    static SINGLE_POKEMON_SIZE = 0x42; // 66 bytes (without choice byte)

    // ==================== RBY TRADING DATA CREATION ====================

    // Default party data for ghost trades (loaded from base.bin)
    static defaultPartyData = null;

    /**
     * Create default trading data for RBY (3 sections, no mail)
     * Uses cached defaultPartyData if loaded, otherwise creates empty sections.
     */
    static createDefaultTradingData() {
        // If we have cached default party data, use it
        if (RBYUtils.defaultPartyData) {
            return {
                section1: new Uint8Array(RBYUtils.defaultPartyData.section1),
                section2: new Uint8Array(RBYUtils.defaultPartyData.section2)
            };
        }

        // Fallback to empty sections (will cause garbled display)
        console.warn('[RBYUtils] No default party data loaded - ghost trade may show garbled data');
        return {
            section1: new Uint8Array(RBYUtils.SECTION_LENGTHS[1]).fill(0),
            section2: new Uint8Array(RBYUtils.SECTION_LENGTHS[2]).fill(0)
            // No section3 (mail) in Gen 1
        };
    }

    /**
     * Load default party data from base.bin for ghost trades.
     * This is the RBY equivalent of GSCUtils.loadDefaultPartyData().
     * Uses the same base.bin file as loadBasePoolData().
     */
    static async loadDefaultPartyData() {
        // If already loaded via loadBasePoolData, use that
        if (this.basePoolData) {
            this.defaultPartyData = {
                section1: new Uint8Array(this.basePoolData.section1),
                section2: new Uint8Array(this.basePoolData.section2)
            };
            console.log('[RBYUtils] Using basePoolData as defaultPartyData');
            return true;
        }

        // Otherwise load base.bin
        const loaded = await this.loadBasePoolData();
        if (loaded && this.basePoolData) {
            this.defaultPartyData = {
                section1: new Uint8Array(this.basePoolData.section1),
                section2: new Uint8Array(this.basePoolData.section2)
            };
            console.log('[RBYUtils] Loaded defaultPartyData from base.bin');
            return true;
        }

        console.warn('[RBYUtils] Failed to load default party data');
        return false;
    }

    // Base pool data (loaded by loadBasePoolData)
    static basePoolData = null;
    static BASE_FOLDER = '/data/rby/';

    /**
     * Load base section template from binary file.
     * Uses base.bin (625 bytes) which contains properly structured party data:
     * - Section 0: Random (10 bytes) - skipped
     * - Section 1: Pokemon (418 bytes)
     * - Section 2: Patches (197 bytes)
     * 
     * This template is used to construct proper trading data for pool trades.
     * ref impl uses base.bin for this purpose, NOT base_pool.bin (which is for single Pokemon).
     */
    static async loadBasePoolData() {
        try {
            // Use base.bin which has complete section template (625 bytes)
            const response = await fetch(this.BASE_FOLDER + 'base.bin');
            if (!response.ok) {
                console.warn('[RBYUtils] Could not load base.bin, using manual construction');
                return false;
            }

            const buffer = await response.arrayBuffer();
            const data = new Uint8Array(buffer);

            // Verify file size matches expected section lengths
            const SECTION_LENS = this.SECTION_LENGTHS; // [10, 418, 197] = 625 total
            const expectedSize = SECTION_LENS.reduce((a, b) => a + b, 0);

            if (data.length < expectedSize) {
                console.warn(`[RBYUtils] base.bin too small: ${data.length} bytes, expected ${expectedSize}`);
                return false;
            }

            let offset = 0;

            // Random section (10 bytes) - skip, we get this from server
            offset += SECTION_LENS[0];

            // Pokemon section (418 bytes)
            const section1 = data.slice(offset, offset + SECTION_LENS[1]);
            offset += SECTION_LENS[1];

            // Patches section (197 bytes)
            const section2 = data.slice(offset, offset + SECTION_LENS[2]);

            this.basePoolData = {
                section1: new Uint8Array(section1),
                section2: new Uint8Array(section2)
            };

            console.log(`[RBYUtils] Loaded base.bin template (${data.length} bytes): section1=${section1.length}, section2=${section2.length}`);
            return true;
        } catch (e) {
            console.warn('[RBYUtils] Error loading base.bin:', e);
            return false;
        }
    }

    /**
     * Create trading data from pool data (RBY format)
     * Pool data format: [pokemon_data (44 bytes), ot_name (11 bytes), nickname (11 bytes)]
     * The species is at offset 0 within the pokemon_data struct
     * 
     * Uses base.bin template if loaded, otherwise constructs manually.
     * IMPORTANT: Must zero out unused party slots to prevent garbage display.
     */
    static createTradingData(poolData) {
        // Start with template if available, otherwise create empty sections
        let section1, section2;

        if (this.basePoolData) {
            // Clone the template so we don't modify the original
            section1 = new Uint8Array(this.basePoolData.section1);
            section2 = new Uint8Array(this.basePoolData.section2);
        } else {
            section1 = new Uint8Array(RBYUtils.SECTION_LENGTHS[1]).fill(0);
            section2 = new Uint8Array(RBYUtils.SECTION_LENGTHS[2]).fill(0);
        }

        // RBY Party Data Layout (418 bytes total):
        // [0x00-0x0A]: Trader name (11 bytes)
        // [0x0B]: Party count
        // [0x0C-0x12]: Species list (6 species + 0xFF terminator)
        // [0x13-0x11A]: Pokemon data (6 * 44 = 264 bytes)
        // [0x11B-0x15C]: OT names (6 * 11 = 66 bytes)
        // [0x15D-0x19E]: Nicknames (6 * 11 = 66 bytes)

        const POKEMON_DATA_LEN = RBYUtils.trading_pokemon_length; // 44
        const NAME_LEN = RBYUtils.trading_name_length; // 11
        const MAX_PARTY_SIZE = 6;

        if (poolData && poolData.length > 0) {
            // Pool trade: We have exactly 1 Pokemon from the pool

            // 1. Set party count = 1
            section1[RBYUtils.trading_party_info_pos] = 1;

            // 2. Set species list: [species, 0xFF, ...zeroes]
            section1[RBYUtils.trading_party_info_pos + 1] = poolData[0]; // Species
            section1[RBYUtils.trading_party_info_pos + 2] = 0xFF; // Terminator
            for (let i = 3; i < 8; i++) {
                section1[RBYUtils.trading_party_info_pos + i] = 0x00;
            }

            // 3. Copy Pokemon data for slot 0 (44 bytes)
            const pokemonDataLength = Math.min(poolData.length, POKEMON_DATA_LEN);
            for (let i = 0; i < pokemonDataLength; i++) {
                section1[RBYUtils.trading_pokemon_pos + i] = poolData[i];
            }

            // 4. Zero out Pokemon data for slots 1-5 (to remove template garbage)
            for (let slot = 1; slot < MAX_PARTY_SIZE; slot++) {
                const slotOffset = RBYUtils.trading_pokemon_pos + (slot * POKEMON_DATA_LEN);
                for (let i = 0; i < POKEMON_DATA_LEN; i++) {
                    section1[slotOffset + i] = 0x00;
                }
            }

            // 5. Copy OT name for slot 0
            const otNameStart = POKEMON_DATA_LEN; // 44
            if (poolData.length >= otNameStart + NAME_LEN) {
                for (let i = 0; i < NAME_LEN; i++) {
                    section1[RBYUtils.trading_pokemon_ot_pos + i] = poolData[otNameStart + i];
                }
            }

            // 6. Zero out OT names for slots 1-5
            for (let slot = 1; slot < MAX_PARTY_SIZE; slot++) {
                const slotOffset = RBYUtils.trading_pokemon_ot_pos + (slot * NAME_LEN);
                for (let i = 0; i < NAME_LEN; i++) {
                    section1[slotOffset + i] = 0x50; // 0x50 = text terminator
                }
            }

            // 7. Copy Nickname for slot 0
            const nicknameStart = otNameStart + NAME_LEN; // 55
            if (poolData.length >= nicknameStart + NAME_LEN) {
                for (let i = 0; i < NAME_LEN; i++) {
                    section1[RBYUtils.trading_pokemon_nickname_pos + i] = poolData[nicknameStart + i];
                }
            }

            // 8. Zero out Nicknames for slots 1-5
            for (let slot = 1; slot < MAX_PARTY_SIZE; slot++) {
                const slotOffset = RBYUtils.trading_pokemon_nickname_pos + (slot * NAME_LEN);
                for (let i = 0; i < NAME_LEN; i++) {
                    section1[slotOffset + i] = 0x50; // 0x50 = text terminator
                }
            }

            console.log(`[RBYUtils] Created trading data: 1 Pokemon, cleared slots 1-5`);
        }

        // Create patches (this replaces 0xFE bytes with patch offsets)
        RBYUtils.createPatchesData(section1, section2, false);

        return {
            section1: section1,
            section2: section2
        };
    }
}

