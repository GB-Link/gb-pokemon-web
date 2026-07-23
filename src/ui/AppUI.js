
import { UsbConnection, CMD, MODE } from '../services/UsbConnection.js';
import { SerialConnection } from '../services/SerialConnection.js';
import { WebSocketClient } from '../services/WebSocketClient.js';
import { RBYTrading } from '../services/RBYTrading.js';
import { GSCTrading } from '../services/GSCTrading.js';
import { SettingsManager } from '../services/SettingsManager.js';
import { multiboot } from '../services/Multiboot.js';
import { RSESPTrading } from '../services/RSESPTrading.js';

export class AppUI {
    constructor() {
        this.usb = new UsbConnection();  // replaced on connect based on chosen transport
        this.ws = new WebSocketClient();
        this.protocol = null;
        this.settings = new SettingsManager();

        this.elements = {
            usbStatus: document.getElementById('usb-status'),
            btnConnectUsb: document.getElementById('btn-connect-usb'),
            btnStartTrade: document.getElementById('btn-start-trade'),
            btnSendMultiboot: document.getElementById('btn-send-multiboot'),
            btnSettings: document.getElementById('btn-settings'),
            genSelectGroup: document.getElementById('gen-select'),
            tradeTypeGroup: document.getElementById('trade-type-group'),
            tradeTypeSelectGroup: document.getElementById('trade-type-select'),
            gameVersions: document.getElementById('game-versions'),
            btnTimeCapsule: document.getElementById('btn-time-capsule'),
            roomCodeGroup: document.getElementById('room-code-group'),
            roomCode: document.getElementById('room-code'),
            btnGenerateRoom: document.getElementById('btn-generate-room'),
            negotiationPopup: document.getElementById('negotiation-popup'),
            negotiationMessage: document.getElementById('negotiation-message'),
            btnNegotiateYes: document.getElementById('btn-negotiate-yes'),
            btnNegotiateNo: document.getElementById('btn-negotiate-no'),
            logContainer: document.getElementById('log-container'),
            settingsModal: document.getElementById('settings-modal'),
            btnCloseSettings: document.getElementById('btn-close-settings'),
            btnResetDefaults: document.getElementById('btn-reset-defaults'),
            btnSaveSettings: document.getElementById('btn-save-settings'),
            settingServerUrl: document.getElementById('setting-server-url'),
            settingJapanese: document.getElementById('setting-japanese'),
            settingSanityChecks: document.getElementById('setting-sanity-checks'),
            settingVerbose: document.getElementById('setting-verbose'),
            settingDarkMode: document.getElementById('setting-dark-mode'),
            settingBuffered: document.getElementById('setting-buffered'),
            settingCrashSync: document.getElementById('setting-crash-sync'),
            settingMaxLevel: document.getElementById('setting-max-level'),
            settingMaxLevelSlider: document.getElementById('setting-max-level-slider'),
            settingConvertEggs: document.getElementById('setting-convert-eggs')
        };

        // Auto-select transport: prefer WebUSB, fall back to WebSerial (Firefox 151+,
        // or Chromium with WebUSB disabled). When WebUSB is available, never use serial.
        const hasUsb = ('usb' in navigator);
        const hasSerial = ('serial' in navigator);
        this.transport = hasUsb ? 'usb' : (hasSerial ? 'serial' : null);

        this.selectedGen = null;
        this.selectedTradeType = 'link';
        this.isTimeCapsule = false;
        this.isTradeActive = false;

        this.attachListeners();
        this.loadSettingsToUI();
        this.applyTheme();
    }

