/**
 * GSCPokemonInfo - One Pokémon of the Gen 2 trading data: the 0x30-byte
 * struct plus its OT name, nickname and (when holding mail) mail data.
 */
import { GSCUtils, GSCUtilsMisc, pyIndex, pySlice } from './GSCUtils.js?v=103';
import { GSCTradingText, GSCTradingMailData } from './GSCTradingDataUtils.js?v=103';
import { PokemonNamesForGen } from './TextConversions.js?v=103';

export class GSCPokemonInfo {
    static POKEMON_DATA_LEN = 0x30;
    static OT_NAME_LEN = 0x0B;
    static NICKNAME_LEN = 0x0B;
    static MAIL_LEN = 0x41;
    static MAIL_LEN_OLD = 0x21;
    static SENDER_LEN = 0x0E;

    static SPECIES_POS = 0;
    static ITEM_POS = 1;
    static MOVES_POS = 2;
    static OT_ID_POS = 6;
    static EXP_POS = 8;
    static EVS_POS = 0x0B;
    static IVS_POS = 0x15;
    static PPS_POS = 0x17;
    static EGG_CYCLES_POS = 0x1B;
    static LEVEL_POS = 0x1F;
    static STATUS_POS = 0x20;
    static CURR_HP_POS = 0x22;
    static STATS_POS = 0x24;
    static UNOWN_SPECIES = 201;
    static REFERENCE_GEN = 2;
    static TRADE_FRIENDSHIP = 70;

    static FREE_VALUE_MOVES = 0x00;

    // [start, end) byte ranges compared by isEqual()
    static NO_MOVES_EQUALITY_RANGES = [[0, 2], [6, 0x17], [0x1B, 0x30]];
    static FULL_EQUALITY_RANGES = [[0, 0x30]];
    static ALL_LENGTHS = [0x30, 0xB, 0xB, 0x41, 0xE];
    static ALL_LENGTHS_OLD = [0x30, 0xB, 0xB, 0x21, 0xE];

    constructor(data, start, length = new.target.POKEMON_DATA_LEN) {
        if (data === null || data === undefined) {
            data = new Array(length).fill(0);
            start = 0;
        }
        this.values = pySlice(data, start, start + length);
        this.mail = null;
        this.otName = null;
        this.nickname = null;
        this.precalcedLengths = GSCUtilsMisc.calcDivideLengths(this.constructor.ALL_LENGTHS);
        this.precalcedLengthsOld = GSCUtilsMisc.calcDivideLengths(this.constructor.ALL_LENGTHS_OLD);
        this.utilsClass = this.getUtilsClass();
        this.textClass = this.getTextClass();
    }

    getUtilsClass() {
        return GSCUtils;
    }

    getTextClass() {
        return GSCTradingText;
    }

    get referenceGen() {
        return this.constructor.REFERENCE_GEN;
    }

    // ==================== Names and mail ====================

    addOtName(data, start) {
        this.otName = new this.textClass(data, start, this.constructor.OT_NAME_LEN);
    }

    setOtName(name) {
        this.otName = this.textClass.createFromString(name, this.constructor.OT_NAME_LEN);
    }

    getOtId() {
        return GSCUtilsMisc.readShort(this.values, this.constructor.OT_ID_POS);
    }

    setOtId(num) {
        GSCUtilsMisc.writeShort(this.values, this.constructor.OT_ID_POS, num);
    }

    addNickname(data, start) {
        this.nickname = new this.textClass(data, start, this.constructor.NICKNAME_LEN);
    }

    addMail(data, start, isNewMailData = true) {
        if (this.mail === null) this.mail = new GSCTradingMailData();
        const mailLenData = isNewMailData ? this.constructor.MAIL_LEN : this.constructor.MAIL_LEN_OLD;
        this.mail.setDataMail(pySlice(data, start, start + mailLenData));
    }

    addMailSender(data, start) {
        if (this.mail === null) this.mail = new GSCTradingMailData();
        this.mail.setDataMailSender(pySlice(data, start, start + this.constructor.SENDER_LEN));
    }

