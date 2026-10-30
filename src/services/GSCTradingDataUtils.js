/**
 * GSCTradingDataUtils - Text, mail and party structures of the Gen 2
 * trading data.
 */
import { GSCUtils, GSCUtilsMisc, pyIndex, pySlice } from './GSCUtils.js?v=102';
import { GSCPokemonInfo } from './GSCPokemonInfo.js?v=102';
import { PokemonNamesForGen, PokemonTextConversions } from './TextConversions.js?v=102';

/**
 * A text entry (name, mail message...) of the trading data.
 */
export class GSCTradingText {
    constructor(data, start, length = 0x0B, dataStart = 0) {
        this.values = pySlice(data, start, start + length);
        this.startAt = dataStart;
        this.utilsClass = this.getUtilsClass();
        // A shorter name (Japanese defaults are 6 bytes) still fills its field,
        // or copying it into a section would shrink the section
        while (this.values.length < length) this.values.push(this.fieldPadding());
    }

    fieldPadding() {
        return this.utilsClass.END_OF_LINE;
    }

    getUtilsClass() {
        return GSCUtils;
    }

    /**
     * Equal up to the end of line.
     * @param {number[]} other - raw bytes
     */
    valuesEqual(other) {
        if (other === null || other === undefined) throw new TypeError("object of type 'NoneType' has no len()");
        const eol = this.utilsClass.END_OF_LINE;
        for (let i = 0; i < this.values.length; i++) {
            if (this.values[i] === eol && (i >= other.length || other[i] === eol)) return true;
            if (i >= other.length) return false;
            if (this.values[i] !== other[i]) return false;
        }
        if (other.length === this.values.length || pyIndex(other, this.values.length) === eol) return true;
        return false;
    }

    getLength() {
        for (let i = 0; i < this.values.length - this.startAt; i++) {
            if (this.values[i] === this.utilsClass.END_OF_LINE) return i - this.startAt;
        }
        return this.values.length - this.startAt;
    }

    static createFromString(string, length = 0xB) {
        const data = new Array(length).fill(this.prototype.getUtilsClass().END_OF_LINE);
        const chars = Array.from(string);
        const minLength = Math.min(length, chars.length);
        for (let i = 0; i < minLength; i++) data[i] = PokemonTextConversions.convertCharToGen12Char(chars[i]) & 0xFF;
        return new this(data, 0, length);
    }
}

/**
 * Mail message and sender data of one Pokémon.
 * Sender: OT name (8 bytes, 10 in Korean), mail language (2 bytes, none in
 * Korean), OT ID (2), species (1), mail type (1).
 */
export class GSCTradingMailData {
    static MAIL_LEN = 0x41;
    static MAIL_LEN_OLD = 0x21;
    static SENDER_LEN = 0xE;
    static LANGUAGE_SENDER_POS_INT = 0x8;
    static REFERENCE_GEN = 2;

    constructor(dataMail = null, dataSender = null) {
        const C = this.constructor;
        if (dataMail === null) dataMail = [0];
        if (!Array.isArray(dataMail)) dataMail = Array.from(dataMail);
        while (dataMail.length < C.MAIL_LEN) dataMail.push(0);
        if (dataSender === null) dataSender = [0];
        if (!Array.isArray(dataSender)) dataSender = Array.from(dataSender);
        while (dataSender.length < C.SENDER_LEN) dataSender.push(0);
        this.dataMail = new GSCTradingText(dataMail, 0, C.MAIL_LEN);
        this.dataSender = new GSCTradingText(dataSender, 0, C.SENDER_LEN);
        this.utilsClass = this.getUtilsClass();
    }

    getUtilsClass() {
        return GSCUtils;
    }

    getDataMail(isNewMailData = true) {
        if (isNewMailData) return this.dataMail.values;
        return this.dataMail.values.slice(0, this.constructor.MAIL_LEN_OLD);
    }

    getDataMailSender() {
        return this.dataSender.values;
    }

