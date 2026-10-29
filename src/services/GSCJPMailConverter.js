/**
 * GSCJPMailConverter - Converts the Gen 2 mail section between the
 * international layout and the Japanese one.
 *
 * new GSCJPMailConverter(checks): international side in the 0x41-byte mail
 * layout (0x241 section). Mails from other languages keep their language
 * marker and the bytes Japanese has no room for packed into 7-bit
 * characters, so they survive the round trip.
 * new GSCJPMailConverter(): the 0x21-byte layout (0x181 section), with a
 * plain byte-for-byte conversion.
 */
import { GSCUtils, GSCUtilsLoaders, GSCUtilsMisc, pyIndex, pySlice } from './GSCUtils.js?v=98';
import { GSCTradingMailData } from './GSCTradingDataUtils.js?v=98';
import { PokemonNamesForGen } from './TextConversions.js?v=98';

const DATA_FILES = {
    toJp: 'mail_conversion_table_en_to_jp.bin',
    toInt: 'mail_conversion_table_jp_to_en.bin',
    toIntOld: 'mail_conversion_table_jp_to_en_int.bin',
    mailChecks: 'mail_checks_jp.bin',
    charsToJpEn: 'mail_en_char_conv_table.bin',
    charsToJpGerFre: 'mail_ger_fre_char_conv_table.bin',
    charsToJpItaSpa: 'mail_ita_spa_char_conv_table.bin',
};

const positions = (base, step) => [0, 1, 2, 3, 4, 5].map((i) => base + (i * step));

export class GSCJPMailConverter {
    static BASE_PATH = '/data/gsc/';

    static END_OF_LINE = 0x50;
    static EOL_KOR_START_MSG_DATA_REPLACEMENT = 0x2C;
    static REFERENCE_GEN = 2;
    static ID_LANGUAGE_CHAR = 0x63;
    static EXTRA_DISTANCE_JP = 5;
    static EXTRA_DISTANCE_INT = 0x0A;
    static OT_NAME_REAL_LEN_INT = 7;
    static OT_NAME_REAL_LEN_JPN = 5;
    static LANGUAGE_SENDER_POS_INT = 0x8;
    static JPN_MESSAGE_LEN = 0x21;
    static SENDER_JPN_LEN = 0x09; // OT name (5), OT ID (2), species, mail type
    static FULL_MAIL_JP_LEN = 0x21 + 0x09;
    static BASE_INT_MAIL_LEN = 0x21;
    static BASE_KOR_MAIL_LEN = 0x41;
    static MAIL_LEN = 0x41;
    static MAIL_LEN_OLD = 0x21;
    static SENDER_INT_LEN = 0x0E;

    static MAIL_POS_JP = positions(0, 0x2A);
    static MAIL_POS_INT = positions(0, 0x41);
    static SENDER_POS_JP = positions(0x21, 0x2A);
    static SENDER_POS_INT = positions(0x41 * 6, 0x0E);
    static MAIL_POS_INT_OLD = positions(0, 0x21);
    static SENDER_POS_INT_OLD = positions(0x21 * 6, 0x0E);

    static tables = null;

    /**
     * Load the conversion tables (shared by every instance).
     */
    static async load() {
        if (this.tables) return true;
        await PokemonNamesForGen.load();
        const entries = await Promise.all(Object.entries(DATA_FILES).map(async ([key, name]) => {
            const response = await fetch(GSCJPMailConverter.BASE_PATH + name);
            if (!response.ok) throw new Error(`Failed to load ${name}: ${response.status}`);
            return [key, Array.from(new Uint8Array(await response.arrayBuffer()))];
        }));
        this.tables = Object.fromEntries(entries);
        return true;
    }

    /**
     * @param checks - the GSCChecks whose check functions run the Japanese
     * mail section (mailChecker)
     * @param options.isOldMailData - international side in the 0x21-byte
     * layout; defaults to true without checks
     */
    constructor(checks = null, options = {}) {
        this.checks = checks;
        this.isOldMailData = options.isOldMailData ?? (checks === null);
        this.utilsClass = GSCUtils;
        this.loaded = false;

        this.mailConvPos = -1;
        this.senderConvPos = -1;
        this.singleMailPos = 0;
        this.singleSenderPos = 0;
        this.extraConversionPos = -1;
        this.mailConverterPos = null;
        this.senderConverterPos = null;
        this.extraDistance = 0;

        this.conversionFunctions = [
            (d) => this.doZero(d),
            (d) => this.mailConversion(d),
            (d) => this.senderConversion(d),
            (d) => this.extraConversion(d),
            (d) => this.doFf(d),
            (d) => this.do20(d),
            (d) => this.startMailConversion(d),
            (d) => this.doEol(d),
            (d) => this.startSenderConversion(d),
        ];

        if (GSCJPMailConverter.tables) this.buildTables();
    }

