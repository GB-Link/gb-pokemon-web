
import { TradingProtocol } from './TradingProtocol.js?v=88';
import { RSESPUtils, RSESPTradingPokemonInfo, RSESPTradingData } from './RSESPUtils.js?v=88';
import { RSESPChecks } from './RSESPChecks.js?v=88';

export class RSESPTrading extends TradingProtocol {
    constructor(usb, ws, logger, tradeType = 'pool', isBuffered = false, doSanityChecks = true, options = {}) {
        super(usb, ws, logger);

        this.checks = new RSESPChecks(doSanityChecks);

        this.tradeType = tradeType;
        this.maxLevel = options.maxLevel ?? 100;
        this.verbose = options.verbose ?? false;

        // Gen 3 message tags (matching Python RSESPTradingClient)
        this.full_transfer = "FL3S";
        this.pool_transfer = "P3SI";
        this.pool_transfer_out = "P3SO";
        this.choice_transfer = "CH3S";
        this.accept_transfer = ["A3S1", "A3S2"];
        this.success_transfer = ["S3S1", "S3S2", "S3S3", "S3S4", "S3S5", "S3S6", "S3S7"];

        this.special_sections_len = [0x380]; // 896 bytes
        this.SECTION_NAMES = ['Trade data']; // UI progress label

        // Protocol Control Flags
        this.done_control_flag = 0x20;
        this.not_done_control_flag = 0x40;
        this.sending_data_control_flag = 0x10;
        this.in_party_trading_flag = 0x80;
        this.asking_data_nybble = 0xC;

        // Trade menu values
        this.trade_offer_start = 0x80;
        this.trade_cancel = 0x8F;
        this.stop_trade_val = (this.trade_cancel << 16);
        this.first_trade_index = (this.trade_offer_start << 16);
        this.possible_indexes = new Set([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x8F]);

        this.base_send_data_start = 1;
        this.base_data_chunk_size = 0xFE;
        this.since_last_useful_limit = 10;
        this.option_confirmation_threshold = 10;

        this.accept_trade = [0xA2, 0xB2];
        this.decline_trade = [0xA1, 0xB1];
        this.decline_trade_value = [this.decline_trade[0] << 16, this.decline_trade[1] << 16];
        this.success_trade = [0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x9C];
        this.failed_trade = 0x9F;

        // Trading state
        this.own_pokemon = null;
        this.other_pokemon = null;
        this.exit_or_new = false;


        // Counter state for WS message sequencing (matches Python send_with_counter/get_with_counter)
        this.own_id = null;
        this.other_id = null;

        // Base data file paths
        this.base_pool_path = "data/rse/base_pool.bin";
        this.base_no_trade_path = "data/rse/base.bin";

        // 32-bit SPI exchange
        this.exchange32Bit = async (val) => {
            const tx = new Uint8Array([
                (val >>> 24) & 0xFF,
                (val >>> 16) & 0xFF,
                (val >>> 8) & 0xFF,
                val & 0xFF
            ]);
            await this.usb.writeBytes(tx);
            // Accumulate the 4 reply bytes across bounded read attempts; a dead
            // link must abort loudly, not fabricate 0 words forever.
            let rx = new Uint8Array(0);
            for (let attempt = 0; attempt < 3 && rx.length < 4; attempt++) {
                const chunk = await this.usb.readBytesRaw(4, 2000);
                if (chunk.length > 0) {
                    const merged = new Uint8Array(rx.length + chunk.length);
                    merged.set(rx);
                    merged.set(chunk, rx.length);
                    rx = merged;
                }
            }
            if (rx.length < 4) {
                this.log("[ERROR] GBA link not responding (32-bit exchange timed out)");
                this.stopTrade = true;
                throw new Error("32-bit exchange read timeout");
            }
            return ((rx[0] << 24) | (rx[1] << 16) | (rx[2] << 8) | rx[3]) >>> 0;
        };
    }

    // ==================== Entry Point ====================