    attachListeners() {
        // Single auto-selecting connect button. Label and target transport depend on
        // what the browser supports; serial is only used when WebUSB is unavailable.
        if (this.transport) {
            this.elements.btnConnectUsb.textContent = this.transport === 'serial' ? 'Connect Serial' : 'Connect USB';
            this.elements.btnConnectUsb.addEventListener('click', () => this.connect(this.transport));
        } else {
            this.elements.btnConnectUsb.disabled = true;
        }
        this.elements.btnStartTrade.addEventListener('click', () => this.startTrade());
        this.elements.btnSendMultiboot.addEventListener('click', () => this.sendMultiboot());
        this.elements.btnTimeCapsule.addEventListener('click', () => this.toggleTimeCapsule());
        this.elements.btnGenerateRoom.addEventListener('click', () => this.generateRoomCode());

        this.elements.genSelectGroup.querySelectorAll('.btn-option').forEach(btn => {
            btn.addEventListener('click', () => this.onGenSelect(btn));
        });
        this.elements.tradeTypeSelectGroup.querySelectorAll('.btn-option').forEach(btn => {
            btn.addEventListener('click', () => this.onTradeTypeSelect(btn));
        });

        this.elements.btnSettings.addEventListener('click', () => this.openSettings());
        this.elements.btnCloseSettings.addEventListener('click', () => this.closeSettings());
        this.elements.btnResetDefaults.addEventListener('click', () => this.resetToDefaults());
        this.elements.btnSaveSettings.addEventListener('click', () => this.saveSettings());
        this.elements.settingsModal.addEventListener('click', (e) => {
            if (e.target === this.elements.settingsModal) this.closeSettings();
        });

        const settingInputs = [
            this.elements.settingServerUrl, this.elements.settingJapanese,
            this.elements.settingSanityChecks, this.elements.settingVerbose,
            this.elements.settingDarkMode, this.elements.settingBuffered,
            this.elements.settingCrashSync, this.elements.settingMaxLevel,
            this.elements.settingMaxLevelSlider, this.elements.settingConvertEggs
        ];
        settingInputs.forEach(input => {
            input.addEventListener('change', () => this.updateDefaultIndicators());
            if (input.type === 'text' || input.type === 'number' || input.type === 'range') {
                input.addEventListener('input', () => this.updateDefaultIndicators());
            }
        });

        this.elements.settingMaxLevelSlider.addEventListener('input', () => {
            this.elements.settingMaxLevel.value = this.elements.settingMaxLevelSlider.value;
        });
        this.elements.settingMaxLevel.addEventListener('input', () => {
            this.elements.settingMaxLevelSlider.value = this.elements.settingMaxLevel.value;
        });
    }

    // === Settings ===

    openSettings() { this.loadSettingsToUI(); this.elements.settingsModal.style.display = 'flex'; }
    closeSettings() { this.elements.settingsModal.style.display = 'none'; }

    loadSettingsToUI() {
        const s = this.settings.getAll();
        this.elements.settingServerUrl.value = s.serverUrl;
        this.elements.settingJapanese.checked = s.isJapanese;
        this.elements.settingSanityChecks.checked = s.doSanityChecks;
        this.elements.settingVerbose.checked = s.verbose;
        this.elements.settingDarkMode.checked = s.darkMode;
        this.elements.settingBuffered.checked = s.isBuffered;
        this.elements.settingCrashSync.checked = s.crashOnSyncDrop;
        this.elements.settingMaxLevel.value = s.maxLevel;
        this.elements.settingMaxLevelSlider.value = s.maxLevel;
        this.elements.settingConvertEggs.checked = s.convertToEggs;
        this.updateDefaultIndicators();
    }

    saveSettings() {
        this.settings.set('serverUrl', this.elements.settingServerUrl.value.trim());
        this.settings.set('isJapanese', this.elements.settingJapanese.checked);
        this.settings.set('doSanityChecks', this.elements.settingSanityChecks.checked);
        this.settings.set('verbose', this.elements.settingVerbose.checked);
        this.settings.set('darkMode', this.elements.settingDarkMode.checked);
        this.settings.set('isBuffered', this.elements.settingBuffered.checked);
        this.settings.set('crashOnSyncDrop', this.elements.settingCrashSync.checked);
        const maxLevel = Math.max(5, Math.min(100, parseInt(this.elements.settingMaxLevel.value) || 100));
        this.settings.set('maxLevel', maxLevel);
        this.elements.settingMaxLevel.value = maxLevel;
        this.elements.settingMaxLevelSlider.value = maxLevel;
        this.settings.set('convertToEggs', this.elements.settingConvertEggs.checked);
        this.applyTheme();
        this.log('Settings saved.');
        this.closeSettings();
    }

    resetToDefaults() { this.settings.resetToDefaults(); this.loadSettingsToUI(); this.log('Settings reset to defaults.'); }

