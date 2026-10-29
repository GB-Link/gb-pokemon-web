/**
 * SettingsManager - Manages application settings with localStorage persistence.
 * 
 * Settings are organized by category matching the reference client options.
 * Provides change detection for "(Default)" UI indicators.
 */

export class SettingsManager {
    // Default values for all settings
    static DEFAULTS = {
        // General Options
        serverUrl: 'wss://pokemon-gb-online-trades.herokuapp.com',
        language: 2,
        profanityFilter: true,
        tradeDefaultPokemonNames: false,
        tradeDefaultTrainerNames: false,
        battleDefaultPokemonNames: true,
        battleDefaultTrainerNames: false,
        doSanityChecks: true,
        verbose: false,
        darkMode: true,

        // 2-Player Options
        isBuffered: false,
        crashOnSyncDrop: true,
        battleTurnTime: 30,

        // Pool Trade Options
        maxLevel: 100,
        convertToEggs: false
    };

    static STORAGE_KEY = 'pokemonGBTradeSettings';

    constructor() {
        this.settings = this.load();
    }

    /**
     * Load settings from localStorage, falling back to defaults.
     */
    load() {
        try {
            const stored = localStorage.getItem(SettingsManager.STORAGE_KEY);
            if (stored) {
                const parsed = SettingsManager.migrate(JSON.parse(stored));
                // Merge with defaults to handle new settings added in updates
                return { ...SettingsManager.DEFAULTS, ...parsed };
            }
        } catch (e) {
            console.warn('Failed to load settings from localStorage:', e);
        }
        return { ...SettingsManager.DEFAULTS };
    }

    /**
     * Carry settings saved before the per-language options over to them.
     */
    static migrate(stored) {
        const s = { ...stored };
        if (s.language === undefined && s.isJapanese !== undefined) s.language = s.isJapanese ? 1 : 2;
        if (s.defaultReceivedNames !== undefined && s.tradeDefaultPokemonNames === undefined) {
            s.tradeDefaultPokemonNames = s.defaultReceivedNames;
            s.tradeDefaultTrainerNames = s.defaultReceivedNames;
        }
        if (s.defaultBattleNames !== undefined && s.battleDefaultPokemonNames === undefined) {
            s.battleDefaultPokemonNames = s.defaultBattleNames;
        }
        delete s.isJapanese;
        delete s.defaultReceivedNames;
        delete s.defaultBattleNames;
        return s;
    }

    /**
     * Save current settings to localStorage.
     */
    save() {
        try {
            localStorage.setItem(SettingsManager.STORAGE_KEY, JSON.stringify(this.settings));
        } catch (e) {
            console.warn('Failed to save settings to localStorage:', e);
        }
    }

    /**
     * Get a specific setting value.
     */
    get(key) {
        return this.settings[key];
    }

    /**
     * Set a specific setting value and persist.
     */
    set(key, value) {
        this.settings[key] = value;
        this.save();
    }

    /**
     * Check if a setting is at its default value.
     */
    isDefault(key) {
        return this.settings[key] === SettingsManager.DEFAULTS[key];
    }

    /**
     * Reset all settings to defaults.
     */
    resetToDefaults() {
        this.settings = { ...SettingsManager.DEFAULTS };
        this.save();
    }

    /**
     * Get all settings as an object.
     */
    getAll() {
        return { ...this.settings };
    }

    /**
     * Get default value for a setting.
     */
    getDefault(key) {
        return SettingsManager.DEFAULTS[key];
    }
}