    async startTrade() {
        this.log("Starting Gen 3 Trade...");

        // Load RSESPUtils data files
        await RSESPUtils.load();

        if (this.tradeType === 'pool') {
            await this.poolTradeLoop();
        } else {
            await this.linkTradeLoop();
        }
    }

    // ==================== Low-Level Protocol Helpers ====================

    swapByte(data) {
        return this.exchange32Bit(data >>> 0);
    }

    getBytesFromPos(index) {
        let base_pos = index & 0xFFF;
        let byte_base = this.base_send_data_start;
        while (base_pos >= this.base_data_chunk_size) {
            base_pos -= this.base_data_chunk_size;
            byte_base += 1;
        }
        return (byte_base << 8) | base_pos;
    }

    getPosFromBytes(value) {
        let final_pos = value & 0xFF;
        if (final_pos >= this.base_data_chunk_size) {
            final_pos = 0;
        }
        return final_pos + (this.base_data_chunk_size * (((value >>> 8) & 0xF) - this.base_send_data_start));
    }

    async swapTradeSetupData(next, index, is_complete) {
        let data = next;
        if (is_complete) {
            data |= (this.done_control_flag << 24);
        } else {
            data |= (this.not_done_control_flag << 24);
        }
        data |= (this.sending_data_control_flag << 24);
        data |= (this.getBytesFromPos(index) << 16);
        data |= (next & 0xFFFF);
        data = data >>> 0;

        const received = await this.swapByte(data);
        return this.interpretInDataSetupGen3(received);
    }

    async askTradeSetupData(start, end) {
        let data = 0;
        data |= ((this.not_done_control_flag | this.asking_data_nybble) << 24);
        data |= (start & 0xFFF);
        data |= ((end & 0xFFF) << 12);
        data = data >>> 0;

        const received = await this.swapByte(data);
        return this.interpretInDataSetupGen3(received);
    }

    interpretInDataSetupGen3(data) {
        let next = data & 0xFFFF;
        let position = (data >>> 16) & 0xFF;
        let control_byte = (data >>> 24) & 0xFF;
        let other_pos_gen3 = data & 0xFFF;
        let other_end_gen3 = (data >>> 12) & 0xFFF;

        let is_valid = false;
        let is_asking = false;
        let is_complete = false;
        let is_done = false;

        if ((control_byte & 0xF) >= this.asking_data_nybble) {
            control_byte &= ~this.sending_data_control_flag;
            if ((control_byte & this.not_done_control_flag) !== 0) {
                is_asking = true;
                if (other_end_gen3 > (this.special_sections_len[0] >> 1)) {
                    other_end_gen3 = this.special_sections_len[0] >> 1;
                }
                if (other_pos_gen3 >= other_end_gen3) {
                    other_pos_gen3 = other_end_gen3;
                }
            } else if ((control_byte & this.done_control_flag) !== 0) {
                other_pos_gen3 = other_end_gen3;
            }
        }

        if ((control_byte & this.sending_data_control_flag) !== 0) {
            let recv_pos = this.getPosFromBytes(data >>> 16);
            position = recv_pos;
            is_valid = true;
            if (recv_pos >= (this.special_sections_len[0] >> 1)) {
                recv_pos = 0;
                control_byte &= ~this.sending_data_control_flag;
                is_valid = false;
            }
        }

        if ((control_byte & this.done_control_flag) !== 0) {
            is_done = true;
            if (control_byte & this.in_party_trading_flag) {
                is_complete = true;
            }
        }

        return { next, position, is_valid, is_asking, is_complete, is_done, other_pos_gen3, other_end_gen3 };
    }

    async swapTradeDataDump() {
        let data = ((this.done_control_flag | this.in_party_trading_flag) << 24) >>> 0;
        const received = await this.swapByte(data);
        return this.interpretInDataTradeGen3(received);
    }

