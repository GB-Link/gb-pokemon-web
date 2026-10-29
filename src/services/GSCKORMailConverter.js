/**
 * GSCKORMailConverter - Converts the Gen 2 mail section between the
 * Korean games and the international 0x41-byte mail layout.
 *
 * Korean mails become a packed, checksummed form that international and
 * Japanese games can carry unharmed (a game with shorter mails may cut its
 * tail, which only drops the last character). International mails get a
 * marker, their language and the bits Korean would mangle, so they come back
 * as they were.
 */
import { GSCUtils, GSCUtilsMisc, pyIndex, pySlice, pyListEquals } from './GSCUtils.js?v=100';
import { GSCTradingMailData } from './GSCTradingDataUtils.js?v=100';
import { PokemonNamesForGen } from './TextConversions.js?v=100';

function check(condition) {
    if (!condition) throw new Error('AssertionError');
}

const positions = (base, step) => [0, 1, 2, 3, 4, 5].map((i) => base + (i * step));

export class GSCKORMailConverter {
    static END_OF_LINE = 0x50;
    static NEWLINE = 0x4E;
    static NEWLINE_KOR = 0x59;
    static PROHIBITED_CHAR = 0xFE;
    static PROHIBITED_CHAR_REPLACEMENT = 0x2D;
    static EOL_KOR_START_MSG_DATA_REPLACEMENT = 0x2C;

    static REFERENCE_GEN = 2;
    static ID_LANGUAGE_CHAR = 0x63;
    static OT_NAME_REAL_LEN_JPN = 5;
    static OT_NAME_REAL_LEN_INT = 7;
    static OT_NAME_REAL_LEN_KOR = 10; // 5 Korean characters
    static LANGUAGE_SENDER_POS_INT = 0x8;
    static MAIL_ITEM_MON_OT_INFO_SENDER_POS_INT = 0xA;
    static BASE_KOR_MAIL_NEWLINE_POS = 0x20;
    static BASE_INT_MAIL_NEWLINE_POS = 0x10;
    static FULL_CONVERTED_KOR_MAIL_LEN = 63; // Down from the 85 bytes of a Korean mail
    static POS_LAST_FIRST_BYTES_KOR_CONV_INT = -2;
    static POS_HALF_IN_CORR_BYTE_KOR_CONV_INT = 34;
    static BASE_INT_MAIL_LEN = 0x21;
    static BASE_KOR_MAIL_LEN = 0x41;
    static KOR_INT_MAIL_NON_TRUNCATED_LANGUAGE_MARKER = [0x68, 0x83, 0x73, 0xA0];
    static INT_KOR_MAIL_LANGUAGE_MARKER = [0x88, 0x8D, 0x93, 0x00];
    static INT_KOR_MAIL_CORR_BITS_LEN = Math.floor((0x21 + 7 + 6) / 7);
    static INT_KOR_MAIL_LANGUAGE_DUP_POS = 0x22;
    static INT_KOR_MAIL_CORR_BITS_POS = 0x24;
    static INT_KOR_MAIL_LANGUAGE_MARKER_POS = 0x24 + Math.floor((0x21 + 7 + 6) / 7);
    static INT_KOR_MAIL_CHECKSUM_POS = 0x41 - 2; // 6 bits per byte, 12 bits total
    static NUM_VALID_USER_INPUT_TABLES = 0xB;
    static MAIL_LEN = 0x41;
    static SENDER_INT_LEN = 0xE;
    static MAIL_POS_INT = positions(0, 0x41);
    static SENDER_POS_INT = positions(0x41 * 6, 0xE);

    constructor(checks = null) {
        this.checks = checks;
        this.utilsClass = GSCUtils;
    }

    getMailLanguageFromIntProvided(languageData) {
        return GSCTradingMailData.getIntMailDataLanguage(languageData, GSCKORMailConverter.REFERENCE_GEN);
    }

    getMailLanguageFromIntMailData(messageData, authorData) {
        const pos = GSCKORMailConverter.LANGUAGE_SENDER_POS_INT;
        return this.getMailLanguageFromIntProvided(pySlice(authorData, pos, pos + 2));
    }

    getMailLanguageFromInt(data, index) {
        const pos = GSCKORMailConverter.SENDER_POS_INT[index] + GSCKORMailConverter.LANGUAGE_SENDER_POS_INT;
        return this.getMailLanguageFromIntProvided(pySlice(data, pos, pos + 2));
    }