    async load() {
        if (this.loaded) return;
        await GSCJPMailConverter.load();
        this.buildTables();
    }

    isLoaded() {
        return this.loaded;
    }

    buildTables() {
        const t = GSCJPMailConverter.tables;
        this.mailConversionTableJp = GSCUtilsLoaders.prepareFunctionsMap(t.toJp, this.conversionFunctions);
        this.mailConversionTableInt = GSCUtilsLoaders.prepareFunctionsMap(this.isOldMailData ? t.toIntOld : t.toInt, this.conversionFunctions);
        this.mailChecker = this.checks ? GSCUtilsLoaders.prepareFunctionsMap(t.mailChecks, this.checks.checkFunctions) : t.mailChecks;
        this.charsToJpEnTable = t.charsToJpEn;
        this.charsToJpGerFreTable = t.charsToJpGerFre;
        this.charsToJpItaSpaTable = t.charsToJpItaSpa;
        this.charsFromJpEnTable = this.generateReverseDictFromTable(this.charsToJpEnTable);
        this.charsFromJpGerFreTable = this.generateReverseDictFromTable(this.charsToJpGerFreTable);
        this.charsFromJpItaSpaTable = this.generateReverseDictFromTable(this.charsToJpItaSpaTable);
        this.loaded = true;
    }

    getMailChecker() {
        return this.mailChecker;
    }

    generateReverseDictFromTable(table) {
        const out = new Map();
        for (let i = 0; i < table.length; i++) {
            const elem = table[i];
            if ((elem & 0x80) !== 0) continue;
            out.set(elem, i);
        }
        return out;
    }

    // ==================== Mail language ====================

    getMailLanguageFromIntProvided(languageData) {
        return GSCTradingMailData.getIntMailDataLanguage(languageData, GSCJPMailConverter.REFERENCE_GEN);
    }

    getMailLanguageFromIntMailData(messageData, authorData) {
        const pos = GSCJPMailConverter.LANGUAGE_SENDER_POS_INT;
        return this.getMailLanguageFromIntProvided(pySlice(authorData, pos, pos + 2));
    }

    getMailLanguageFromInt(data, index) {
        const pos = GSCJPMailConverter.SENDER_POS_INT[index] + GSCJPMailConverter.LANGUAGE_SENDER_POS_INT;
        return this.getMailLanguageFromIntProvided(pySlice(data, pos, pos + 2));
    }

    // Japanese mails carry the language in their first byte
    getMailLanguageFromJpProvided(languageData) {
        return languageData - GSCJPMailConverter.ID_LANGUAGE_CHAR + PokemonNamesForGen.JAPANESE_LANGUAGE;
    }

    getMailLanguageFromJpMailData(messageData, authorData) {
        return this.getMailLanguageFromJpProvided(pyIndex(messageData, 0));
    }

    getMailLanguageFromJp(data, index) {
        return this.getMailLanguageFromJpProvided(pyIndex(data, GSCJPMailConverter.MAIL_POS_INT[index]));
    }

    getMailLanguageToJp(mailLanguage) {
        return GSCJPMailConverter.ID_LANGUAGE_CHAR + (mailLanguage - PokemonNamesForGen.JAPANESE_LANGUAGE);
    }

    prepareByteAlteredIntMailData(currBitExplored, bitsToSave) {
        let bitToPreserve = 0;
        if (currBitExplored < bitsToSave.length) {
            bitToPreserve = bitsToSave[currBitExplored];
            currBitExplored += 1;
        }
        return [bitToPreserve, currBitExplored];
    }

    getFromIntConvTable(mailLanguage) {
        const L = PokemonNamesForGen;
        if ((mailLanguage === L.ITALIAN_LANGUAGE) || (mailLanguage === L.SPANISH_LANGUAGE)) return this.charsToJpItaSpaTable;
        if ((mailLanguage === L.GERMAN_LANGUAGE) || (mailLanguage === L.FRENCH_LANGUAGE)) return this.charsToJpGerFreTable;
        return this.charsToJpEnTable;
    }