    async swapTradeOfferDataPure(in_data, is_cancel = false) {
        let data = ((this.done_control_flag | this.in_party_trading_flag) << 24);
        if (is_cancel) {
            data |= (this.trade_cancel << 16);
        } else {
            data |= in_data;
        }
        data = data >>> 0;
        const received = await this.swapByte(data);
        return this.interpretInDataTradeGen3(received);
    }

    async swapTradeRawDataPure(in_data) {
        let data = ((this.done_control_flag | this.in_party_trading_flag) << 24);
        data |= in_data;
        data = data >>> 0;
        const received = await this.swapByte(data);
        return this.interpretInDataTradeGen3(received);
    }

    interpretInDataTradeGen3(data) {
        if (!data && data !== 0) return null;
        let next = data & 0xFFFFFF;
        let control_byte = (data >>> 24) & 0xFF;

        if (control_byte !== ((this.in_party_trading_flag | this.done_control_flag) & 0xFF)) {
            return null;
        }
        return next;
    }

    findUncompletedRange(completed_data) {
        let max_size = 0;
        let max_start = 0;
        let max_end = 0;
        let i = 0;

        while (i < completed_data.length) {
            let k = i;
            for (let l = i; l < completed_data.length; l++) {
                if (completed_data[l]) break;
                k++;
            }
            if ((k - i) > max_size) {
                max_size = k - i;
                max_start = i;
                max_end = k;
            }
            if (k !== i) {
                i = k;
            } else {
                i++;
            }
        }
        return [max_start, max_end];
    }

    // ==================== Data Exchange ====================

    async readSection(sendData) {
        const length = this.special_sections_len[0];
        const numBlocks = length / 2;
        const completedData = new Array(numBlocks).fill(false);
        const buf = new Array(length).fill(0);

        let numUncompleted = numBlocks;
        let otherPos = 0;
        let otherEnd = 0;

        let next = 0;
        let sinceLastUseful = this.since_last_useful_limit;
        let transferSuccessful = false;
        let hasAllData = false;

        while (!transferSuccessful && !this.stopTrade) {
            let res;
            if (sinceLastUseful >= this.since_last_useful_limit && !hasAllData) {
                const [start, end] = this.findUncompletedRange(completedData);
                res = await this.askTradeSetupData(start, end);
                sinceLastUseful = 0;
            } else {
                if (sendData !== null && sendData !== undefined) {
                    if (otherPos < otherEnd) {
                        next = (sendData[otherPos * 2]) | (sendData[(otherPos * 2) + 1] << 8);
                    } else {
                        next = 0;
                    }
                } else {
                    next = 0;
                    otherPos = 0;
                }
                res = await this.swapTradeSetupData(next, otherPos, hasAllData);
                if (otherPos < otherEnd) {
                    otherPos++;
                }
                if (otherPos >= numBlocks) {
                    otherPos = 0;
                }
            }

            sinceLastUseful++;

            // If GBA returned all-zero (no flags set = not ready/idle),
            // stay in askTradeSetupData mode to keep prompting the GBA.
            if (!res.is_valid && !res.is_asking && !res.is_complete && !res.is_done) {
                sinceLastUseful = this.since_last_useful_limit;
                await this.sleep(50);
            }

            if (res.is_asking) {
                otherPos = res.other_pos_gen3;
                otherEnd = res.other_end_gen3;
            } else if (!(res.is_done && res.is_complete)) {
                if (!hasAllData && res.is_valid) {
                    const index = res.position;
                    if (index < numBlocks) {
                        buf[index * 2] = res.next & 0xFF;
                        buf[(index * 2) + 1] = (res.next >>> 8) & 0xFF;

                        if (!completedData[index]) {
                            sinceLastUseful = 0;
                            completedData[index] = true;
                            numUncompleted--;
                            this.onProgress?.(0, length - numUncompleted * 2, length);

                            if (numUncompleted % 50 === 0) {
                                this.log(`Transferring: ${length - numUncompleted * 2}/${length}`);
                            }

                            if (numUncompleted === 0) {
                                // Validate checksums
                                if (RSESPTradingData.areChecksumValid(buf, this.special_sections_len)) {
                                    hasAllData = true;
                                    if (sendData === null || sendData === undefined) {
                                        transferSuccessful = true;
                                    }
                                } else {
                                    // Checksum failed - reset and retry
                                    this.logVerbose("Checksum validation failed, retrying transfer...");
                                    for (let ci = 0; ci < numBlocks; ci++) {
                                        completedData[ci] = false;
                                    }
                                    sinceLastUseful = this.since_last_useful_limit;
                                    numUncompleted = numBlocks;
                                }
                            }
                        }
                    }
                }
            } else {
                if (hasAllData) {
                    transferSuccessful = true;
                }
            }

            await this.sleep(0); // Yield
        }

        return [buf, sendData];
    }