    static getChecksumOfData(checksummableData) {
        let checksum = 0;
        for (let i = 0; i < checksummableData.length; i++) checksum += checksummableData[i] * (i % 2 ? 0x100 : 1);
        return checksum;
    }

    getMailLanguageKorChecksum(messageData, authorData) {
        const C = GSCKORMailConverter;
        return C.getChecksumOfData(pySlice(authorData, 0, C.MAIL_ITEM_MON_OT_INFO_SENDER_POS_INT).concat(pySlice(messageData, 0, C.INT_KOR_MAIL_CHECKSUM_POS)));
    }

    /**
     * Korean, unless this Korean-side mail is a marked international one.
     */
    getMailLanguageFromKorMailData(messageData, authorData) {
        const C = GSCKORMailConverter;
        const KOREAN = PokemonNamesForGen.KOREAN_LANGUAGE;
        if (pyIndex(messageData, C.BASE_INT_MAIL_LEN) !== C.END_OF_LINE) return KOREAN;
        if (pyIndex(authorData, C.OT_NAME_REAL_LEN_INT) !== C.END_OF_LINE) return KOREAN;
        if ((pyIndex(messageData, C.INT_KOR_MAIL_LANGUAGE_DUP_POS) !== pyIndex(authorData, C.LANGUAGE_SENDER_POS_INT))
            || (pyIndex(messageData, C.INT_KOR_MAIL_LANGUAGE_DUP_POS + 1) !== pyIndex(authorData, C.LANGUAGE_SENDER_POS_INT + 1))) {
            return KOREAN;
        }
        for (let i = 0; i < C.INT_KOR_MAIL_LANGUAGE_MARKER.length; i++) {
            if (pyIndex(messageData, C.INT_KOR_MAIL_LANGUAGE_MARKER_POS + i) !== C.INT_KOR_MAIL_LANGUAGE_MARKER[i]) return KOREAN;
        }
        const checksum = this.getMailLanguageKorChecksum(messageData, authorData);
        let checksumByte1 = pyIndex(messageData, C.INT_KOR_MAIL_CHECKSUM_POS) & 0x7F;
        let checksumByte2 = pyIndex(messageData, C.INT_KOR_MAIL_CHECKSUM_POS + 1) & 0x7F;
        if (messageData[C.INT_KOR_MAIL_CHECKSUM_POS] === C.PROHIBITED_CHAR_REPLACEMENT) checksumByte1 = C.PROHIBITED_CHAR & 0x7F;
        if (messageData[C.INT_KOR_MAIL_CHECKSUM_POS + 1] === C.PROHIBITED_CHAR_REPLACEMENT) checksumByte2 = C.PROHIBITED_CHAR & 0x7F;
        const readChecksum = checksumByte1 | (checksumByte2 << 7);
        if ((checksum & 0x3FFF) !== readChecksum) return KOREAN;
        return this.getMailLanguageFromIntMailData(messageData, authorData);
    }

    getMailLanguageFromKor(data, index) {
        const C = GSCKORMailConverter;
        return this.getMailLanguageFromKorMailData(
            pySlice(data, C.MAIL_POS_INT[index], C.MAIL_POS_INT[index] + C.MAIL_LEN),
            pySlice(data, C.SENDER_POS_INT[index], C.SENDER_POS_INT[index] + C.SENDER_INT_LEN));
    }

    // ==================== International -> Korean ====================