    /**
     * Language of an international mail from its 2 language bytes ("E" +
     * language letter); English when unmarked.
     */
    static getIntMailDataLanguage(mailLanguageData, gen) {
        const L = PokemonNamesForGen;
        const languageStr = Array.from(L.convertGenericNameGeneralForGen(mailLanguageData, gen));
        if (languageStr.length < 2) return L.ENGLISH_LANGUAGE;
        if (languageStr[0] !== 'E') return L.ENGLISH_LANGUAGE;
        if (!L.LANGUAGE_STR_SHORT_LIST_SMALL.includes(languageStr[1])) return L.ENGLISH_LANGUAGE;
        return L.SORTED_LANGUAGES_LIST[L.LANGUAGE_STR_SHORT_LIST_SMALL.indexOf(languageStr[1])];
    }

    getMailLanguage() {
        const pos = this.constructor.LANGUAGE_SENDER_POS_INT;
        return GSCTradingMailData.getIntMailDataLanguage(this.getDataMailSender().slice(pos, pos + 2), this.constructor.REFERENCE_GEN);
    }

    /**
     * The 2 language bytes marking a mail of this language ([0, 0] for
     * English).
     */
    static getMailLanguageDataForLanguage(language, gen) {
        const L = PokemonNamesForGen;
        if ((language === L.ENGLISH_LANGUAGE) || !L.SORTED_LANGUAGES_LIST.includes(language)) return [0, 0];
        const languageStr = 'E' + L.LANGUAGE_STR_SHORT_LIST_SMALL[L.SORTED_LANGUAGES_LIST.indexOf(language)];
        const languageData = [];
        for (const ch of languageStr) languageData.push(pyIndex(PokemonTextConversions.convertCharToGenxChar(ch, gen, null), 0));
        return languageData;
    }

    setMailLanguage(newLanguage) {
        const dataToSet = GSCTradingMailData.getMailLanguageDataForLanguage(newLanguage, this.constructor.REFERENCE_GEN);
        for (let i = 0; i < dataToSet.length; i++) {
            GSCUtilsMisc.setItem(this.dataSender.values, this.constructor.LANGUAGE_SENDER_POS_INT + i, dataToSet[i]);
        }
    }

    setDataMail(data) {
        const values = this.dataMail.values;
        const maxCopyLen = Math.min(values.length, data.length);
        for (let i = 0; i < maxCopyLen; i++) values[i] = data[i];
        if (data.length < values.length) values[data.length] = this.utilsClass.END_OF_LINE;
    }

    setDataMailSender(data) {
        const values = this.dataSender.values;
        const maxCopyLen = Math.min(values.length, data.length);
        for (let i = 0; i < maxCopyLen; i++) values[i] = data[i];
    }
}

/**
 * Party size and species list of the trading data.
 */
export class GSCTradingPartyInfo {
    static MAX_PARTY_MONS = 6;

    constructor(data, start) {
        const max = this.constructor.MAX_PARTY_MONS;
        if (data === null || data === undefined) {
            data = new Array(max + 1).fill(0);
            start = 0;
            data[0] = max;
        }
        this.setTotal(pyIndex(data, start));
        this.actualMons = pySlice(data, start + 1, start + 1 + max);
    }

    getId(pos) {
        if (pos >= this.getTotal() || pos >= this.constructor.MAX_PARTY_MONS) return null;
        return pyIndex(this.actualMons, pos);
    }

    setId(pos, val) {
        if (pos < this.getTotal() && pos < this.constructor.MAX_PARTY_MONS) GSCUtilsMisc.setItem(this.actualMons, pos, val);
    }

    getTotal() {
        return this.total;
    }

    setTotal(value) {
        this.total = value;
        if (this.total <= 0 || this.total > 6) this.total = 1;
    }
}

/**
 * A trader's whole party.
 */
export class GSCTradingData {
    static TRADER_NAME_POS = 0;
    static TRADING_PARTY_INFO_POS = 0x0B;
    static TRADING_PARTY_FINAL_POS = 0x12;
    static TRADER_INFO_POS = 0x13;
    static TRADING_POKEMON_POS = 0x15;
    static TRADING_POKEMON_OT_POS = 0x135;
    static TRADING_POKEMON_NICKNAME_POS = 0x177;