    // ==================== Trade Menu Helpers ====================

    async waitForSetOfValues(values) {
        let found_val = null;
        let consecutive_reads = 0;
        while (consecutive_reads < this.option_confirmation_threshold && !this.stopTrade) {
            const next = await this.swapTradeDataDump();
            let found = false;
            if (next !== null) {
                const command_id = next >>> 16;
                if (values.has(command_id)) {
                    if (next === found_val) {
                        consecutive_reads++;
                        found = true;
                    }
                }
            }
            if (!found) {
                consecutive_reads = 0;
            }
            found_val = next;
        }
        return found_val;
    }

    async waitForChoice() {
        return this.waitForSetOfValues(this.possible_indexes);
    }

    async waitForAcceptDecline(numAccepted) {
        return this.waitForSetOfValues(
            new Set([this.accept_trade[numAccepted], this.decline_trade[numAccepted]])
        );
    }

    async waitForSuccess(numSuccess) {
        return this.waitForSetOfValues(
            new Set([this.success_trade[numSuccess], this.failed_trade])
        );
    }

    isChoiceStop(choice) {
        return (choice & 0xFF0000) === this.stop_trade_val;
    }

    isChoiceDecline(choice, numAccepted) {
        return (choice & 0xFF0000) === this.decline_trade_value[numAccepted];
    }

    convertChoice(choice) {
        return (choice - this.first_trade_index) >>> 16;
    }

    hasFailed(value) {
        return (value & 0xFF0000) === (this.failed_trade << 16);
    }

    async sendDataMultipleTimes(fn, in_data) {
        await fn.call(this, in_data);
        for (let i = 0; i < this.option_confirmation_threshold; i++) {
            await fn.call(this, in_data);
        }
    }

    async endTrade() {
        let next = 0;
        while (next === null || ((next & 0xFF0000) !== this.stop_trade_val)) {
            next = await this.swapTradeOfferDataPure(0, true);
            if (this.stopTrade) return;
        }
        await this.sendDataMultipleTimes(this.swapTradeOfferDataPure, this.stop_trade_val);
    }

    resetTrade(resetCounters = true) {
        this.own_pokemon = null;
        this.other_pokemon = null;
        if (resetCounters) {
            // Full counter reset - used for pool trades and initial link trade setup
            this.own_id = null;
            this.other_id = null;
        }
        // Clear stale counter-based recvDict entries from previous trade.
        // Do NOT clear sendDict — the peer may still be retransmitting GET
        // requests for the previous trade's final messages (e.g. S3S7).
        const counterTags = [
            this.pool_transfer,
            this.pool_transfer_out,
            this.choice_transfer,
            ...this.accept_transfer,
            ...this.success_transfer,
        ];
        for (const tag of counterTags) {
            delete this.ws.recvDict[tag];
        }
    }

    // ==================== Force Receive Helpers ====================

    async forceReceive(fn) {
        let received = null;
        while (received === null && !this.stopTrade) {
            await this.sleep(10);
            received = fn();
            await this.swapByte(0);
        }
        return received;
    }

    async forceReceiveMulti(fn, num) {
        let received = null;
        while (received === null && !this.stopTrade) {
            await this.sleep(10);
            received = fn(num);
            await this.swapByte(0);
        }
        return received;
    }