    alterIntMailDataProvidedNotKor(messageData, authorData) {
        const C = GSCKORMailConverter;
        const newAuthorData = pySlice(authorData, 0);
        const newMessageData = pySlice(messageData, 0);
        while (newMessageData.length < C.BASE_KOR_MAIL_LEN) newMessageData.push(C.END_OF_LINE);

        GSCUtilsMisc.setItem(newMessageData, C.BASE_INT_MAIL_LEN, C.END_OF_LINE);
        GSCUtilsMisc.setItem(newAuthorData, C.OT_NAME_REAL_LEN_INT, C.END_OF_LINE);

        // Language and marker of an international mail
        newMessageData[C.INT_KOR_MAIL_LANGUAGE_DUP_POS] = pyIndex(authorData, C.LANGUAGE_SENDER_POS_INT);
        newMessageData[C.INT_KOR_MAIL_LANGUAGE_DUP_POS + 1] = pyIndex(authorData, C.LANGUAGE_SENDER_POS_INT + 1);
        for (let i = 0; i < C.INT_KOR_MAIL_LANGUAGE_MARKER.length; i++) {
            newMessageData[C.INT_KOR_MAIL_LANGUAGE_MARKER_POS + i] = C.INT_KOR_MAIL_LANGUAGE_MARKER[i];
        }

        // Korean would mangle bytes below 0x70: move them up, remember which
        const corrBits = [];
        for (let i = 0; i < C.OT_NAME_REAL_LEN_INT; i++) {
            let toAdd = 0;
            if (pyIndex(newAuthorData, i) === C.END_OF_LINE) {
                // Kept
            } else if (newAuthorData[i] < 0x70) {
                toAdd = 1;
                newAuthorData[i] |= 0x80;
            }
            corrBits.push(toAdd);
        }
        for (let i = 0; i < C.BASE_INT_MAIL_LEN; i++) {
            let toAdd = 0;
            if (newMessageData[i] === C.END_OF_LINE) {
                // Kept
            } else if ((newMessageData[i] === C.NEWLINE) || (newMessageData[i] === C.NEWLINE_KOR)) {
                newMessageData[i] = C.NEWLINE_KOR;
            } else if (newMessageData[i] < 0x70) {
                toAdd = 1;
                newMessageData[i] |= 0x80;
            }
            corrBits.push(toAdd);
        }

        const corrBytes = [];
        for (let i = 0; i < corrBits.length; i++) {
            if (i % 7 === 0) corrBytes.push(0x80);
            corrBytes[Math.floor(i / 7)] |= corrBits[i] << (i % 7);
        }

        for (let i = 0; i < corrBytes.length; i++) {
            let toAdd = corrBytes[i];
            if (toAdd === C.PROHIBITED_CHAR) toAdd = C.PROHIBITED_CHAR_REPLACEMENT;
            newMessageData[C.INT_KOR_MAIL_CORR_BITS_POS + i] = toAdd;
        }

        const checksum = this.getMailLanguageKorChecksum(newMessageData, newAuthorData);
        let checksumByte1 = (checksum & 0x7F) | 0x80;
        let checksumByte2 = ((checksum >> 7) & 0x7F) | 0x80;
        if (checksumByte1 === C.PROHIBITED_CHAR) checksumByte1 = C.PROHIBITED_CHAR_REPLACEMENT;
        if (checksumByte2 === C.PROHIBITED_CHAR) checksumByte2 = C.PROHIBITED_CHAR_REPLACEMENT;
        newMessageData[C.INT_KOR_MAIL_CHECKSUM_POS] = checksumByte1;
        newMessageData[C.INT_KOR_MAIL_CHECKSUM_POS + 1] = checksumByte2;

        return [newMessageData, newAuthorData];
    }

    /**
     * Whether a game with shorter mails cut the packed tail.
     * Restores 0xFE in postIntMailDataBytes when it was not cut.
     */
    determineHasBeenTruncatedAndProcessData(newTotalMessageData, postIntMailDataBytes, messageData, endOfPostIntMailData) {
        const C = GSCKORMailConverter;
        const hasBeenTruncated = pyIndex(postIntMailDataBytes, 0) === this.utilsClass.END_OF_LINE;
        if (hasBeenTruncated) return hasBeenTruncated;

        for (let i = 0; i < postIntMailDataBytes.length; i++) {
            if (postIntMailDataBytes[i] === C.PROHIBITED_CHAR_REPLACEMENT) postIntMailDataBytes[i] = C.PROHIBITED_CHAR;
        }
        const markerLen = C.KOR_INT_MAIL_NON_TRUNCATED_LANGUAGE_MARKER.length;
        const metadataNonTruncatedBytes = pySlice(messageData, endOfPostIntMailData, endOfPostIntMailData + markerLen + 2);
        for (let i = 0; i < metadataNonTruncatedBytes.length; i++) {
            if (metadataNonTruncatedBytes[i] === C.PROHIBITED_CHAR_REPLACEMENT) metadataNonTruncatedBytes[i] = C.PROHIBITED_CHAR;
        }

        if (!pyListEquals(metadataNonTruncatedBytes.slice(0, markerLen), C.KOR_INT_MAIL_NON_TRUNCATED_LANGUAGE_MARKER)) return true;

        const checksum = C.getChecksumOfData(newTotalMessageData.concat(postIntMailDataBytes, metadataNonTruncatedBytes.slice(0, -2)));
        const checksumByte1 = (checksum & 0x7F) | 0x80;
        const checksumByte2 = ((checksum >> 7) & 0x7F) | 0x80;
        if (checksumByte1 !== pyIndex(metadataNonTruncatedBytes, markerLen)) return true;
        if (checksumByte2 !== pyIndex(metadataNonTruncatedBytes, markerLen + 1)) return true;

        return false;
    }

