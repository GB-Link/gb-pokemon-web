import { GSCTrading } from './GSCTrading.js?v=102';
import { GSCUtils } from './GSCUtils.js?v=102';
import { GSCKORMailConverter } from './GSCKORMailConverter.js?v=102';

/**
 * Korean Gold/Silver: the same party sections as the international games,
 * but a mail section of its own (0x41-byte messages, starter 0x52) that is
 * converted to the international network layout.
 */
export class GSCTradingKOR extends GSCTrading {
    static KOREAN_MAIL_SECTION_ID = 5;

    constructor(usb, ws, logger, tradeType = 'pool', isBuffered = false, doSanityChecks = true, options = {}) {
        super(usb, ws, logger, tradeType, isBuffered, doSanityChecks, { ...options, language: GSCTrading.KOREAN_LANGUAGE });
        this.SECTION_FILLERS[GSCTradingKOR.KOREAN_MAIL_SECTION_ID] = {};
        this.EXTRA_SECTION_DROPS[GSCTradingKOR.KOREAN_MAIL_SECTION_ID] = 0;
        this.korMailConverter = new GSCKORMailConverter(this.checks);
        this.SECTION_NAMES = [...this.SECTION_NAMES];
        this.SECTION_NAMES[GSCTradingKOR.KOREAN_MAIL_SECTION_ID] = 'Mail data';
    }

    getMailSectionId() {
        return GSCTradingKOR.KOREAN_MAIL_SECTION_ID;
    }

    getSectionLength(index, buffered = this.isBuffered) {
        if (index === this.getMailSectionId()) return GSCTrading.MAIL_SECTION_LEN_NEW;
        return super.getSectionLength(index, buffered);
    }

    // The Korean section always has the new length, so it always takes the
    // new checker (Python would pick the old one for pre-4.2.0 peers)
    getSectionChecker(index, buffered = this.isBuffered) {
        if (index === this.getMailSectionId()) {
            const checker = this.checks?.getChecker?.(GSCTrading.BASE_MAIL_INDEX, true);
            if (checker && checker.length >= GSCTrading.MAIL_SECTION_LEN_NEW) return checker;
            return new Array(GSCTrading.MAIL_SECTION_LEN_NEW).fill((value) => value);
        }
        return super.getSectionChecker(index, buffered);
    }

    getSectionStarter(index) {
        if (index === this.getMailSectionId()) return GSCTrading.MAIL_STARTER_KOREAN;
        return super.getSectionStarter(index);
    }

    updateMailTransferLayout() {
        this.SECTION_FILLERS[this.getMailSectionId()] = GSCTrading.korMailFillers();
    }

    async convertMailData(data, toDevice) {
        if (!data || data.length === 0) return data;
        if (this.korMailConverter.load) await this.korMailConverter.load();
        const work = Array.from(data);
        GSCUtils.applyPatches(work, work, true, false, false);
        const converted = toDevice ? this.korMailConverter.convertToKor(work) : this.korMailConverter.convertToInt(work);
        GSCUtils.createPatchesData(converted, converted, true, false, false);
        return new Uint8Array(converted);
    }
}