    getToIntConvTable(mailLanguage) {
        const L = PokemonNamesForGen;
        if ((mailLanguage === L.ITALIAN_LANGUAGE) || (mailLanguage === L.SPANISH_LANGUAGE)) return this.charsFromJpItaSpaTable;
        if ((mailLanguage === L.GERMAN_LANGUAGE) || (mailLanguage === L.FRENCH_LANGUAGE)) return this.charsFromJpGerFreTable;
        return this.charsFromJpEnTable;
    }

    static getConvertedByte(conversionTable, data) {
        return pyIndex(conversionTable, data) & 0x7F;
    }

    static getReconvertedByte(reconversionDict, data) {
        if (reconversionDict.has(data)) return reconversionDict.get(data);
        return 0;
    }

    // ==================== International -> Japanese ====================

    /**
     * @returns {number[][]} [message, author] as the Japanese side stores them
     */
    alterIntMailDataProvided(messageData, authorData) {
        const C = GSCJPMailConverter;
        const L = PokemonNamesForGen;
        const mailLanguage = this.getMailLanguageFromIntMailData(messageData, authorData);
        if (mailLanguage === L.JAPANESE_LANGUAGE) return [pySlice(messageData, 0), pySlice(authorData, 0)];
        if (mailLanguage === L.KOREAN_LANGUAGE) {
            // Nothing else of a Korean mail fits: mark it and move on
            const newMessageData = pySlice(messageData, 0);
            GSCUtilsMisc.setItem(newMessageData, 0, this.getMailLanguageToJp(mailLanguage));
            return [newMessageData, pySlice(authorData, 0)];
        }

        const conversionTable = this.getFromIntConvTable(mailLanguage);

        const bytesToPreserve = [pyIndex(messageData, 0), pyIndex(messageData, 3), pyIndex(authorData, C.OT_NAME_REAL_LEN_JPN), pyIndex(authorData, C.OT_NAME_REAL_LEN_JPN + 1)];
        const bitsToSave = [];
        for (const byte of bytesToPreserve) {
            const convertedByte = C.getConvertedByte(conversionTable, byte);
            // Every language has less than 128 input characters, so each
            // character leaves its top bit free to carry these bytes
            for (let j = 0; j < 7; j++) bitsToSave.push(((convertedByte >> j) & 1) << 7);
        }
        let currBitExplored = 0;
        let bitToPreserve;

        // Language marker, 2 bytes as they are, then an EOL: control codes
        // can't break what follows
        const newMessageData = [this.getMailLanguageToJp(mailLanguage)];
        for (let i = 1; i < 3; i++) newMessageData.push(pyIndex(messageData, i));
        newMessageData.push(this.utilsClass.END_OF_LINE);

        for (let i = 4; i < 16; i++) {
            [bitToPreserve, currBitExplored] = this.prepareByteAlteredIntMailData(currBitExplored, bitsToSave);
            newMessageData.push(C.getConvertedByte(conversionTable, pyIndex(messageData, i)) | bitToPreserve);
        }

        // The newline stays
        newMessageData.push(pyIndex(messageData, 16));

        for (let i = 17; i < C.JPN_MESSAGE_LEN; i++) {
            [bitToPreserve, currBitExplored] = this.prepareByteAlteredIntMailData(currBitExplored, bitsToSave);
            newMessageData.push(C.getConvertedByte(conversionTable, pyIndex(messageData, i)) | bitToPreserve);
        }

        return [newMessageData, authorData];
    }

    alterIntMailData(data, index) {
        const C = GSCJPMailConverter;
        const mailLanguage = this.getMailLanguageFromInt(data, index);
        if (mailLanguage === PokemonNamesForGen.JAPANESE_LANGUAGE) return data;

        const mailPos = C.MAIL_POS_INT[index];
        const senderPos = C.SENDER_POS_INT[index];
        const messageData = pySlice(data, mailPos, mailPos + C.BASE_INT_MAIL_LEN);
        const authorData = pySlice(data, senderPos, senderPos + C.SENDER_INT_LEN);

        const [newMessageData, newAuthorData] = this.alterIntMailDataProvided(messageData, authorData);

        for (let i = 0; i < newMessageData.length; i++) GSCUtilsMisc.setItem(data, mailPos + i, newMessageData[i]);
        for (let i = 0; i < newAuthorData.length; i++) GSCUtilsMisc.setItem(data, senderPos + i, newAuthorData[i]);
        return data;
    }