    getReconvertedByteFirstSecond(hasEncounteredEol, inFirstBytes, inSecondBytes, i) {
        const C = GSCKORMailConverter;
        let isEol = false;
        let toAddSecondByte = 0x0E;
        if (i < inSecondBytes.length) {
            toAddSecondByte = inSecondBytes[i];
            if (inSecondBytes[i] === C.END_OF_LINE) {
                isEol = true;
                hasEncounteredEol = true;
            }
        } else if (hasEncounteredEol) {
            toAddSecondByte = C.END_OF_LINE;
            isEol = true;
        }
        let toAddFirstByte = pyIndex(inFirstBytes, i) + 1;
        if (isEol) toAddFirstByte = C.END_OF_LINE;
        return [toAddFirstByte, toAddSecondByte, hasEncounteredEol];
    }

    /**
     * Unpack a Korean mail carried by an international game.
     */
    alterIntMailDataProvidedKor(messageData, authorData) {
        const C = GSCKORMailConverter;
        const N = C.NUM_VALID_USER_INPUT_TABLES;
        const half = C.POS_HALF_IN_CORR_BYTE_KOR_CONV_INT;
        const newAuthorData = pySlice(authorData, 0);

        let newTotalMessageData = [];
        for (let i = 0; i < C.OT_NAME_REAL_LEN_JPN; i++) newTotalMessageData.push(pyIndex(authorData, i));

        let skippedNewline = false;
        for (let i = 0; i < C.BASE_INT_MAIL_LEN - 1; i++) {
            const toAdd = pyIndex(messageData, i + 1);
            if ((!skippedNewline) && ((toAdd === C.NEWLINE) || (toAdd === C.NEWLINE_KOR))) {
                skippedNewline = true;
                continue;
            }
            newTotalMessageData.push(toAdd);
        }

        let toAdd = pyIndex(messageData, 0);
        if (toAdd === C.EOL_KOR_START_MSG_DATA_REPLACEMENT) toAdd = C.END_OF_LINE;
        newTotalMessageData.push(toAdd);
        newTotalMessageData.push(pyIndex(authorData, C.OT_NAME_REAL_LEN_JPN));
        newTotalMessageData.push(pyIndex(authorData, C.OT_NAME_REAL_LEN_JPN + 1));

        for (let i = 0; i < newTotalMessageData.length; i++) {
            if (newTotalMessageData[i] === C.PROHIBITED_CHAR_REPLACEMENT) newTotalMessageData[i] = C.PROHIBITED_CHAR;
        }

        const endOfPostIntMailData = C.BASE_INT_MAIL_LEN + (C.FULL_CONVERTED_KOR_MAIL_LEN - newTotalMessageData.length);
        const postIntMailDataBytes = pySlice(messageData, C.BASE_INT_MAIL_LEN, endOfPostIntMailData);
        check((postIntMailDataBytes.length + newTotalMessageData.length) === C.FULL_CONVERTED_KOR_MAIL_LEN);
        const hasBeenTruncated = this.determineHasBeenTruncatedAndProcessData(newTotalMessageData, postIntMailDataBytes, messageData, endOfPostIntMailData);

        // Undo the packing of the character split around the cut point
        let corrByteSp = pyIndex(newTotalMessageData, half) & 0x7;
        if (!hasBeenTruncated) corrByteSp |= (pyIndex(postIntMailDataBytes, 0) & 0xF) << 3;
        const firstByteSp1 = (newTotalMessageData[half] >> 3) & 0xF;
        const firstByteSp2 = (pyIndex(newTotalMessageData, half + 2) & 0x7F) % N;
        const firstByteSp3 = Math.floor((newTotalMessageData[half + 2] & 0x7F) / N);
        let firstByteSp4 = 0;
        const secondByteSp1 = pyIndex(newTotalMessageData, half + 1);
        const secondByteSp2 = pyIndex(newTotalMessageData, half + 3);
        const secondByteSp3 = pyIndex(newTotalMessageData, half + 4);
        newTotalMessageData[half] = corrByteSp | 0x80;
        newTotalMessageData[half + 1] = (firstByteSp1 + (N * firstByteSp2)) | 0x80;
        newTotalMessageData[half + 2] = secondByteSp1;
        newTotalMessageData[half + 3] = secondByteSp2;
        newTotalMessageData[half + 4] = (firstByteSp3 + (N * firstByteSp4)) | 0x80;
        newTotalMessageData.push(secondByteSp3);
        if (hasBeenTruncated) {
            newTotalMessageData.push(C.END_OF_LINE);
        } else {
            newTotalMessageData = newTotalMessageData.concat(postIntMailDataBytes.slice(1));
            check(newTotalMessageData.length === C.FULL_CONVERTED_KOR_MAIL_LEN);
            firstByteSp4 = Math.floor((pyIndex(newTotalMessageData, C.POS_LAST_FIRST_BYTES_KOR_CONV_INT) & 0x7F) / N);
            newTotalMessageData[half + 4] = (firstByteSp3 + (N * firstByteSp4)) | 0x80;
        }

        // Split back into first bytes, second bytes and correction bits
        const newlinePos = pyIndex(newTotalMessageData, 0) & 0x3F;
        let inFirstBytes = [];
        const inSecondBytes = [];
        const inCorrBytes = [];
        let hasProcessedCorrBytes = false;
        let i = 1;
        while (i < newTotalMessageData.length) {
            if ((!hasProcessedCorrBytes) && (((inSecondBytes.length % 7) === 0) || (((inSecondBytes.length + 1) % 7) === 0))) {
                hasProcessedCorrBytes = true;
                inCorrBytes.push(newTotalMessageData[i] & 0x7F);
                i += 1;
                continue;
            }
            hasProcessedCorrBytes = false;
            const firstByteMerged = newTotalMessageData[i] & 0x7F;
            inFirstBytes.push(firstByteMerged % N);
            inFirstBytes.push(Math.floor(firstByteMerged / N));
            i += 1;
            if (i >= newTotalMessageData.length) break;
            let secondByte = newTotalMessageData[i] & 0x7F;
            if (newTotalMessageData[i] === C.END_OF_LINE) secondByte = 0x80;
            inSecondBytes.push(secondByte);
            i += 1;
            if (i >= newTotalMessageData.length) break;
            secondByte = newTotalMessageData[i] & 0x7F;
            if (newTotalMessageData[i] === C.END_OF_LINE) secondByte = 0x80;
            inSecondBytes.push(secondByte);
            i += 1;
        }

        // An odd number of first bytes: the extra one only carried a value
        const numBaseMailKorChars = Math.floor((C.OT_NAME_REAL_LEN_KOR + C.BASE_KOR_MAIL_LEN) / 2);
        if (inFirstBytes.length >= numBaseMailKorChars) {
            check(inFirstBytes.length === (numBaseMailKorChars + 1));
            inFirstBytes = inFirstBytes.slice(0, numBaseMailKorChars);
        }

        const inCorrBits = [];
        for (const corrByte of inCorrBytes) {
            for (let j = 0; j < 7; j++) inCorrBits.push((corrByte & (1 << j)) !== 0 ? 0x80 : 0);
        }

        for (let k = 0; k < inSecondBytes.length; k++) {
            if (inSecondBytes[k] === 0x80) inSecondBytes[k] = C.END_OF_LINE;
            else inSecondBytes[k] |= pyIndex(inCorrBits, k);
        }

        let hasEncounteredEol = false;
        for (let k = 0; k < Math.floor(C.OT_NAME_REAL_LEN_KOR / 2); k++) {
            let toAddFirstByte;
            let toAddSecondByte;
            [toAddFirstByte, toAddSecondByte, hasEncounteredEol] = this.getReconvertedByteFirstSecond(hasEncounteredEol, inFirstBytes, inSecondBytes, k);
            GSCUtilsMisc.setItem(newAuthorData, k * 2, toAddFirstByte);
            GSCUtilsMisc.setItem(newAuthorData, (k * 2) + 1, toAddSecondByte);
        }

        const newMessageData = new Array(C.MAIL_LEN).fill(C.END_OF_LINE);
        let outPos = 0;
        hasEncounteredEol = false;
        for (let k = Math.floor(C.OT_NAME_REAL_LEN_KOR / 2); k < inFirstBytes.length; k++) {
            if (outPos === newlinePos) {
                GSCUtilsMisc.setItem(newMessageData, outPos, C.NEWLINE_KOR);
                outPos += 1;
            }
            let toAddFirstByte;
            let toAddSecondByte;
            [toAddFirstByte, toAddSecondByte, hasEncounteredEol] = this.getReconvertedByteFirstSecond(hasEncounteredEol, inFirstBytes, inSecondBytes, k);
            GSCUtilsMisc.setItem(newMessageData, outPos, toAddFirstByte);
            outPos += 1;
            GSCUtilsMisc.setItem(newMessageData, outPos, toAddSecondByte);
            outPos += 1;
        }

        for (let k = outPos; k < C.MAIL_LEN; k++) {
            if (k === newlinePos) newMessageData[k] = C.NEWLINE_KOR;
        }

        return [newMessageData, newAuthorData];
    }