    /**
     * The game languages whose default name (species or egg) the nickname
     * still is, once that language's text transforms are undone.
     */
    getLanguagesForWhichNotNicknamed(isEgg) {
        const eol = this.utilsClass.END_OF_LINE;
        const out = [];
        for (const language of PokemonNamesForGen.ALL_LANGUAGES_LIST) {
            const nickname = { values: Array.from(this.nickname.values) };
            this.applyAllTextTransforms(nickname, language);
            const baseName = isEgg
                ? PokemonNamesForGen.getEggNameForGen(this.referenceGen, language)
                : PokemonNamesForGen.getPokemonNameForGen(this.getSpecies(), this.referenceGen, language);
            if (baseName === null || baseName === undefined) continue;
            const length = Math.max(baseName.length, nickname.values.length);
            let isEqual = true;
            for (let i = 0; i < length; i++) {
                const base = i < baseName.length ? baseName[i] : eol;
                if (base !== (i < nickname.values.length ? nickname.values[i] : eol)) {
                    isEqual = false;
                    break;
                }
                if (base === eol) break;
            }
            if (isEqual) out.push(language);
        }
        return out;
    }

    isNicknamed(language, isEgg) {
        return !this.getLanguagesForWhichNotNicknamed(isEgg).includes(language);
    }

    getNicknameGeneral(language) {
        return PokemonNamesForGen.convertGenericNameGeneralForGen(this.nickname.values, this.referenceGen, language);
    }

    getOtNameGeneral(language) {
        return PokemonNamesForGen.convertGenericNameGeneralForGen(this.otName.values, this.referenceGen, language);
    }

    setDefaultTrainerName(language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        this.addOtName(PokemonNamesForGen.getTrainerNameForGen(this.referenceGen, language), 0);
    }

    setDefaultNickname(language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        this.addNickname(PokemonNamesForGen.getPokemonNameForGen(this.getSpecies(), this.referenceGen, language), 0);
    }

    setEggNickname(language = PokemonNamesForGen.ENGLISH_LANGUAGE) {
        this.addNickname(PokemonNamesForGen.getEggNameForGen(this.referenceGen, language), 0);
    }

    hasMail() {
        return this.utilsClass.isItemMail(this.getItem());
    }

    // ==================== Struct fields ====================

    getSpecies() {
        return pyIndex(this.values, this.constructor.SPECIES_POS);
    }

    setSpecies(data) {
        GSCUtilsMisc.setItem(this.values, this.constructor.SPECIES_POS, data & 0xFF);
    }

    getItem() {
        return pyIndex(this.values, this.constructor.ITEM_POS);
    }

    setItem(data = 0) {
        GSCUtilsMisc.setItem(this.values, this.constructor.ITEM_POS, data & 0xFF);
    }

    /**
     * Moves the Pokémon learns at its current level (after an evolution).
     */
    learnableMoves() {
        const learnsets = this.utilsClass.learnsets;
        if (learnsets && learnsets.has(this.getSpecies())) {
            const entry = learnsets.get(this.getSpecies());
            if (entry.has(this.getLevel())) return entry.get(this.getLevel());
        }
        return null;
    }

    hasMoveIndex(move, start = 0) {
        for (let i = start; i < 4; i++) {
            if (this.getMove(i) === move) return i;
        }
        return 4;
    }

    hasMove(move) {
        return this.hasMoveIndex(move) !== 4;
    }

    freeMoveSlots() {
        const freeSlots = [];
        for (let i = 0; i < 4; i++) {
            if (this.getMove(i) === GSCPokemonInfo.FREE_VALUE_MOVES) freeSlots.push(i);
        }
        return freeSlots;
    }

    getMove(pos) {
        return pyIndex(this.values, this.constructor.MOVES_POS + pos);
    }

    setMove(pos, val, maxPp = true) {
        GSCUtilsMisc.setItem(this.values, this.constructor.MOVES_POS + pos, val);
        if (maxPp) this.setPp(pos, pyIndex(this.utilsClass.movesPpList, val));
    }