    static TRADING_POKEMON_LENGTH = 0x30;
    static TRADING_NAME_LENGTH = 0x0B;
    static TRADING_MAIL_LENGTH = 0x41;
    static TRADING_MAIL_LENGTH_OLD = 0x21;
    static TRADING_MAIL_SENDER_LENGTH = 0x0E;

    static TRADING_POKEMON_MAIL_POS = 0;
    static TRADING_POKEMON_MAIL_SENDER_POS = 0x41 * 6;
    static TRADING_POKEMON_MAIL_SENDER_OLD_POS = 0x21 * 6;

    // Random, party, patches, mail - 0x41-byte and 0x21-byte mail layouts
    static SECTION_LENGTHS = [0x0A, 0x1BC, 0xC5, 0x241];
    static SECTION_LENGTHS_OLD = [0x0A, 0x1BC, 0xC5, 0x181];

    /**
     * @param dataPokemon - party section
     * @param dataMail - mail section, optional
     * @param doFull - also read the Pokémon
     * @param isNewMailData - dataMail uses the 0x41-byte mail layout
     */
    constructor(dataPokemon, dataMail = null, doFull = true, isNewMailData = true) {
        const C = this.constructor;
        this.utilsClass = this.getUtilsClass();

        if (dataPokemon === null || dataPokemon === undefined) {
            this.trader = this.getTextClass().createFromString('Server', C.TRADING_NAME_LENGTH);
            this.partyInfo = this.partyGenerator(null, 0);
            this.trainerInfo = 1;
            this.pokemon = [];
            if (doFull) {
                for (let i = 0; i < this.getPartySize(); i++) {
                    this.pokemon.push(this.monGeneratorClass().createFromScratch());
                    this.partyInfo.setId(i, this.pokemon[i].getSpecies());
                }
            }
            return;
        }

        this.trader = this.textGenerator(dataPokemon, C.TRADER_NAME_POS, C.TRADING_NAME_LENGTH);
        this.partyInfo = this.partyGenerator(dataPokemon, C.TRADING_PARTY_INFO_POS);
        this.trainerInfo = this.trainerInfoGenerator(dataPokemon, C.TRADER_INFO_POS);
        this.pokemon = [];
        if (doFull) {
            for (let i = 0; i < this.getPartySize(); i++) {
                this.pokemon.push(this.monGenerator(dataPokemon, C.TRADING_POKEMON_POS + i * C.TRADING_POKEMON_LENGTH));
                this.pokemon[i].addOtName(dataPokemon, C.TRADING_POKEMON_OT_POS + i * C.TRADING_NAME_LENGTH);
                this.pokemon[i].addNickname(dataPokemon, C.TRADING_POKEMON_NICKNAME_POS + i * C.TRADING_NAME_LENGTH);
                if ((dataMail !== null && dataMail !== undefined) && this.pokemon[i].hasMail()) {
                    if (isNewMailData) {
                        this.pokemon[i].addMail(dataMail, C.TRADING_POKEMON_MAIL_POS + i * C.TRADING_MAIL_LENGTH, true);
                        this.pokemon[i].addMailSender(dataMail, C.TRADING_POKEMON_MAIL_SENDER_POS + i * C.TRADING_MAIL_SENDER_LENGTH);
                    } else {
                        this.pokemon[i].addMail(dataMail, C.TRADING_POKEMON_MAIL_POS + i * C.TRADING_MAIL_LENGTH_OLD, false);
                        this.pokemon[i].addMailSender(dataMail, C.TRADING_POKEMON_MAIL_SENDER_OLD_POS + i * C.TRADING_MAIL_SENDER_LENGTH);
                    }
                }
            }
        }
    }

    monGenerator(data, pos) {
        const MonClass = this.monGeneratorClass();
        return new MonClass(data, pos);
    }

    monGeneratorClass() {
        return GSCPokemonInfo;
    }

    textGenerator(data, pos, length = this.constructor.TRADING_NAME_LENGTH) {
        return new GSCTradingText(data, pos, length);
    }

