import { GameBoyEmulator } from '../emulator/GameBoyEmulator.js?v=103';
import { EmulatorInput } from '../emulator/EmulatorInput.js?v=103';
import { GameStore, gameId } from '../emulator/GameStore.js?v=103';
import { withLocalClock } from '../emulator/GameClock.js?v=103';
import { identifyRom, gameTitle } from '../emulator/RomInfo.js?v=103';

const ROM_EXT = /\.(gb|gbc|sgb)$/i;
const SAVE_EXT = /\.(sav|srm)$/i;
const MAX_SAVE_SIZE = 0x20000 + 0x100;

const svg = (body) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z"/>';
const ICONS = {
    soundOn: svg(`${SPEAKER}<path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>`),
    soundOff: svg(`${SPEAKER}<path d="M17 9.5l5 5M22 9.5l-5 5"/>`),
    border: svg('<rect x="2.5" y="4" width="19" height="16" rx="2"/><rect x="7.5" y="8.5" width="9" height="7"/>'),
    enterFullscreen: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
    exitFullscreen: svg('<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>'),
    download: svg('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>'),
    remove: svg('<path d="M4 7h16M10 7V4.5h4V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>'),
};

/**
 * The emulator inside the Status card: loading a game (ROM + battery save,
 * remembered in this browser), the screen, controls and save download.
 * AppUI decides which games can be used (acceptGame returns an error or null).
 */
export class EmulatorPanel {
    constructor(el, { acceptGame, onGameLoaded, onMessage, isInputActive }) {
        this.el = el;
        this.acceptGame = acceptGame;
        this.onGameLoaded = onGameLoaded;
        this.onMessage = onMessage;
        this.isInputActive = isInputActive;
        this.emulator = null;
        this.input = null;
        this.game = null;
        this.saveDirty = false;
        this._games = new Map();
        this._storeQueue = Promise.resolve();
        this.isOpen = false;
        this.isFullscreen = false;
        this._bound = false;
    }

    get hasGame() {
        return !!(this.emulator && this.emulator.loaded && this.game);
    }

    async open() {
        if (!this.emulator) this.emulator = await GameBoyEmulator.create();
        this._bind();
        this.isOpen = true;
        this.el.panel.hidden = false;
        this.emulator.setVolume(this._soundOn() ? 1 : 0);
        this.emulator.setSgbBorder(this._borderOn());
        this.emulator.onResize = (w, h) => this.el.screen.style.setProperty('--emu-ar', `${w} / ${h}`);
        this._renderSound();
        this._renderBorder();
        this._renderFullscreen();
        this.input = new EmulatorInput(this.emulator, {
            isActive: () => this.isOpen && this.hasGame && this.isInputActive(),
            touchArea: this.el.touch,
            onGesture: () => this._wakeAudio(),
        });
        this.input.attach();
        this.emulator.onSaveChange = (save) => this._saveChanged(save);
        this._showLoader(true);
        await this._renderLibrary();
    }

    close() {
        this.exitFullscreen();
        if (this.hasGame) this.emulator.checkSave();
        this.isOpen = false;
        if (this.input) this.input.detach();
        this.input = null;
        if (this.emulator) this.emulator.unload();
        this.game = null;
        this._setDirty(false);
        this.el.panel.hidden = true;
        this.el.view.hidden = true;
    }