    // Defaults to the friendship a traded Pokémon gets
    setFriendship(val = null) {
        if (val === null || val === undefined) val = this.constructor.TRADE_FRIENDSHIP;
        GSCUtilsMisc.setItem(this.values, this.constructor.EGG_CYCLES_POS, val);
    }

    setHatchingCycles(val = 1) {
        GSCUtilsMisc.setItem(this.values, this.constructor.EGG_CYCLES_POS, val);
    }

    getHatchingCycles() {
        return pyIndex(this.values, this.constructor.EGG_CYCLES_POS);
    }

    setPp(pos, val) {
        GSCUtilsMisc.setItem(this.values, this.constructor.PPS_POS + pos, val);
    }

    getPp(pos) {
        return pyIndex(this.values, this.constructor.PPS_POS + pos);
    }

    getMaxPp(pos) {
        const ppUps = (this.getPp(pos) >> 6) & 3;
        const maxBasePp = pyIndex(this.utilsClass.movesPpList, this.getMove(pos));
        let ppIncrement = Math.floor(maxBasePp / 5);
        // Base-40 moves gain only 7 per PP Up
        if (maxBasePp === 40) ppIncrement -= 1;
        return maxBasePp + (ppIncrement * ppUps);
    }

    healMove(pos) {
        const ppUps = (this.getPp(pos) >> 6) & 3;
        this.setPp(pos, this.getMaxPp(pos) | (ppUps << 6));
    }

    healMoves() {
        for (let i = 0; i < 4; i++) this.healMove(i);
    }

    getLevel() {
        return pyIndex(this.values, this.constructor.LEVEL_POS);
    }

    setLevel(val) {
        GSCUtilsMisc.setItem(this.values, this.constructor.LEVEL_POS, val);
        this.setExp(this.utilsClass.getExpLevel(this.getSpecies(), val));
        this.updateStats();
    }

    getExp() {
        const pos = this.constructor.EXP_POS;
        return (pyIndex(this.values, pos) << 16) | (pyIndex(this.values, pos + 1) << 8) | pyIndex(this.values, pos + 2);
    }

    setExp(val) {
        const pos = this.constructor.EXP_POS;
        GSCUtilsMisc.setItem(this.values, pos, (val >> 0x10) & 0xFF);
        GSCUtilsMisc.setItem(this.values, pos + 1, (val >> 8) & 0xFF);
        GSCUtilsMisc.setItem(this.values, pos + 2, val & 0xFF);
    }

    /**
     * Recalculate the stats after an evolution or a level change.
     */
    updateStats() {
        const U = this.utilsClass;
        const oldMaxHps = this.getMaxHp();
        let oldCurrentHps = this.getCurrHp();
        for (let i = 0; i < U.NUM_STATS; i++) {
            GSCUtilsMisc.writeShort(this.values, this.constructor.STATS_POS + (i * 2),
                U.statCalculation(i, this.getSpecies(), this.getIvs(), this.getStatExp(), this.getLevel()));
        }
        const newMaxHps = this.getMaxHp();
        oldCurrentHps += newMaxHps - oldMaxHps;
        GSCUtilsMisc.writeShort(this.values, this.constructor.CURR_HP_POS, Math.min(Math.max(0, oldCurrentHps), newMaxHps));
    }

    getStatExp() {
        const ret = [0, 0, 0, 0, 0];
        for (let i = 0; i < 5; i++) ret[i] = GSCUtilsMisc.readShort(this.values, this.constructor.EVS_POS + (i * 2));
        return ret;
    }

    getIvs() {
        const ret = [0, 0, 0, 0];
        const pos = this.constructor.IVS_POS;
        const calcVal = [GSCUtilsMisc.readNybbles(pyIndex(this.values, pos)), GSCUtilsMisc.readNybbles(pyIndex(this.values, pos + 1))];
        for (let i = 0; i < 4; i++) ret[i] = calcVal[i >> 1][i & 1];
        return ret;
    }