    preprocessIntMail(data) {
        for (let i = 0; i < 6; i++) data = this.alterIntMailData(data, i);
        return data;
    }

    preprocessJpMail(data) {
        return data;
    }

    // ==================== Japanese -> International ====================

    /**
     * @returns {number[][]} [message, author] as the international side
     * stores them
     */
    alterJpMailDataProvided(messageData, authorData) {
        const C = GSCJPMailConverter;
        const L = PokemonNamesForGen;
        const newAuthorData = pySlice(authorData, 0);
        const set = (i, v) => GSCUtilsMisc.setItem(newAuthorData, i, v);
        const mailLanguage = this.getMailLanguageFromJpMailData(messageData, authorData);
        if ((mailLanguage === L.JAPANESE_LANGUAGE) || !L.SORTED_LANGUAGES_LIST.includes(mailLanguage)) {
            set(C.LANGUAGE_SENDER_POS_INT, 0x84); // E
            set(C.LANGUAGE_SENDER_POS_INT + 1, 0x89); // J
            return [pySlice(messageData, 0), newAuthorData];
        }
        if (mailLanguage === L.KOREAN_LANGUAGE) {
            const newMessageData = pySlice(messageData, 0);
            GSCUtilsMisc.setItem(newMessageData, 0, C.EOL_KOR_START_MSG_DATA_REPLACEMENT);
            set(C.OT_NAME_REAL_LEN_JPN, C.END_OF_LINE);
            set(C.OT_NAME_REAL_LEN_JPN + 1, C.END_OF_LINE);
            set(C.OT_NAME_REAL_LEN_JPN + 2, C.END_OF_LINE);
            set(C.LANGUAGE_SENDER_POS_INT, 0x84); // E
            set(C.LANGUAGE_SENDER_POS_INT + 1, 0x8A); // K
            return [newMessageData, newAuthorData];
        }

        const reconversionTable = this.getToIntConvTable(mailLanguage);

        const languageDataToSet = GSCTradingMailData.getMailLanguageDataForLanguage(mailLanguage, C.REFERENCE_GEN);
        for (let i = 0; i < languageDataToSet.length; i++) set(C.LANGUAGE_SENDER_POS_INT + i, languageDataToSet[i]);

        // Bytes 0 and 3 come back from the packed bits below
        const newMessageData = [0];
        for (let i = 1; i < 3; i++) newMessageData.push(pyIndex(messageData, i));
        newMessageData.push(0);

        const bitsPreserved = [];
        for (let i = 4; i < 16; i++) {
            bitsPreserved.push((pyIndex(messageData, i) >> 7) & 1);
            newMessageData.push(C.getReconvertedByte(reconversionTable, messageData[i] & 0x7F));
        }

        newMessageData.push(pyIndex(messageData, 16));

        for (let i = 17; i < C.JPN_MESSAGE_LEN; i++) {
            bitsPreserved.push((pyIndex(messageData, i) >> 7) & 1);
            newMessageData.push(C.getReconvertedByte(reconversionTable, messageData[i] & 0x7F));
        }

        const bytesPreservedConverted = [];
        for (let i = 0; i < bitsPreserved.length; i++) {
            if ((i % 7) === 0) bytesPreservedConverted.push(0);
            bytesPreservedConverted[Math.floor(i / 7)] |= (bitsPreserved[i] << (i % 7));
        }

        newMessageData[0] = C.getReconvertedByte(reconversionTable, bytesPreservedConverted[0]);
        newMessageData[3] = C.getReconvertedByte(reconversionTable, bytesPreservedConverted[1]);
        set(C.OT_NAME_REAL_LEN_JPN, C.getReconvertedByte(reconversionTable, bytesPreservedConverted[2]));
        set(C.OT_NAME_REAL_LEN_JPN + 1, C.getReconvertedByte(reconversionTable, bytesPreservedConverted[3]));

        return [newMessageData, newAuthorData];
    }