    updateDefaultIndicators() {
        const mappings = {
            'serverUrl': this.elements.settingServerUrl.value,
            'isJapanese': this.elements.settingJapanese.checked,
            'doSanityChecks': this.elements.settingSanityChecks.checked,
            'verbose': this.elements.settingVerbose.checked,
            'darkMode': this.elements.settingDarkMode.checked,
            'isBuffered': this.elements.settingBuffered.checked,
            'crashOnSyncDrop': this.elements.settingCrashSync.checked,
            'maxLevel': parseInt(this.elements.settingMaxLevel.value) || 100,
            'convertToEggs': this.elements.settingConvertEggs.checked
        };
        document.querySelectorAll('.default-indicator').forEach(indicator => {
            const key = indicator.dataset.setting;
            if (key && mappings.hasOwnProperty(key)) {
                const isDefault = mappings[key] === this.settings.getDefault(key);
                indicator.classList.toggle('is-default', isDefault);
                indicator.classList.toggle('not-default', !isDefault);
            }
        });
    }

    applyTheme() {
        document.body.classList.toggle('light-mode', !this.settings.get('darkMode'));
    }

    // === Generation / Trade Type ===

    static GAME_VERSIONS = {
        '1': 'Red, Blue, Green, Yellow',
        '2': 'Gold, Silver, Crystal',
        '3': 'Fire Red, Leaf Green, Ruby, Sapphire, Emerald - Requires Multiboot'
    };