    // ==================== WebSocket Communication ====================

    sendWithCounter(tag, data) {
        if (this.own_id === null) {
            this.own_id = Math.floor(Math.random() * 256);
        } else {
            this.own_id = (this.own_id + 1) & 0xFF;
        }
        const payload = new Uint8Array([this.own_id, ...data]);
        this.ws.sendData(tag, payload);
    }

    getWithCounter(tag) {
        if (this.ws.recvDict[tag]) {
            const data = this.ws.recvDict[tag];
            delete this.ws.recvDict[tag];
            if (data && data.length >= 1) {
                const counterId = data[0];
                if (this.other_id === null) {
                    this.other_id = counterId;
                } else if (this.other_id !== counterId) {
                    return null;
                }
                this.other_id = (this.other_id + 1) & 0xFF;
                return data.slice(1);
            }
            return null;
        }
        // Send a GET request to the server to request this data
        // (issues GETs when data is missing)
        this.ws.sendGetData(tag);
        return null;
    }

    getThreeBytesOfData(ret) {
        if (ret !== null && ret !== undefined) {
            return RSESPUtils.fromNBytesLE(ret, 3);
        }
        return null;
    }

    // Pool-specific WS methods
    getPoolTradingData() {
        const mon = this.getWithCounter(this.pool_transfer);
        if (mon === null) return null;

        if (mon.length <= 1) {
            this.log("Pool returned failure");
            return null;
        }

        // Apply checks to received data
        const receivedMon = RSESPUtils.singleMonFromData(this.checks, mon);
        if (receivedMon === null) return null;

        // Insert into pre-baked pool party
        return this._buildPoolParty(receivedMon[0], receivedMon[1]);
    }

    async _buildPoolParty(mon, isEgg) {
        // Load base_pool.bin
        const baseData = await RSESPUtils.fetchBin(this.base_pool_path);
        if (!baseData) {
            this.log("Failed to load base_pool.bin");
            return null;
        }

        const party = new RSESPTradingData(baseData, null, false);
        party.pokemon.push(mon);

        // Handle max level
        if (mon.getLevel() > this.maxLevel) {
            mon.setLevel(this.maxLevel);
        }

        // Set party species info
        if (!isEgg) {
            party.partyInfo.total = 1;
        }

        return party;
    }

    sendPoolTradingDataOut(choice) {
        const index = this.convertChoice(choice);
        let ownMon = [];
        if (!this.isChoiceStop(choice)) {
            if (index < this.own_pokemon.getPartySize()) {
                if ((choice & 0xFFFF) === this.own_pokemon.pokemon[index].getSpecies()) {
                    ownMon = RSESPUtils.singleMonToData(this.own_pokemon.pokemon[index]);
                }
            }
        }
        this.sendWithCounter(this.pool_transfer_out, ownMon);
    }

    // Link-specific WS methods
    sendBigTradingData(data) {
        this.ws.sendData(this.full_transfer, data);
    }



    getBigTradingData() {
        if (this.ws.recvDict[this.full_transfer]) {
            const data = this.ws.recvDict[this.full_transfer];
            delete this.ws.recvDict[this.full_transfer];
            return data;
        }
        // Send GET request to the server to retrieve peer's data
        // (matches Python recv_data which issues GET when data is missing)
        this.ws.sendGetData(this.full_transfer);
        return null;
    }

    sendChosenMon(choice) {
        this.sendWithCounter(this.choice_transfer, RSESPUtils.toNBytesLE(choice, 3));
    }

    getChosenMon() {
        return this.getThreeBytesOfData(this.getWithCounter(this.choice_transfer));
    }

    sendAccepted(choice, numAccept) {
        this.sendWithCounter(this.accept_transfer[numAccept], RSESPUtils.toNBytesLE(choice, 3));
    }

    getAccepted(numAccept) {
        return this.getThreeBytesOfData(this.getWithCounter(this.accept_transfer[numAccept]));
    }