    alterJpMailData(data, index) {
        const C = GSCJPMailConverter;
        const L = PokemonNamesForGen;
        const mailPos = C.MAIL_POS_INT[index];
        const senderPos = C.SENDER_POS_INT[index];
        const mailLanguage = this.getMailLanguageFromJp(data, index);
        if ((mailLanguage === L.JAPANESE_LANGUAGE) || !L.SORTED_LANGUAGES_LIST.includes(mailLanguage)) {
            GSCUtilsMisc.setItem(data, senderPos + C.LANGUAGE_SENDER_POS_INT, 0x84); // E
            GSCUtilsMisc.setItem(data, senderPos + C.LANGUAGE_SENDER_POS_INT + 1, 0x89); // J
            return data;
        }

        const messageData = pySlice(data, mailPos, mailPos + C.BASE_INT_MAIL_LEN);
        const authorData = pySlice(data, senderPos, senderPos + C.SENDER_INT_LEN);

        const [newMessageData, newAuthorData] = this.alterJpMailDataProvided(messageData, authorData);

        for (let i = 0; i < newMessageData.length; i++) GSCUtilsMisc.setItem(data, mailPos + i, newMessageData[i]);
        for (let i = 0; i < newAuthorData.length; i++) GSCUtilsMisc.setItem(data, senderPos + i, newAuthorData[i]);
        return data;
    }

    postprocessIntMail(data) {
        for (let i = 0; i < 6; i++) data = this.alterJpMailData(data, i);
        return data;
    }

    postprocessJpMail(data) {
        return data;
    }

    // ==================== Section conversion ====================

    /**
     * International mail section (patches decoded) -> Japanese one. In the
     * 0x41-byte layout the input is altered in place as well.
     */
    convertToJp(data) {
        const C = GSCJPMailConverter;
        if (this.isOldMailData) {
            this.mailConverterPos = C.MAIL_POS_INT_OLD;
            this.senderConverterPos = C.SENDER_POS_INT_OLD;
            this.extraDistance = C.EXTRA_DISTANCE_INT;
            return new Uint8Array(this.convert(data, this.mailConversionTableJp));
        }
        data = this.preprocessIntMail(data);
        this.mailConverterPos = C.MAIL_POS_INT;
        this.senderConverterPos = C.SENDER_POS_INT;
        this.extraDistance = C.EXTRA_DISTANCE_INT;
        const outData = this.convert(data, this.mailConversionTableJp);
        return this.postprocessJpMail(outData);
    }

    /**
     * Japanese mail section (patches decoded) -> international one.
     */
    convertToInt(data) {
        const C = GSCJPMailConverter;
        if (this.isOldMailData) {
            this.mailConverterPos = C.MAIL_POS_JP;
            this.senderConverterPos = C.SENDER_POS_JP;
            this.extraDistance = C.EXTRA_DISTANCE_JP;
            return new Uint8Array(this.convert(data, this.mailConversionTableInt));
        }
        data = this.preprocessJpMail(data);
        this.mailConverterPos = C.MAIL_POS_JP;
        this.senderConverterPos = C.SENDER_POS_JP;
        this.extraDistance = C.EXTRA_DISTANCE_JP;
        const outData = this.convert(data, this.mailConversionTableInt);
        return this.postprocessIntMail(outData);
    }

    convert(toConvert, converter) {
        this.mailConvPos = -1;
        this.senderConvPos = -1;
        const ret = new Array(converter.length).fill(0);
        for (let i = 0; i < converter.length; i++) ret[i] = converter[i](toConvert);
        return ret;
    }

    doZero(data) {
        return 0;
    }

    mailConversion(data) {
        this.singleMailPos += 1;
        return pyIndex(data, pyIndex(this.mailConverterPos, this.mailConvPos) + this.singleMailPos);
    }

    senderConversion(data) {
        this.singleSenderPos += 1;
        return pyIndex(data, pyIndex(this.senderConverterPos, this.senderConvPos) + this.singleSenderPos);
    }

    extraConversion(data) {
        this.extraConversionPos += 1;
        return pyIndex(data, pyIndex(this.senderConverterPos, this.senderConvPos) + this.extraDistance + this.extraConversionPos);
    }

    startMailConversion(data) {
        this.mailConvPos += 1;
        this.singleMailPos = 0;
        return pyIndex(data, pyIndex(this.mailConverterPos, this.mailConvPos) + this.singleMailPos);
    }

    startSenderConversion(data) {
        this.senderConvPos += 1;
        this.singleSenderPos = 0;
        this.extraConversionPos = -1;
        return pyIndex(data, pyIndex(this.senderConverterPos, this.senderConvPos) + this.singleSenderPos);
    }

    doFf(data) {
        return 0xFF;
    }

    doEol(data) {
        return GSCJPMailConverter.END_OF_LINE;
    }

    do20(data) {
        return 0x20;
    }
}