    _bind() {
        if (this._bound) return;
        this._bound = true;
        const el = this.el;
        el.btnLoad.addEventListener('click', () => { this._wakeAudio(); el.file.click(); });
        el.btnReplace.addEventListener('click', () => { this._wakeAudio(); this._openLibrary(); });
        el.btnBack.addEventListener('click', () => { this._wakeAudio(); this._backToGame(); });
        el.libraryList.addEventListener('click', (e) => {
            const button = e.target.closest('button[data-action]');
            if (!button) return;
            this._wakeAudio();
            const id = button.closest('[data-id]').dataset.id;
            if (button.dataset.action === 'play') this._playKept(id);
            else if (button.dataset.action === 'download') this._downloadKept(id);
            else if (button.dataset.action === 'remove') this._removeKept(id);
        });
        el.file.addEventListener('change', () => {
            const files = Array.from(el.file.files || []);
            el.file.value = '';
            if (files.length) this.loadFiles(files);
        });
        el.btnLoadSave.addEventListener('click', () => { this._wakeAudio(); el.saveFile.click(); });
        el.saveFile.addEventListener('change', () => {
            const file = el.saveFile.files && el.saveFile.files[0];
            el.saveFile.value = '';
            if (file) this.loadSaveFile(file);
        });
        el.btnReset.addEventListener('click', () => { this._wakeAudio(); this.reset(); });
        el.btnDownload.addEventListener('click', () => this.downloadSave());
        el.btnSound.addEventListener('click', () => this._toggleSound());
        el.btnBorder.addEventListener('click', () => this._toggleBorder());
        el.btnFullscreen.addEventListener('click', () => (this.isFullscreen ? this.exitFullscreen() : this.enterFullscreen()));
        const fullscreenChanged = () => {
            if (this.isFullscreen && this._fullscreenApi && !fullscreenElement()) this.exitFullscreen();
        };
        document.addEventListener('fullscreenchange', fullscreenChanged);
        document.addEventListener('webkitfullscreenchange', fullscreenChanged);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isFullscreen && !fullscreenElement()) this.exitFullscreen();
        });
        el.screen.addEventListener('dragover', (e) => e.preventDefault());
        el.screen.addEventListener('drop', (e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length) this.loadFiles(files);
        });
    }

    _wakeAudio() {
        if (this.emulator) this.emulator.enableAudio().catch(() => {});
    }

    _soundOn() {
        try { return localStorage.getItem('gblink.emuSound') !== '0'; } catch (_) { return true; }
    }

    _toggleSound() {
        const on = !this._soundOn();
        try { localStorage.setItem('gblink.emuSound', on ? '1' : '0'); } catch (_) {}
        this.emulator.setVolume(on ? 1 : 0);
        if (on) this._wakeAudio();
        this._renderSound();
    }

    _renderSound() {
        const on = this._soundOn();
        renderIcon(this.el.btnSound, on ? ICONS.soundOn : ICONS.soundOff, 'Sound', on, on ? 'Sound: on' : 'Sound: off');
    }

    _borderOn() {
        try { return localStorage.getItem('gblink.emuBorder') === '1'; } catch (_) { return false; }
    }

    _toggleBorder() {
        const on = !this._borderOn();
        try { localStorage.setItem('gblink.emuBorder', on ? '1' : '0'); } catch (_) {}
        this.emulator.setSgbBorder(on);
        this._renderBorder();
    }

    /** Only games made for the Super Game Boy have a border. */
    _renderBorder() {
        const on = this._borderOn();
        this.el.btnBorder.hidden = !this.hasGame || !this.emulator.hasBorder;
        renderIcon(this.el.btnBorder, ICONS.border, 'Super Game Boy border', on, on ? 'Super Game Boy border: on' : 'Super Game Boy border: off');
    }

    /** The page goes fullscreen with only the game card showing; phones without the Fullscreen API get the same layout filling the window. */
    enterFullscreen() {
        if (this.isFullscreen || !this.hasGame) return;
        this.isFullscreen = true;
        document.body.classList.add('emu-fullscreen');
        this._renderFullscreen();
        const root = document.documentElement;
        const request = root.requestFullscreen || root.webkitRequestFullscreen;
        this._fullscreenApi = false;
        if (!request) return;
        try {
            const result = request.call(root, { navigationUI: 'hide' });
            this._fullscreenApi = true;
            if (result && result.catch) result.catch(() => { this._fullscreenApi = false; });
        } catch (_) {}
    }

    exitFullscreen() {
        if (!this.isFullscreen) return;
        this.isFullscreen = false;
        this._fullscreenApi = false;
        document.body.classList.remove('emu-fullscreen');
        this._renderFullscreen();
        if (fullscreenElement()) {
            const exit = document.exitFullscreen || document.webkitExitFullscreen;
            try {
                const result = exit.call(document);
                if (result && result.catch) result.catch(() => {});
            } catch (_) {}
        }
    }

    _renderFullscreen() {
        const on = this.isFullscreen;
        const label = on ? 'Exit fullscreen' : 'Fullscreen';
        renderIcon(this.el.btnFullscreen, on ? ICONS.exitFullscreen : ICONS.enterFullscreen, label, null, label);
    }

    _showLoader(show) {
        if (show) this.exitFullscreen();
        this.el.loader.hidden = !show;
        this.el.toolbar.hidden = show;
        this.el.view.hidden = show;
        this.el.screen.classList.toggle('empty', show);
        this.el.btnBack.hidden = !(show && this.hasGame);
        if (show && this.hasGame) this.el.btnBack.textContent = `Back to ${gameTitle(this.game.info)}`;
    }

    /** Pauses the game and shows the games kept in this browser, and the file chooser. */
    async _openLibrary() {
        if (!this.hasGame) return;
        this.emulator.stop();
        this.emulator.checkSave();
        this._showLoader(true);
        await this._renderLibrary();
    }

    _backToGame() {
        if (!this.hasGame) return;
        this._showLoader(false);
        this.emulator.start();
    }

    /** Store writes run one after another, so a download can't be overtaken by an older save. */
    _queue(write) {
        this._storeQueue = this._storeQueue.then(write, write);
        return this._storeQueue;
    }

    async _renderLibrary() {
        await this._storeQueue;
        const games = await GameStore.list();
        this._games = new Map(games.map((g) => [g.id, g]));
        const el = this.el;
        el.library.hidden = games.length === 0;
        el.loaderHint.hidden = games.length > 0;
        el.screen.classList.toggle('has-library', games.length > 0);
        const bytes = games.reduce((n, g) => n + g.romSize + (g.save ? g.save.length : 0), 0);
        el.librarySize.textContent = `${games.length} ${games.length === 1 ? 'game' : 'games'}, ${formatSize(bytes)}`;
        el.libraryList.replaceChildren(...games.map((g) => this._libraryRow(g)));
    }

    _libraryRow(game) {
        const running = this.hasGame && this.game.id === game.id;
        const title = game.info ? gameTitle(game.info) : game.name;
        const row = document.createElement('li');
        row.className = 'emu-game';
        row.dataset.id = game.id;
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'emu-game-play';
        play.dataset.action = 'play';
        play.title = running ? 'Back to the game' : `Play ${title}`;
        const name = document.createElement('span');
        name.className = 'emu-game-title';
        name.textContent = title;
        const meta = document.createElement('span');
        meta.className = 'emu-game-meta';
        meta.textContent = `${game.name} · ${running ? 'playing now' : `played ${formatWhen(game.playedAt)}`}`;
        play.append(name, meta);
        if (game.unsaved) {
            const badge = document.createElement('span');
            badge.className = 'emu-game-unsaved';
            badge.textContent = 'Saved since last download';
            play.append(badge);
        }
        const download = actionButton('download', ICONS.download, `Download the save of ${title}`, 'Download save');
        download.disabled = !game.save || !game.save.length;
        const remove = actionButton('remove', ICONS.remove, `Remove ${title} from this browser`, 'Remove from this browser');
        remove.hidden = running;
        row.append(play, download, remove);
        return row;
    }

    async _playKept(id) {
        if (this.hasGame && this.game.id === id) {
            this._backToGame();
            return;
        }
        const game = await GameStore.get(id);
        if (!game) {
            await this._renderLibrary();
            return;
        }
        this._start({ id, name: game.name, rom: game.rom, save: game.save, saveSize: game.saveSize, unsaved: game.unsaved,
            note: 'Continuing the game kept in this browser.' });
    }

    async _downloadKept(id) {
        if (this.hasGame && this.game.id === id) {
            await this.downloadSave();
        } else {
            const game = this._games.get(id);
            if (!game || !game.save) return;
            saveFile(`${game.name}.sav`, trimSave(game.save, game.saveSize));
            await this._queue(() => GameStore.markDownloaded(id));
        }
        await this._renderLibrary();
    }

    async _removeKept(id) {
        const game = this._games.get(id);
        if (!game || (this.hasGame && this.game.id === id)) return;
        const title = game.info ? gameTitle(game.info) : game.name;
        const question = game.unsaved
            ? `${title} has saved since its save was last downloaded. Remove the game and that save from this browser anyway?`
            : `Remove ${title} and its save from this browser? Save files you downloaded are not affected.`;
        if (!window.confirm(question)) return;
        await this._queue(() => GameStore.remove(id));
        await this._renderLibrary();
    }

    async loadFiles(files) {
        // Whatever the running game saved goes into the browser first
        if (this.hasGame) this.emulator.checkSave();
        let romFile = files.find((f) => ROM_EXT.test(f.name));
        let saveFile = files.find((f) => SAVE_EXT.test(f.name));
        for (const f of files) {
            if (f === romFile || f === saveFile) continue;
            if (!romFile && f.size > 0x10000) romFile = f;
            else if (!saveFile && f.size <= 0x10000) saveFile = f;
        }
        const save = saveFile ? new Uint8Array(await saveFile.arrayBuffer()) : null;
        if (!romFile) {
            if (!this.hasGame) {
                this.onMessage('Choose the ROM too', 'error', 'Select the game\'s .gb file together with its .sav.');
                return;
            }
            if (!this._confirmReplace()) return;
            this._useSave(save, saveFile.name);
            return;
        }
        if (romFile.size > 8 * 1024 * 1024) {
            this.onMessage('That file is too big to be a Game Boy ROM', 'error');
            return;
        }
        const rom = new Uint8Array(await romFile.arrayBuffer());
        const name = romFile.name.replace(ROM_EXT, '');
        const id = gameId(rom);
        await this._storeQueue;
        const kept = (await GameStore.list()).find((g) => g.id === id);
        if (save) {
            if (kept && kept.unsaved && !window.confirm(`${kept.info ? gameTitle(kept.info) : kept.name} kept in this browser has saved since its save was last downloaded. Loading ${saveFile.name} replaces that progress. Continue?`)) return;
            this._start({ id, name, rom, save, saveSize: save.length, note: `Loaded ${romFile.name} with ${saveFile.name}.` });
            return;
        }
        if (kept && kept.save) {
            this._start({ id, name, rom, save: kept.save, saveSize: kept.saveSize, unsaved: kept.unsaved, note: 'Using the save kept in this browser for this game.' });
            return;
        }
        this._start({ id, name, rom, save: null, note: 'No save loaded: the game starts without one. Use Load save to add your .sav.' });
    }

    /** Restarts the running game with another battery save. */
    async loadSaveFile(file) {
        if (!this.hasGame) return;
        if (ROM_EXT.test(file.name)) {
            this.onMessage('That is a ROM, not a save file', 'error', 'Use Load other game to switch games.');
            return;
        }
        if (file.size === 0 || file.size > MAX_SAVE_SIZE) {
            this.onMessage('That file doesn\'t look like a Game Boy save', 'error', 'Choose the game\'s .sav file.');
            return;
        }
        if (!this._confirmReplace()) return;
        this._useSave(new Uint8Array(await file.arrayBuffer()), file.name);
    }

    _useSave(save, fileName) {
        const { id, name, rom } = this.game;
        this._start({ id, name, rom, save, saveSize: save.length, note: `Loaded ${fileName}.` });
    }

    /** Asks before replacing progress the game saved since the last download. */
    _confirmReplace() {
        if (!this.saveDirty) return true;
        return window.confirm(`Pokémon ${this.game.info.version} has saved since your last Download save. Loading replaces that progress. Continue?`);
    }

    /** Power-cycles the game; the battery save is kept. */
    reset() {
        if (!this.hasGame) return;
        this.emulator.reset();
    }

    _start({ id, name, rom, save, saveSize = 0, unsaved = false, note }) {
        const info = identifyRom(rom);
        const problem = this.acceptGame(info);
        if (problem) {
            this.onMessage(problem, 'error');
            return;
        }
        const emu = this.emulator;
        if (this.hasGame) emu.checkSave();
        emu.stop();
        // Gen 1 shows the colors (and border) the games made for the Super Game Boy.
        // A Gen 2 save without clock data starts the game's clock at this computer's time.
        if (!emu.load(rom, withLocalClock(rom, save, info), { sgb: info.gen === 1 })) {
            this.game = null;
            this._showLoader(true);
            this.onMessage('The emulator could not start this ROM', 'error');
            return;
        }
        id = id ?? gameId(rom);
        this.game = { id, name, rom, info, saveSize };
        this._renderBorder();
        emu.attachCanvas(this.el.canvas);
        emu.start();
        this._showLoader(false);
        this._setDirty(unsaved);
        const kept = emu.getSave();
        this._queue(() => GameStore.put({ id, name, info, rom, save: kept, saveSize, unsaved }));
        this.onGameLoaded(info, note);
    }

    /** No cartridge swaps while a trade is running. */
    setTradeActive(active) {
        this.el.btnReplace.disabled = active;
        this.el.btnLoadSave.disabled = active;
        this.el.btnReset.disabled = active;
    }

    _saveChanged(save) {
        const { id } = this.game;
        this._queue(() => GameStore.updateSave(id, save));
        this._setDirty(true);
    }

    _setDirty(dirty) {
        this.saveDirty = dirty;
        this.el.btnDownload.classList.toggle('attention', dirty);
        this.el.btnDownload.title = dirty ? 'The game has saved since you last downloaded the save file' : '';
    }

    async downloadSave() {
        if (!this.hasGame) return;
        this.emulator.checkSave();
        const { id, name, saveSize } = this.game;
        saveFile(`${name}.sav`, trimSave(this.emulator.getSave(), saveSize));
        this._setDirty(false);
        await this._queue(() => GameStore.markDownloaded(id));
    }
}

function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function renderIcon(button, icon, label, pressed, title) {
    button.innerHTML = icon;
    button.title = title;
    button.setAttribute('aria-label', label);
    if (pressed === null) button.removeAttribute('aria-pressed');
    else button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

function actionButton(action, icon, label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn';
    button.dataset.action = action;
    button.innerHTML = icon;
    button.title = title;
    button.setAttribute('aria-label', label);
    return button;
}

/** Same format as the save that was loaded: a plain cartridge dump stays without the clock data. */
function trimSave(save, saveSize) {
    return saveSize && save.length > saveSize ? save.slice(0, saveSize) : save;
}

function saveFile(fileName, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatWhen(time) {
    const date = new Date(time);
    const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
    return date.toLocaleString([], { year, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