    alterIntMailDataProvided(messageData, authorData) {
        const mailLanguage = this.getMailLanguageFromIntMailData(messageData, authorData);
        if (mailLanguage !== PokemonNamesForGen.KOREAN_LANGUAGE) return this.alterIntMailDataProvidedNotKor(messageData, authorData);
        return this.alterIntMailDataProvidedKor(messageData, authorData);
    }

    alterIntMailData(data, index) {
        const C = GSCKORMailConverter;
        const mailPos = C.MAIL_POS_INT[index];
        const senderPos = C.SENDER_POS_INT[index];
        const messageData = pySlice(data, mailPos, mailPos + C.BASE_KOR_MAIL_LEN);
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

    preprocessKorMail(data) {
        return data;
    }

    // ==================== Korean -> International ====================

    /**
     * Split each Korean character into its table (first byte), value and
     * top bit (second byte).
     */
    splitInfoOfKorCharData(data, lengthToDo, ackNewline) {
        const C = GSCKORMailConverter;
        const outFirstBytes = [];
        const outSecondBytes = [];
        const outCorrBits = [];

        let newlinePos = -1;
        let i = 0;
        while (i < lengthToDo) {
            const isEol = pyIndex(data, i) === C.END_OF_LINE;
            const isNewline = ackNewline && ((data[i] === C.NEWLINE) || (data[i] === C.NEWLINE_KOR));
            if (isNewline) {
                newlinePos = i;
                i += 1;
                ackNewline = false;
                continue;
            }
            // Half a character is an error: drop it
            if ((i + 1) >= lengthToDo) break;
            let firstByte = (data[i] & 0xF) - 1;
            if ((firstByte < 0) || (firstByte >= C.NUM_VALID_USER_INPUT_TABLES)) firstByte = C.NUM_VALID_USER_INPUT_TABLES - 1;
            let secondByte = (pyIndex(data, i + 1) & 0x7F) + 0x80;
            let corrBit = 0;
            if ((data[i + 1] & 0x80) !== 0) corrBit = 1;
            if (isEol) {
                secondByte = C.END_OF_LINE;
                corrBit = 0;
            }
            outFirstBytes.push(firstByte);
            outSecondBytes.push(secondByte);
            outCorrBits.push(corrBit);
            i += 2;
        }
        return [outFirstBytes, outSecondBytes, outCorrBits, newlinePos];
    }

    /**
     * Pack a Korean mail so international and Japanese games carry it.
     */
    alterKorMailDataProvidedKor(messageData, authorData) {
        const C = GSCKORMailConverter;
        const N = C.NUM_VALID_USER_INPUT_TABLES;
        const half = C.POS_HALF_IN_CORR_BYTE_KOR_CONV_INT;
        const newAuthorData = pySlice(authorData, 0);

        const [ofbOt, osbOt, ocbOt] = this.splitInfoOfKorCharData(authorData, C.OT_NAME_REAL_LEN_KOR, false);
        const [ofbMsg, osbMsg, ocbMsg, nlMsgRaw] = this.splitInfoOfKorCharData(messageData, C.BASE_KOR_MAIL_LEN, true);
        let nlMsg = nlMsgRaw;

        // Trainer data first, then the message
        const outFirstBytes = ofbOt.concat(ofbMsg);
        const outSecondBytes = osbOt.concat(osbMsg);
        const bitsPreserved = ocbOt.concat(ocbMsg);

        const bytesPreserved = [];
        for (let i = 0; i < bitsPreserved.length; i++) {
            if ((i % 7) === 0) bytesPreserved.push(0x80);
            bytesPreserved[Math.floor(i / 7)] |= (bitsPreserved[i] << (i % 7));
        }

        // The newline is always within the first 16 characters
        if ((nlMsg < 0) || (nlMsg > C.BASE_KOR_MAIL_NEWLINE_POS)) nlMsg = C.BASE_KOR_MAIL_NEWLINE_POS;
        let newTotalMessageData = [nlMsg | 0x80];

        // Two characters per iteration
        for (let i = 0; i < outSecondBytes.length; i += 2) {
            // 7 is odd, so check both characters
            if (((i % 7) === 0) || (((i + 1) % 7) === 0)) newTotalMessageData.push(pyIndex(bytesPreserved, Math.floor((i + 6) / 7)));

            const outFirstByte1 = outFirstBytes[i];
            let outFirstByte2 = 0;
            if ((i + 1) < outSecondBytes.length) outFirstByte2 = outFirstBytes[i + 1];

            newTotalMessageData.push((outFirstByte1 + (N * outFirstByte2)) | 0x80);
            newTotalMessageData.push(outSecondBytes[i]);
            if ((i + 1) < outSecondBytes.length) newTotalMessageData.push(outSecondBytes[i + 1]);
        }

        // Repack the character split around the cut point, so it can be
        // restored even when the tail gets cut
        const corrByteSp = pyIndex(newTotalMessageData, half) & 0x7F;
        const firstByteSp1 = (pyIndex(newTotalMessageData, half + 1) & 0x7F) % N;
        const firstByteSp2 = Math.floor((newTotalMessageData[half + 1] & 0x7F) / N);
        const firstByteSp3 = (pyIndex(newTotalMessageData, half + 4) & 0x7F) % N;
        const firstByteSp4 = Math.floor((newTotalMessageData[half + 4] & 0x7F) / N);
        const secondByteSp1 = pyIndex(newTotalMessageData, half + 2);
        const secondByteSp2 = pyIndex(newTotalMessageData, half + 3);
        const secondByteSp3 = pyIndex(newTotalMessageData, half + 5);
        newTotalMessageData[half] = ((corrByteSp & 0x07) | (firstByteSp1 << 3)) | 0x80;
        newTotalMessageData[half + 1] = secondByteSp1;
        newTotalMessageData[half + 2] = (firstByteSp2 + (N * firstByteSp3)) | 0x80;
        newTotalMessageData[half + 3] = secondByteSp2;
        newTotalMessageData[half + 4] = secondByteSp3;
        newTotalMessageData[half + 5] = (corrByteSp >> 3) | 0x80;
        // The removed 4th first byte goes at the end of the mail data
        const lastPos = newTotalMessageData.length + C.POS_LAST_FIRST_BYTES_KOR_CONV_INT;
        const firstByteSpFinal = (pyIndex(newTotalMessageData, C.POS_LAST_FIRST_BYTES_KOR_CONV_INT) & 0x7F) % N;
        newTotalMessageData[lastPos] = (firstByteSpFinal + (firstByteSp4 * N)) | 0x80;

        // Marker and checksum to tell whether the tail was cut
        newTotalMessageData = newTotalMessageData.concat(C.KOR_INT_MAIL_NON_TRUNCATED_LANGUAGE_MARKER);
        const checksum = C.getChecksumOfData(newTotalMessageData);
        const checksumByte1 = (checksum & 0x7F) | 0x80;
        const checksumByte2 = ((checksum >> 7) & 0x7F) | 0x80;
        newTotalMessageData.push(checksumByte1, checksumByte2);

        for (let i = 0; i < newTotalMessageData.length; i++) {
            if (newTotalMessageData[i] === C.PROHIBITED_CHAR) newTotalMessageData[i] = C.PROHIBITED_CHAR_REPLACEMENT;
        }

        let newMessageData = [0];
        let posInCopy = 0;
        // The Japanese conversion keeps the first 5 author bytes
        for (let i = 0; i < C.OT_NAME_REAL_LEN_JPN; i++) {
            GSCUtilsMisc.setItem(newAuthorData, i, pyIndex(newTotalMessageData, posInCopy));
            posInCopy += 1;
        }

        // Minus the first byte and the newline
        for (let k = 0; k < C.BASE_INT_MAIL_LEN - 2; k++) {
            newMessageData.push(pyIndex(newTotalMessageData, posInCopy));
            posInCopy += 1;
            if (newMessageData.length === C.BASE_INT_MAIL_NEWLINE_POS) newMessageData.push(C.NEWLINE);
        }

        newMessageData[0] = pyIndex(newTotalMessageData, posInCopy);
        if (newMessageData[0] === C.END_OF_LINE) newMessageData[0] = C.EOL_KOR_START_MSG_DATA_REPLACEMENT;
        posInCopy += 1;
        GSCUtilsMisc.setItem(newAuthorData, C.OT_NAME_REAL_LEN_JPN, pyIndex(newTotalMessageData, posInCopy));
        posInCopy += 1;
        GSCUtilsMisc.setItem(newAuthorData, C.OT_NAME_REAL_LEN_JPN + 1, pyIndex(newTotalMessageData, posInCopy));
        posInCopy += 1;
        GSCUtilsMisc.setItem(newAuthorData, C.OT_NAME_REAL_LEN_JPN + 2, C.END_OF_LINE);

        // Room only other Korean games keep
        newMessageData = newMessageData.concat(newTotalMessageData.slice(posInCopy));

        GSCUtilsMisc.setItem(newAuthorData, C.LANGUAGE_SENDER_POS_INT, 0x84); // E
        GSCUtilsMisc.setItem(newAuthorData, C.LANGUAGE_SENDER_POS_INT + 1, 0x8A); // K
        check((newTotalMessageData.length - C.KOR_INT_MAIL_NON_TRUNCATED_LANGUAGE_MARKER.length - 2) === C.FULL_CONVERTED_KOR_MAIL_LEN);

        return [newMessageData, newAuthorData];
    }

    /**
     * Restore a marked international mail.
     */
    alterKorMailDataProvidedNotKor(messageData, authorData) {
        const C = GSCKORMailConverter;
        const newAuthorData = pySlice(authorData, 0);
        const newMessageData = pySlice(messageData, 0);

        const corrBytes = [];
        for (let i = 0; i < C.INT_KOR_MAIL_CORR_BITS_LEN; i++) {
            let toAdd = pyIndex(messageData, C.INT_KOR_MAIL_CORR_BITS_POS + i);
            if (toAdd === C.PROHIBITED_CHAR) toAdd = C.PROHIBITED_CHAR_REPLACEMENT;
            corrBytes.push(toAdd);
        }

        const corrMasks = [];
        for (const corrByte of corrBytes) {
            for (let j = 0; j < 7; j++) corrMasks.push(~((corrByte & (1 << j)) !== 0 ? 0x80 : 0));
        }

        for (let i = 0; i < C.OT_NAME_REAL_LEN_INT; i++) {
            GSCUtilsMisc.setItem(newAuthorData, i, pyIndex(authorData, i) & pyIndex(corrMasks, i));
        }

        for (let i = 0; i < C.BASE_INT_MAIL_LEN; i++) {
            GSCUtilsMisc.setItem(newMessageData, i, pyIndex(messageData, i) & pyIndex(corrMasks, C.OT_NAME_REAL_LEN_INT + i));
            if ((newMessageData[i] === C.NEWLINE) || (newMessageData[i] === C.NEWLINE_KOR)) newMessageData[i] = C.NEWLINE;
        }

        return [newMessageData, newAuthorData];
    }

    alterKorMailDataProvided(messageData, authorData) {
        const mailLanguage = this.getMailLanguageFromKorMailData(messageData, authorData);
        if (mailLanguage !== PokemonNamesForGen.KOREAN_LANGUAGE) return this.alterKorMailDataProvidedNotKor(messageData, authorData);
        return this.alterKorMailDataProvidedKor(messageData, authorData);
    }

    alterKorMailData(data, index) {
        const C = GSCKORMailConverter;
        const mailPos = C.MAIL_POS_INT[index];
        const senderPos = C.SENDER_POS_INT[index];
        const messageData = pySlice(data, mailPos, mailPos + C.BASE_KOR_MAIL_LEN);
        const authorData = pySlice(data, senderPos, senderPos + C.SENDER_INT_LEN);

        const [newMessageData, newAuthorData] = this.alterKorMailDataProvided(messageData, authorData);

        for (let i = 0; i < newMessageData.length; i++) GSCUtilsMisc.setItem(data, mailPos + i, newMessageData[i]);
        for (let i = 0; i < newAuthorData.length; i++) GSCUtilsMisc.setItem(data, senderPos + i, newAuthorData[i]);
        return data;
    }

    postprocessIntMail(data) {
        for (let i = 0; i < 6; i++) data = this.alterKorMailData(data, i);
        return data;
    }

    postprocessKorMail(data) {
        return data;
    }

    /**
     * International mail section (patches decoded) -> Korean one; the input
     * is altered in place and returned.
     */
    convertToKor(data) {
        data = this.preprocessIntMail(data);
        return this.postprocessKorMail(data);
    }

    /**
     * Korean mail section (patches decoded) -> international one; the input
     * is altered in place and returned.
     */
    convertToInt(data) {
        data = this.preprocessKorMail(data);
        return this.postprocessIntMail(data);
    }
}