    sendSuccess(choice, numSuccess) {
        this.sendWithCounter(this.success_transfer[numSuccess], RSESPUtils.toNBytesLE(choice, 3));
    }

    getSuccess(numSuccess) {
        return this.getThreeBytesOfData(this.getWithCounter(this.success_transfer[numSuccess]));
    }

    // ==================== Trade Starting Sequence ====================

    async tradeStartingSequence(sendData) {
        this.checks.resetSpeciesItemList();

        // First read section
        const [data, data_other] = await this.readSection(sendData);
        if (this.stopTrade) return;

        this.own_pokemon = new RSESPTradingData(data);

        // Send our data to server/peer
        const ourTradingData = this.own_pokemon.createTradingData(this.special_sections_len);
        this.sendBigTradingData(ourTradingData[0]);

        let finalDataOther = data_other;
        if (sendData === null || sendData === undefined) {
            // No data to send - need two-pass approach
            // recvDict[FL3S] was already cleared at the end of doTrade,
            // so any FL3S here is fresh from the peer (arrived during readSection).

            // Also flush stale counter-tag retransmissions that arrived during readSection
            const counterTags = [
                this.choice_transfer,
                ...this.accept_transfer,
                ...this.success_transfer,
            ];
            for (const tag of counterTags) {
                delete this.ws.recvDict[tag];
            }

            this.log("Waiting for other player's data...");
            this.onStatus?.("Waiting for the other player…");
            const otherData = await this.forceReceive(() => {
                return this.getBigTradingData();
            });
            if (this.stopTrade) return;

            // Second read section with the other's data
            const [data2, _] = await this.readSection(otherData);
            if (this.stopTrade) return;

            this.own_pokemon = new RSESPTradingData(data2);
            finalDataOther = otherData;
        }

        this.other_pokemon = new RSESPTradingData(finalDataOther);
    }

    // ==================== Trade Menu ====================