    getUnownLetter() {
        const ivs = this.getIvs();
        let letterSum = 0;
        for (let i = 0; i < 4; i++) letterSum |= ((ivs[i] >> 1) & 3) << (2 * (4 - 1 - i));
        return Math.floor(letterSum / 10);
    }

    getCurrHp() {
        return GSCUtilsMisc.readShort(this.values, this.constructor.CURR_HP_POS);
    }

    setCurrHp(val) {
        GSCUtilsMisc.writeShort(this.values, this.constructor.CURR_HP_POS, val);
    }

    heal() {
        GSCUtilsMisc.writeShort(this.values, this.constructor.CURR_HP_POS, this.getMaxHp());
        GSCUtilsMisc.setItem(this.values, this.constructor.STATUS_POS, 0);
    }

    fullHeal() {
        this.heal();
        this.healMoves();
    }

    faint() {
        GSCUtilsMisc.writeShort(this.values, this.constructor.CURR_HP_POS, 0);
        GSCUtilsMisc.setItem(this.values, this.constructor.STATUS_POS, 0);
    }

    getMaxHp() {
        return GSCUtilsMisc.readShort(this.values, this.constructor.STATS_POS);
    }

    getStat(index) {
        return GSCUtilsMisc.readShort(this.values, this.constructor.STATS_POS + (index * 2));
    }

    setStat(index, val) {
        GSCUtilsMisc.writeShort(this.values, this.constructor.STATS_POS + (index * 2), val);
    }

    // ==================== Comparison ====================

    isEqual(other, weak = false, allValues = false) {
        const ranges = allValues ? this.constructor.FULL_EQUALITY_RANGES : this.constructor.NO_MOVES_EQUALITY_RANGES;
        for (const [start, end] of ranges) {
            for (let j = start; j < end; j++) {
                if (pyIndex(this.values, j) !== pyIndex(other.values, j)) return false;
            }
        }
        if (!this.areMovesAndPpSame(other)) return false;
        if (!weak) {
            if (!this.isTextEqual(other)) return false;
        }
        return true;
    }

    isTextEqual(other, doMail = true) {
        if (!(this.otName.valuesEqual(other.otName.values) && this.nickname.valuesEqual(other.nickname.values))) return false;
        if (doMail && this.hasMail()) {
            if (!(this.mail.dataMail.valuesEqual(other.mail.dataMail.values) && this.mail.dataSender.valuesEqual(other.mail.dataSender.values))) return false;
        }
        return true;
    }

    getSameMoves() {
        const pos = [];
        for (let i = 0; i < 4; i++) {
            const innerPos = [];
            for (let j = 0; j < 4; j++) {
                if (this.getMove(i) === this.getMove(j)) innerPos.push(i);
            }
            pos.push(innerPos);
        }
        return pos;
    }