    onGenSelect(btn) {
        this.elements.genSelectGroup.querySelectorAll('.btn-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.selectedGen = btn.dataset.value;
        this.elements.tradeTypeGroup.style.display = 'block';
        this.elements.gameVersions.textContent = AppUI.GAME_VERSIONS[this.selectedGen] || '';
        this.elements.btnTimeCapsule.style.display = (this.selectedGen === '2') ? 'inline-block' : 'none';
        if (this.selectedGen !== '2') {
            this.isTimeCapsule = false;
            this.elements.btnTimeCapsule.classList.remove('active');
            this.elements.btnTimeCapsule.textContent = 'Time Capsule: OFF';
        }
        this.elements.btnSendMultiboot.style.display = (this.selectedGen === '3') ? 'inline-block' : 'none';
        this.updateRoomCodeVisibility();
    }

    onTradeTypeSelect(btn) {
        this.elements.tradeTypeSelectGroup.querySelectorAll('.btn-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.selectedTradeType = btn.dataset.value;
        this.updateRoomCodeVisibility();
    }

    updateRoomCodeVisibility() {
        this.elements.roomCodeGroup.style.display = (this.selectedTradeType === 'link') ? 'flex' : 'none';
    }

    toggleTimeCapsule() {
        this.isTimeCapsule = !this.isTimeCapsule;
        this.elements.btnTimeCapsule.classList.toggle('active', this.isTimeCapsule);
        this.elements.btnTimeCapsule.textContent = this.isTimeCapsule ? 'Time Capsule: ON' : 'Time Capsule: OFF';
    }

    // === Multiboot ===

    async sendMultiboot() {
        if (!this.usb.isConnected) { this.log('Please connect USB first.'); return; }

        this.log('═'.repeat(40));
        this.log('Starting GBA Multiboot Transfer');
        this.log('═'.repeat(40));

        try {
            // Multiboot always uses 3.3V (GBA link cable spec)
            this.log('Setting voltage to 3.3V for GBA multiboot...');
            await this.usb.setVoltage('3v3');

            const response = await fetch('./data/pokemon_gen3_to_genx_mb.gba');
            if (!response.ok) { this.log(`Failed to load ROM file: ${response.status}`); return; }
            const romData = await response.arrayBuffer();
            this.log(`ROM loaded: ${romData.byteLength} bytes`);

            // multiboot() handles setMode(GB_LINK) + setTimingConfig internally
            const success = await multiboot(this.usb, romData, (msg) => this.log(msg));
            this.log(success ? 'Multiboot transfer complete!' : 'Multiboot transfer failed.');
        } catch (e) {
            this.log(`Multiboot error: ${e.message}`);
        }
    }

    generateRoomCode() {
        const code = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
        this.elements.roomCode.value = code;
        this.log(`Generated room code: ${code}`);
    }

    showNegotiationPrompt(peerMode) {
        return new Promise((resolve) => {
            this.elements.negotiationMessage.textContent = `The other player wants to do a ${peerMode} trade.`;
            this.elements.negotiationPopup.style.display = 'block';

            const handleYes = () => {
                this.elements.negotiationPopup.style.display = 'none';
                this.elements.btnNegotiateYes.removeEventListener('click', handleYes);
                this.elements.btnNegotiateNo.removeEventListener('click', handleNo);
                this.log('User agreed to switch modes');
                resolve(true);
            };
            const handleNo = () => {
                this.elements.negotiationPopup.style.display = 'none';
                this.elements.btnNegotiateYes.removeEventListener('click', handleYes);
                this.elements.btnNegotiateNo.removeEventListener('click', handleNo);
                this.log('User refused to switch modes');
                resolve(false);
            };

            this.elements.btnNegotiateYes.addEventListener('click', handleYes);
            this.elements.btnNegotiateNo.addEventListener('click', handleNo);
        });
    }

    // === Logging ===

    log(msg) {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this.elements.logContainer.appendChild(entry);
        // Keep the on-page log bounded; long sync sessions log a lot
        while (this.elements.logContainer.childElementCount > 500) {
            this.elements.logContainer.removeChild(this.elements.logContainer.firstElementChild);
        }
        this.elements.logContainer.scrollTop = this.elements.logContainer.scrollHeight;
        if (this.settings.get('verbose')) console.log(msg);
    }

    // === Connection ===

    async connectServer() {
        try {
            if (!this.selectedGen) { this.log('Please select a generation first.'); return false; }

            let url = this.settings.get('serverUrl');
            if (url.endsWith('/')) url = url.slice(0, -1);

            if (this.selectedTradeType === 'pool') {
                url += `/pool${this.isTimeCapsule ? '1' : this.selectedGen}`;
            } else {
                let roomCode = this.elements.roomCode.value.trim();
                if (!/^\d{1,5}$/.test(roomCode)) {
                    this.log('Invalid room code. Please enter 1-5 digits or click Generate.');
                    return false;
                }
                roomCode = roomCode.padStart(5, '0');
                url += `/link${this.isTimeCapsule ? '1' : this.selectedGen}/${roomCode}`;
            }

            this.log(`Connecting to server at ${url}...`);
            await this.ws.connect(url);
            return true;
        } catch (error) {
            this.log(`Server connection failed: ${error}`);
            return false;
        }
    }

    async connect(kind) {
        try {
            if (this.usb && this.usb.isConnected) {
                try { await this.usb.disconnect(); } catch (_) {}
            }
            this.usb = kind === 'serial' ? new SerialConnection() : new UsbConnection();

            this.log(`Requesting ${kind === 'serial' ? 'serial port' : 'USB device'}...`);
            await this.usb.connect();
            this.elements.usbStatus.textContent = `Connected (${kind})`;
            this.elements.usbStatus.className = 'status connected';
            // Disable the connect button once a transport is open
            this.elements.btnConnectUsb.disabled = true;
            this.checkReady();
        } catch (error) {
            this.log(`${kind} connection failed: ${error}`);
        }
    }

    // Back-compat shim — old callers may still invoke connectUsb()
    async connectUsb() { return this.connect('usb'); }

    checkReady() {
        if (this.usb.isConnected) this.elements.btnStartTrade.disabled = false;
    }

    // === Trading ===

    async startTrade() {
        if (this.isTradeActive) { await this.stopTrade(); return; }

        // Wait out any previous trade loop still unwinding so two loops never
        // interleave reads on the same adapter.
        if (this.tradePromise) {
            await Promise.race([this.tradePromise, new Promise(r => setTimeout(r, 3000))]);
        }

        this.elements.btnStartTrade.disabled = true;
        const connected = await this.connectServer();
        if (!connected) { this.elements.btnStartTrade.disabled = false; return; }

        this.isTradeActive = true;
        this.elements.btnStartTrade.textContent = 'Stop Trade';
        this.elements.btnStartTrade.disabled = false;

        // Per-packet websocket console dumps only when verbose is enabled
        this.ws.debug = this.settings.get('verbose');

        const gen = this.selectedGen;
        const tradeType = this.selectedTradeType;
        const isBuffered = this.settings.get('isBuffered');
        const doSanityChecks = this.settings.get('doSanityChecks');

        // Voltage: Gen 1 & 2 → 5V (original GB/GBC hardware), Gen 3 → 3.3V (GBA)
        const voltage = (gen === '3') ? '3v3' : '5v';
        this.log(`Setting voltage to ${voltage === '3v3' ? '3.3V' : '5V'} for Gen ${gen}...`);
        await this.usb.setVoltage(voltage);

        // Old firmware: restore 1-byte GB timing (Python always sends this at
        // session start); the adapter may still be in the 4-byte gen3/multiboot
        // mode from a previous run. Its reply byte is swept by the drain below.
        if (!this.usb.isNewFirmware && gen !== '3') {
            await this.usb.setTimingConfig(1000, 1);
        }

        // Discard stale bytes left on the transport by a previous session
        // (Python drains the FIFO before every trade).
        if (this.usb.drain) await this.usb.drain();

        // New firmware: explicitly select GB Link mode for all trading generations
        if (this.usb.isNewFirmware) {
            await this.usb.setMode(MODE.GB_LINK);
            if (gen === '3') {
                await new Promise(r => setTimeout(r, 100)); // Give firmware time to start GBModule
            }
        }

        // Gen 3 uses 32-bit GBA SPI (4 bytes per transfer).
        // Without this, GBModule defaults to 1-byte transfers with 1ms gaps between bytes,
        // which breaks 32-bit GBA link — the GBA never completes its 32-bit shift register.
        if (gen === '3') {
            await this.usb.setTimingConfig(36, 4);
        }

        this.log(`Starting ${tradeType} trade for Gen ${gen} (${isBuffered ? 'buffered' : 'sync'} mode)...`);

        if (gen === '1') {
            this.protocol = new RBYTrading(this.usb, this.ws, (msg) => this.log(msg),
                tradeType, isBuffered, doSanityChecks, {
                isJapanese: this.settings.get('isJapanese'),
                verbose: this.settings.get('verbose'),
                maxLevel: this.settings.get('maxLevel'),
                crashOnSyncDrop: this.settings.get('crashOnSyncDrop'),
                negotiationPrompt: (peerMode) => this.showNegotiationPrompt(peerMode)
            });
        } else if (gen === '2') {
            if (this.isTimeCapsule) {
                this.log('Time Capsule mode: Using Gen 1 protocol');
                this.protocol = new RBYTrading(this.usb, this.ws, (msg) => this.log(msg),
                    tradeType, isBuffered, doSanityChecks, {
                    isJapanese: this.settings.get('isJapanese'),
                    verbose: this.settings.get('verbose'),
                    maxLevel: this.settings.get('maxLevel'),
                    crashOnSyncDrop: this.settings.get('crashOnSyncDrop'),
                    negotiationPrompt: (peerMode) => this.showNegotiationPrompt(peerMode)
                });
            } else {
                this.protocol = new GSCTrading(this.usb, this.ws, (msg) => this.log(msg),
                    tradeType, isBuffered, doSanityChecks, {
                    isJapanese: this.settings.get('isJapanese'),
                    verbose: this.settings.get('verbose'),
                    crashOnSyncDrop: this.settings.get('crashOnSyncDrop'),
                    maxLevel: this.settings.get('maxLevel'),
                    convertToEggs: this.settings.get('convertToEggs'),
                    negotiationPrompt: (peerMode) => this.showNegotiationPrompt(peerMode)
                });
            }
        } else if (gen === '3') {
            this.protocol = new RSESPTrading(this.usb, this.ws, (msg) => this.log(msg),
                tradeType, isBuffered, doSanityChecks, {
                verbose: this.settings.get('verbose'),
                maxLevel: this.settings.get('maxLevel')
            });
        }

        // Surface a mid-trade server disconnect instead of letting the trade
        // loops poll a dead connection forever.
        const protocol = this.protocol;
        this.ws.onDisconnect = () => {
            if (!protocol.stopTrade) {
                this.log('Server connection lost - stopping trade.');
                protocol.stopTrade = true;
            }
        };

        this.tradePromise = (async () => {
            try {
                await protocol.startTrade();
            } catch (error) {
                this.log(`Trade error: ${error}`);
            } finally {
                this.ws.onDisconnect = null;
                if (protocol.stopVEC2Flood) protocol.stopVEC2Flood();
                if (this.ws.isConnected) this.ws.disconnect();
                if (this.protocol === protocol) this.resetTradeButton();
            }
        })();
        await this.tradePromise;
    }

    async stopTrade() {
        this.log('Stopping trade...');
        if (this.protocol) this.protocol.stopTrade = true;
        if (this.ws) this.ws.onDisconnect = null;
        if (this.ws && this.ws.isConnected) this.ws.disconnect();
        // Wait (bounded) for the trade loop to actually unwind before the
        // Start button can launch a new session against the same adapter.
        if (this.tradePromise) {
            await Promise.race([this.tradePromise, new Promise(r => setTimeout(r, 3000))]);
        }
        this.resetTradeButton();
        this.log('Trade stopped. You can start a new trade.');
    }

    resetTradeButton() {
        this.isTradeActive = false;
        this.elements.btnStartTrade.textContent = 'Start Trade';
        this.elements.btnStartTrade.disabled = false;
    }
}