    partyGenerator(data, pos) {
        return new GSCTradingPartyInfo(data, pos);
    }

    trainerInfoGenerator(data, pos) {
        return GSCUtilsMisc.readShort(data, pos);
    }

    getUtilsClass() {
        return GSCUtils;
    }

    getTextClass() {
        return GSCTradingText;
    }

    // An invalid index fails the call (false) instead of throwing
    isPosInvalid(pos) {
        return pos < 0 || pos >= this.getPartySize();
    }

    getPartySize() {
        return this.partyInfo.getTotal();
    }

    getLastMonIndex() {
        return this.getPartySize() - 1;
    }

    /**
     * @returns {number|null} index of the Pokémon in the party
     */
    searchForMon(mon, isEgg) {
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(pyIndex(this.pokemon, i)) && (this.isMonEgg(i) === isEgg)) return i;
        }
        for (let i = 0; i < this.getPartySize(); i++) {
            if (mon.isEqual(pyIndex(this.pokemon, i), true) && (this.isMonEgg(i) === isEgg)) return i;
        }
        return null;
    }

    monHasMail(pos) {
        if (this.isPosInvalid(pos)) return false;
        return pyIndex(this.pokemon, pos).hasMail();
    }

    isMonEgg(pos) {
        if (this.isPosInvalid(pos)) return false;
        return this.partyInfo.getId(pos) === this.utilsClass.EGG_ID;
    }

    partyHasMail() {
        let mailOwned = false;
        for (let i = 0; i < this.getPartySize(); i++) mailOwned = this.monHasMail(i) || mailOwned;
        return mailOwned;
    }

    /**
     * Turn the Pokémon into its evolution. One without a nickname takes the
     * new species' name in targetLanguage (the game it evolves in), re-encoded
     * for ownLanguage, since this copy is sent to our game again later.
     */
    evolutionProcedure(pos, evolution, targetLanguage, ownLanguage) {
        if (targetLanguage === null || targetLanguage === undefined) targetLanguage = PokemonNamesForGen.ENGLISH_LANGUAGE;
        const mon = pyIndex(this.pokemon, pos);
        const resetName = !mon.isNicknamed(targetLanguage, false);
        mon.setSpecies(evolution);
        if (resetName) {
            mon.setDefaultNickname(targetLanguage);
            mon.patchOutBadCharsForLanguageBufferedOnly(ownLanguage, this.utilsClass.getBasicChecks(), false);
        }
        this.partyInfo.setId(pos, mon.getSpecies());
        mon.updateStats();
    }

    /**
     * Whether the traded Pokémon needs the player's input (it evolved and
     * must forget a move, or it is in specialMonsSet).
     */
    requiresInput(pos, specialMonsSet, targetLanguage, ownLanguage) {
        if (this.isPosInvalid(pos)) return false;
        let result = GSCUtilsMisc.defaultIfNone(this.evolveMon(pos, targetLanguage, ownLanguage), false);
        if (!result) result = this.isSpecialMon(pos, specialMonsSet);
        return result;
    }

    /**
     * @returns {boolean|null} null if it does not evolve, true if it evolved
     * and needs the player's input, false if it evolved without
     */
    evolveMon(pos, targetLanguage, ownLanguage) {
        if (this.isPosInvalid(pos)) return false;
        const U = this.utilsClass;
        const mon = this.pokemon[pos];
        const evolution = U.getEvolution(mon.getSpecies(), mon.getItem());
        if (evolution === null || this.isMonEgg(pos)) return null;
        const evoItem = U.getEvolutionItem(mon.getSpecies());
        if (evoItem !== null && evoItem !== undefined) mon.setItem();
        this.evolutionProcedure(pos, evolution, targetLanguage, ownLanguage);
        const currLearning = mon.learnableMoves();
        if (currLearning !== null) {
            for (const move of currLearning) {
                if (!mon.hasMove(move)) {
                    const freeSlots = mon.freeMoveSlots();
                    if (freeSlots.length > 0) mon.setMove(freeSlots[0], move);
                    else return true;
                }
            }
        }
        return false;
    }

    isSpecialMon(pos, specialMonsSet) {
        if (this.isPosInvalid(pos)) return false;
        const species = this.pokemon[pos].getSpecies();
        if (specialMonsSet instanceof Set || specialMonsSet instanceof Map) return specialMonsSet.has(species);
        return Array.from(specialMonsSet).includes(species);
    }

    /**
     * Fully heal the entire party (HP, status, PP).
     */
    healParty() {
        const lenParty = Math.min(this.getPartySize(), this.pokemon.length);
        for (let i = 0; i < lenParty; i++) this.pokemon[i].fullHeal();
    }

    getTradedMons(other) {
        return [
            pyIndex(this.pokemon, this.getLastMonIndex()).getSpecies(),
            pyIndex(other.pokemon, other.getLastMonIndex()).getSpecies(),
        ];
    }

    patchOutBadCharsForLanguageBufferedOnlyPlayer(otherLanguage, targetLanguage, checks) {
        const U = this.utilsClass;
        if (targetLanguage === null || targetLanguage === undefined) return;
        if (otherLanguage === null || otherLanguage === undefined) return;
        if ((targetLanguage === PokemonNamesForGen.KOREAN_LANGUAGE) && (otherLanguage === PokemonNamesForGen.JAPANESE_LANGUAGE)) {
            U.patchOutBadCharsProtectKoreanFromJpnBufferedOnly(this.trader);
        }
        if ((targetLanguage !== PokemonNamesForGen.KOREAN_LANGUAGE) && (otherLanguage === PokemonNamesForGen.KOREAN_LANGUAGE)) {
            U.patchOutBadCharsProtectInternationalFromKoreanBufferedOnly(this.trader);
        }
    }

    /**
     * Re-encode the names of this party (from a player whose game language
     * is otherLanguage) for a game in targetLanguage.
     */
    patchOutBadCharsForLanguageBufferedOnly(otherLanguage, targetLanguage) {
        const checks = this.utilsClass.getBasicChecks();
        this.patchOutBadCharsForLanguageBufferedOnlyPlayer(otherLanguage, targetLanguage, checks);
        for (let i = 0; i < this.getPartySize(); i++) {
            pyIndex(this.pokemon, i).patchOutBadCharsForLanguageBufferedOnly(targetLanguage, checks, this.isMonEgg(i));
        }
    }

    /**
     * Trade a Pokémon between two parties; the received ones get the traded
     * friendship.
     */
    tradeMon(other, ownIndex, otherIndex, checks) {
        checks.resetSpeciesItemList();
        checks.setSingleTeamSize();
        checks.resetTextBuffers();
        checks.preparePatchSetsBuffer();
        checks.prepareSpeciesBuffer();

        // A converted Korean mail already carries its own newline/EOL
        if (this.monHasMail(ownIndex)) {
            if (this.pokemon[ownIndex].mail.getMailLanguage() === PokemonNamesForGen.KOREAN_LANGUAGE) checks.doMailNewlineChecks = false;
        }

        const ownId = checks.speciesCleaner(this.partyInfo.getId(ownIndex));
        checks.prepareSpeciesBuffer();
        const own = this.monGeneratorClass().setData(checks.applyChecksToData(checks.singlePokemonChecksMap, pyIndex(this.pokemon, ownIndex).getData()));

        this.reorderParty(ownIndex);
        other.reorderParty(otherIndex);
        GSCUtilsMisc.setItem(this.pokemon, this.getLastMonIndex(), pyIndex(other.pokemon, other.getLastMonIndex()));
        GSCUtilsMisc.setItem(other.pokemon, other.getLastMonIndex(), own);
        checks.currSpeciesPos = this.getLastMonIndex();
        checks.teamSize = this.getPartySize();
        this.partyInfo.setId(this.getLastMonIndex(), other.partyInfo.getId(other.getLastMonIndex()));
        other.partyInfo.setId(other.getLastMonIndex(), ownId);
        if (!this.isMonEgg(this.getLastMonIndex())) this.pokemon[this.getLastMonIndex()].setFriendship();
        if (!other.isMonEgg(other.getLastMonIndex())) other.pokemon[other.getLastMonIndex()].setFriendship();
    }

    /**
     * Move a Pokémon to the end of the party.
     */
    reorderParty(tradedPos) {
        if (this.isPosInvalid(tradedPos)) return false;
        const paInfo = this.partyInfo.getId(tradedPos);
        const poData = pyIndex(this.pokemon, tradedPos);
        for (let i = tradedPos + 1; i < this.getPartySize(); i++) {
            this.partyInfo.setId(i - 1, this.partyInfo.getId(i));
            this.pokemon[i - 1] = pyIndex(this.pokemon, i);
        }
        this.partyInfo.setId(this.getLastMonIndex(), paInfo);
        GSCUtilsMisc.setItem(this.pokemon, this.getLastMonIndex(), poData);
        return null;
    }

    /**
     * The sections for the hardware: [random, party, patches, mail].
     * Without arguments: the 0x21-byte mail layout; with lengths, the
     * 0x41-byte one unless isNewMailData is false.
     */
    createTradingData(lengths = null, isNewMailData = lengths !== null) {
        const C = this.constructor;
        const U = this.utilsClass;
        if (lengths === null) lengths = C.SECTION_LENGTHS;
        const data = [];
        for (let i = 0; i < 3; i++) data.push(new Array(lengths[i]).fill(0));
        if (isNewMailData) data.push(pySlice(U.noMailSection, 0));
        else data.push(pySlice(U.noMailSectionOld, 0));
        GSCUtilsMisc.copyToData(data[1], C.TRADER_NAME_POS, this.trader.values, C.TRADING_NAME_LENGTH);
        GSCUtilsMisc.setItem(data[1], C.TRADING_PARTY_INFO_POS, this.getPartySize());
        GSCUtilsMisc.copyToData(data[1], C.TRADING_PARTY_INFO_POS + 1, this.partyInfo.actualMons);
        GSCUtilsMisc.setItem(data[1], C.TRADING_PARTY_FINAL_POS, 0xFF);
        if (this.trainerInfo !== null && this.trainerInfo !== undefined) GSCUtilsMisc.writeShort(data[1], C.TRADER_INFO_POS, this.trainerInfo);
        for (let i = 0; i < this.getPartySize(); i++) {
            const mon = pyIndex(this.pokemon, i);
            GSCUtilsMisc.copyToData(data[1], C.TRADING_POKEMON_POS + (i * C.TRADING_POKEMON_LENGTH), mon.values);
            GSCUtilsMisc.copyToData(data[1], C.TRADING_POKEMON_OT_POS + (i * C.TRADING_NAME_LENGTH), mon.otName.values, C.TRADING_NAME_LENGTH);
            GSCUtilsMisc.copyToData(data[1], C.TRADING_POKEMON_NICKNAME_POS + (i * C.TRADING_NAME_LENGTH), mon.nickname.values, C.TRADING_NAME_LENGTH);
            if (mon.mail !== null && mon.mail !== undefined) {
                let realTml = C.TRADING_MAIL_LENGTH_OLD;
                let realTpmsp = C.TRADING_POKEMON_MAIL_SENDER_OLD_POS;
                if (isNewMailData) {
                    realTml = C.TRADING_MAIL_LENGTH;
                    realTpmsp = C.TRADING_POKEMON_MAIL_SENDER_POS;
                }
                GSCUtilsMisc.copyToData(data[3], C.TRADING_POKEMON_MAIL_POS + (i * realTml), mon.mail.getDataMail(isNewMailData));
                GSCUtilsMisc.copyToData(data[3], realTpmsp + (i * C.TRADING_MAIL_SENDER_LENGTH), mon.mail.getDataMailSender(), C.TRADING_MAIL_SENDER_LENGTH);
            }
        }
        U.createPatchesData(data[1], data[2], false, false);
        U.createPatchesData(data[3], data[3], true, false, !isNewMailData);
        return data;
    }

    readShort(data, pos) {
        return GSCUtilsMisc.readShort(data, pos);
    }

    writeShort(data, pos, val) {
        GSCUtilsMisc.writeShort(data, pos, val);
    }
}