    async doTrade(getMonFunction, close = false, toServer = false) {
        let tradeCompleted = false;
        let baseAutoclose = toServer;
        let autocloseOnStop = baseAutoclose;

        if (close) {
            this.logVerbose("Closing trade...");
        }

        while (!tradeCompleted && !this.stopTrade) {
            // Get the user's choice from the GBA
            this.onStatus?.('Pick a Pokémon on your GBA');
            const sentMon = await this.waitForChoice();
            if (this.stopTrade) return true;

            let received_choice;

            if (!close) {
                if (autocloseOnStop && this.isChoiceStop(sentMon)) {
                    received_choice = this.stop_trade_val;
                } else {
                    // Send choice to server/peer
                    this.logVerbose("Sending choice...");
                    if (toServer) {
                        this.sendPoolTradingDataOut(sentMon);
                    } else {
                        this.sendChosenMon(sentMon);
                    }

                    // Get the other player's choice
                    if (!toServer) {
                        this.logVerbose("Waiting for other player's choice...");
                        this.onStatus?.("Waiting for the other player's choice…");
                    }
                    received_choice = await this.forceReceive(getMonFunction);
                    if (this.stopTrade) return true;
                    autocloseOnStop = baseAutoclose;
                }
            } else {
                this.resetTrade();
                received_choice = this.stop_trade_val;
            }

            if (!this.isChoiceStop(received_choice) && !this.isChoiceStop(sentMon)) {
                // Send the other player's choice to the GBA
                await this.sendDataMultipleTimes(this.swapTradeOfferDataPure, received_choice);

                let accepted, received_accepted;

                // Accept/Decline loop (2 rounds)
                for (let i = 0; i < 2; i++) {
                    accepted = await this.waitForAcceptDecline(i);
                    if (this.stopTrade) return true;

                    if (toServer && this.isChoiceDecline(accepted, i)) {
                        received_accepted = this.decline_trade_value[i];
                    } else {
                        if (i === 0) this.logVerbose("Sending accept/decline...");
                        this.sendAccepted(accepted, i);

                        if (i === 0) this.logVerbose("Waiting for accept/decline response...");
                        received_accepted = await this.forceReceiveMulti(
                            (num) => this.getAccepted(num), i
                        );
                        if (this.stopTrade) return true;
                    }

                    // Send other's response to GBA
                    await this.sendDataMultipleTimes(this.swapTradeRawDataPure, received_accepted);
                }

                // Check if trade was accepted
                if (!this.isChoiceDecline(received_accepted, 1) && !this.isChoiceDecline(accepted, 1)) {
                    this.onStatus?.('Trading…');
                    let success_result, received_success;

                    // Success loop (7 rounds)
                    for (let i = 0; i < 7; i++) {
                        success_result = await this.waitForSuccess(i);
                        if (this.stopTrade) return true;

                        if (i === 0) this.logVerbose("Sending success confirmation...");
                        this.sendSuccess(success_result, i);

                        if (i === 0) this.logVerbose("Waiting for success response...");
                        received_success = await this.forceReceiveMulti(
                            (num) => this.getSuccess(num), i
                        );
                        if (this.stopTrade) return true;

                        await this.sendDataMultipleTimes(this.swapTradeRawDataPure, received_success);
                    }

                    tradeCompleted = true;
                    this.logVerbose("Trade completed, restarting...");
                    this.exit_or_new = true;

                    // Clear both FL3S dicts so stale data from this trade
                    // doesn't leak into the next one:
                    //  - sendDict: prevents stale FL3S being served to peer GETs
                    //  - recvDict: cleared NOW (early) so fresh FL3S arriving
                    //    during the next readSection() is preserved, not destroyed
                    delete this.ws.sendDict[this.full_transfer];
                    delete this.ws.recvDict[this.full_transfer];

                    // Preserve counters between link trades so stale retransmissions
                    // (with old counter values) are rejected by getWithCounter
                    this.resetTrade(false);

                    if (this.hasFailed(success_result) || this.hasFailed(received_success)) {
                        return true;
                    }
                }
            } else {
                if (close || (this.isChoiceStop(sentMon) && this.isChoiceStop(received_choice))) {
                    // Both want to end
                    tradeCompleted = true;
                    this.exit_or_new = true;
                    this.logVerbose("Closing trade menu...");
                    await this.endTrade();
                    return true;
                } else {
                    // One doesn't want to trade - prepare to exit on next stop
                    autocloseOnStop = true;
                    this.logVerbose("One player cancelled, will close on next stop...");

                    // Still send other's choice to GBA
                    await this.sendDataMultipleTimes(this.swapTradeOfferDataPure, received_choice);
                }
            }
        }

        this.resetTrade(false);
        return false;
    }

    // ==================== Pool Trade ====================