    areMovesAndPpSame(other) {
        const correspondingIndexes = this.areMovesSame(other);
        if (correspondingIndexes === null) return false;
        const possiblePositions = this.getSameMoves();
        const foundPos = [];
        for (let i = 0; i < 4; i++) {
            let found = false;
            for (const j of possiblePositions[i]) {
                if (!found && !foundPos.includes(correspondingIndexes[j]) && this.getPp(i) === other.getPp(correspondingIndexes[j])) {
                    foundPos.push(correspondingIndexes[j]);
                    found = true;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    /**
     * @returns {number[]|null} where each move is in the other Pokémon,
     * null when the moves differ
     */
    areMovesSame(other) {
        const pos = [];
        for (let i = 0; i < 4; i++) {
            let properFound = false;
            let startIndex = 0;
            while (!properFound) {
                const index = other.hasMoveIndex(this.getMove(i), startIndex);
                if (index === 4) return null;
                if (pos.includes(index)) {
                    startIndex = index + 1;
                } else {
                    pos.push(index);
                    properFound = true;
                }
            }
        }
        return pos;
    }

    /**
     * Whether cleaning changed the Pokémon too much to accept it.
     */
    hasChangedSignificantly(raw) {
        if (this.getSpecies() !== raw.getSpecies()) return true;
        if (this.areMovesSame(raw) === null) return true;
        if (this.getLevel() !== raw.getLevel()) return true;
        return false;
    }

    // ==================== Korean/Japanese name protection ====================

    // Undo the special encodings injected for other languages' games
    applyAllTextTransformsToAll(language) {
        this.applyAllTextTransforms(this.otName, language);
        this.applyAllTextTransforms(this.nickname, language);
        if (this.hasMail()) {
            this.applyAllTextTransforms(this.mail.dataMail, language, true);
            this.applyAllTextTransforms(this.mail.dataSender, language, true);
        }
    }

    applyAllTextTransforms(textEntry, language, isMail = false) {
        this.applyTransformKorBadChars(textEntry, language);
        this.applyTransformProtectInternationalFromKor(textEntry, language, isMail);
        this.applyTransformProtectKoreanFromJpn(textEntry, language, isMail);
    }

    applyTransformKorBadChars(textEntry, language) {
        if (language === PokemonNamesForGen.KOREAN_LANGUAGE) return;
        const fromKor = this.utilsClass.badIdsTextSpecialFromKor;
        const values = textEntry.values;
        for (let i = 0; i < values.length; i++) {
            if (values[i] === this.utilsClass.END_OF_LINE) break;
            if (fromKor.has(values[i])) values[i] = fromKor.get(values[i]);
        }
    }

    applyTransformProtectInternationalFromKor(textEntry, language, isMail) {
        const U = this.utilsClass;
        if (language !== PokemonNamesForGen.KOREAN_LANGUAGE) return;
        if (isMail) return;
        if (pyIndex(textEntry.values, 0) !== U.KOREAN_SPECIAL_REPLACEMENT) return;

        const inChars = [];
        const outChars = [];
        const containerObj = { hasEncounteredEol: false, isKoreanSpecialWasJapaneseTruncated: false };
        for (let i = 1; i < textEntry.values.length; i++) {
            let inVal = textEntry.values[i];
            if (inVal === U.PROHIBITED_CHAR_REPLACEMENT) inVal = U.PROHIBITED_CHAR;
            inChars.push(inVal);
            const out = U.applyTextTransformProtectInternationalFromKoreanSpecial(inChars, containerObj);
            outChars.push(...out);
            if (out.includes(U.END_OF_LINE)) containerObj.hasEncounteredEol = true;
        }
        for (let i = 0; i < textEntry.values.length; i++) textEntry.values[i] = pyIndex(outChars, i);
    }

    applyTransformProtectKoreanFromJpn(textEntry, language, isMail) {
        const U = this.utilsClass;
        if (language === PokemonNamesForGen.KOREAN_LANGUAGE) return;
        if (isMail) return;
        if (pyIndex(textEntry.values, 0) !== U.KOREAN_PATCHED_SPECIAL_REPLACEMENT) return;

        const inChars = [];
        const outChars = [];
        for (let i = 1; i < textEntry.values.length; i++) {
            let inVal = textEntry.values[i];
            if (inVal === U.PROHIBITED_CHAR_REPLACEMENT) inVal = U.PROHIBITED_CHAR;
            inChars.push(inVal);
            outChars.push(...U.applyTextTransformProtectKoreanFromJpnSpecial(inChars));
        }
        for (let i = 0; i < textEntry.values.length; i++) textEntry.values[i] = pyIndex(outChars, i);
    }

    /**
     * Re-encode the names so the target game shows them unharmed. Needs the
     * names' language, so only possible with buffered data.
     */
    patchOutBadCharsForLanguageBufferedOnly(targetLanguage, checks, isEgg) {
        const U = this.utilsClass;
        if (targetLanguage === null || targetLanguage === undefined) return;

        const ownData = U.singleMonToData(this, isEgg);
        const retData = U.singleMonFromDataMultilanguage(checks, ownData);
        if (retData === null) return;
        const languageValue = retData[2];
        const isKorean2BytesValid = ((languageValue >>> U.KOREAN_LANGUAGE_2_BYTES_SPECIAL_LANGUAGE) & 1) !== 0;
        const validLanguagesList = U.convertLanguageIntToList(languageValue);
        const onlyLanguage = (language) => (validLanguagesList.length === 1) && (validLanguagesList[0] === language);

        // Valid Japanese is never 2-byte Korean
        if ((targetLanguage === PokemonNamesForGen.KOREAN_LANGUAGE) && onlyLanguage(PokemonNamesForGen.JAPANESE_LANGUAGE)) {
            U.patchOutBadCharsProtectKoreanFromJpnBufferedOnly(this.otName);
            U.patchOutBadCharsProtectKoreanFromJpnBufferedOnly(this.nickname);
        }

        if ((targetLanguage !== PokemonNamesForGen.KOREAN_LANGUAGE) && onlyLanguage(PokemonNamesForGen.KOREAN_LANGUAGE) && isKorean2BytesValid) {
            U.patchOutBadCharsProtectInternationalFromKoreanBufferedOnly(this.otName);
            U.patchOutBadCharsProtectInternationalFromKoreanBufferedOnly(this.nickname);
        }
    }

    // ==================== Serialization ====================

    /**
     * Struct + OT + nickname + mail + sender (zeros without mail), with the
     * 0x41-byte mail unless isNewMailData is false.
     */
    getData(isNewMailData = true) {
        const sources = [this.values, this.otName.values, this.nickname.values];
        const relevantLengths = isNewMailData ? this.precalcedLengths : this.precalcedLengthsOld;
        const hasMail = this.hasMail();
        const mailSources = hasMail ? [this.mail.getDataMail(isNewMailData), this.mail.getDataMailSender()] : [null, null];
        const data = new Array(relevantLengths[sources.length + mailSources.length]).fill(0);
        for (let i = 0; i < sources.length; i++) GSCUtilsMisc.copyToData(data, relevantLengths[i], sources[i]);
        if (hasMail) {
            for (let i = 0; i < mailSources.length; i++) GSCUtilsMisc.copyToData(data, relevantLengths[i + sources.length], mailSources[i]);
        }
        return data;
    }

    static setData(data, isNewMailData = true) {
        const mon = new GSCPokemonInfo(data, 0);
        const relevantLengths = isNewMailData ? mon.precalcedLengths : mon.precalcedLengthsOld;
        mon.addOtName(data, relevantLengths[1]);
        mon.addNickname(data, relevantLengths[2]);
        if (mon.hasMail()) {
            mon.addMail(data, relevantLengths[3], isNewMailData);
            mon.addMailSender(data, relevantLengths[4]);
        }
        return mon;
    }

    static fromData(data) {
        return this.setData(data, false);
    }

    static createFromScratch(species = 1, item = 0, level = 2, moves = [1, 2, 3, 4], otName = 'AAAAA', otId = 1, language = 0) {
        const mon = new this(null, 0);
        mon.setSpecies(species);
        mon.setItem(item);
        mon.setLevel(level);
        for (let i = 0; i < moves.length; i++) mon.setMove(i, moves[i]);
        mon.setDefaultNickname(language);
        mon.setOtName(otName);
        mon.setOtId(otId);
        mon.heal();
        return mon;
    }

    // ==================== Older names ====================

    getPP(pos) {
        return this.getPp(pos);
    }

    setPP(pos, val) {
        this.setPp(pos, val);
    }

    getMaxPP(pos) {
        return this.getMaxPp(pos);
    }

    getIVs() {
        return this.getIvs();
    }

    getPpTable() {
        return this.utilsClass.movesPpList;
    }

    readShort(pos) {
        return GSCUtilsMisc.readShort(this.values, pos);
    }

    writeShort(pos, val) {
        GSCUtilsMisc.writeShort(this.values, pos, val);
    }

    arraysEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
}