    async poolTradeLoop() {
        this.log("Starting Pool Trade...");

        if (!this.ws || !this.ws.isConnected) {
            this.log("WebSocket not connected!");
            return;
        }

        this.resetTrade();
        this.exit_or_new = true;

        while (!this.stopTrade) {
            // 1. Get pool pokemon from server
            if (this.other_pokemon === null) {
                this.log("Requesting Pokemon from Pool...");

                // Use getWithCounter to receive P3SI (matches Python's
                // get_pool_trading_data → get_with_counter). This is critical
                // because it sets other_id from the server's counter byte,
                // allowing subsequent getWithCounter calls to reject stale
                // data left over from the previous trade.
                const monDataRaw = await this.forceReceive(
                    () => this.getWithCounter(this.pool_transfer)
                );
                if (this.stopTrade) return;

                // Python aborts cleanly on the server's 1-byte pool-failure
                // reply; retrying forever hangs the client.
                if (monDataRaw && monDataRaw.length <= 1) {
                    this.log("[ERROR] Pool unavailable (empty pool or server failure). Stopping.");
                    this.stopTrade = true;
                    return;
                }

                const receivedMon = RSESPUtils.singleMonFromData(this.checks, monDataRaw);

                if (!receivedMon) {
                    this.log("Invalid pool pokemon, retrying...");
                    await this.sleep(1000);
                    continue;
                }

                // Build pool party
                const poolParty = await this._loadPoolParty(receivedMon[0], receivedMon[1]);
                if (!poolParty) {
                    this.log("Failed to build pool party, retrying...");
                    await this.sleep(1000);
                    continue;
                }
                this.other_pokemon = poolParty;
            } else {
                this.logVerbose("Reusing previous pool data");
            }

            // 2. Trade starting sequence with pool data
            const sendData = this.other_pokemon.createTradingData(this.special_sections_len)[0];
            await this.tradeStartingSequence(sendData);
            if (this.stopTrade) return;

            // 3. Enter trade menu
            this.log("Entering trade menu...");
            const getFirstMon = () => {
                return this.first_trade_index | this.other_pokemon.pokemon[0].getSpecies();
            };

            if (await this.doTrade(getFirstMon, false, true)) {
                // Trade was cancelled on the GBA — reconnect WebSocket
                // to force the server to assign a fresh pool pokemon
                this.resetTrade(true);
                delete this.ws.recvDict[this.pool_transfer];

                this.log("Trade cancelled. Reconnecting for fresh pool Pokemon...");
                const serverUrl = this.ws.url;
                this.ws.disconnect();
                await this.sleep(500);
                await this.ws.connect(serverUrl);
                this.log("Reconnected! Requesting new pool Pokemon...");
                continue;
            }
        }
    }

    async _loadPoolParty(mon, isEgg) {
        // Load base_pool.bin
        const baseData = await RSESPUtils.fetchBin(this.base_pool_path);
        if (!baseData) {
            this.log("Failed to load base_pool.bin");
            return null;
        }

        // Create party from base data, not parsing pokemon (doFull=false)
        const party = new RSESPTradingData(baseData, null, false);

        // Handle max level
        if (mon.getLevel() > this.maxLevel) {
            mon.setLevel(this.maxLevel);
        }

        // Add the pool mon
        party.pokemon.push(mon);
        party.partyInfo.total = 1;

        // If it's not an egg, set species ID
        // (partyInfo.setId is a no-op for gen3, species is stored in the mon itself)

        return party;
    }

    // ==================== Link Trade ====================

    async linkTradeLoop() {
        this.log("Starting 2-Player Link Trade...");

        if (!this.ws || !this.ws.isConnected) {
            this.log("WebSocket not connected!");
            return;
        }

        // Matches Python player_trade: reset_trade, exit_or_new = True
        this.resetTrade();
        this.exit_or_new = true;
        let valid = true;

        while (!this.stopTrade) {
            // Exchange trading data with peer (always buffered)
            // tradeStartingSequence(null) → two-pass approach:
            //   1. readSection(null) reads our GBA data
            //   2. Sends our data via FL3S
            //   3. Waits for peer's FL3S data
            //   4. readSection(peerData) writes peer data to our GBA
            this.log("Exchanging party data with other player...");
            await this.tradeStartingSequence(null);
            if (this.stopTrade) return;

            this.log("Data exchange complete. Entering trade menu...");
            const getChosenMon = () => this.getChosenMon();

            // doTrade returns true to break (trade ended/failed), false to continue
            if (await this.doTrade(getChosenMon, !valid)) {
                break;
            }

            // Trade completed successfully — loop back for another trade.
            // readSection will keep sending askTradeSetupData prompts until
            // the GBA is ready.
            this.log("Trade complete! Ready for next trade...");
        }
    }

    // ==================== Helpers ====================

    waitForMessage(type) {
        return new Promise((resolve) => {
            const check = () => {
                if (this.stopTrade) {
                    resolve(null);
                    return;
                }
                if (this.ws.recvDict[type]) {
                    const data = this.ws.recvDict[type];
                    delete this.ws.recvDict[type];
                    resolve(data);
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }
}
