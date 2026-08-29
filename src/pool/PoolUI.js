/**
 * PoolUI.js - Renders the pool viewer: a summary strip, a grid of cards and
 * a detail panel for the selected Pokemon.
 */

import { PoolData } from '../services/PoolData.js?v=91';
import { SettingsManager } from '../services/SettingsManager.js?v=91';

export class PoolUI {
    constructor() {
        this.settings = new SettingsManager();
        this.gen = 2;
        this.pool = null;
        this.filter = '';
        this.sort = 'dex';
        this.el = {
            genSelect: document.getElementById('pool-gen-select'),
            search: document.getElementById('pool-search'),
            sort: document.getElementById('pool-sort'),
            refresh: document.getElementById('btn-pool-refresh'),
            status: document.getElementById('pool-status'),
            summary: document.getElementById('pool-summary'),
            grid: document.getElementById('pool-grid'),
            modal: document.getElementById('pool-modal'),
            modalBody: document.getElementById('pool-modal-body'),
            modalClose: document.getElementById('pool-modal-close'),
        };
        this.attach();
        this.applyTheme();
        this.load();
    }

    applyTheme() {
        document.body.classList.toggle('light-mode', !this.settings.get('darkMode'));
    }

    /** The pool dump lives on the same server as the trade socket. */
    baseUrl() {
        const raw = (this.settings.get('serverUrl') || '').trim().replace(/\/$/, '');
        return raw.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    }

    attach() {
        this.el.genSelect.querySelectorAll('.btn-option').forEach(btn => {
            btn.addEventListener('click', () => {
                this.el.genSelect.querySelectorAll('.btn-option').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                this.gen = parseInt(btn.dataset.value, 10);
                this.load();
            });
        });
        this.el.refresh.addEventListener('click', () => this.load());
        this.el.search.addEventListener('input', () => { this.filter = this.el.search.value.trim().toLowerCase(); this.renderGrid(); });
        this.el.sort.addEventListener('change', () => { this.sort = this.el.sort.value; this.renderGrid(); });
        this.el.modalClose.addEventListener('click', () => this.closeModal());
        this.el.modal.addEventListener('click', (e) => { if (e.target === this.el.modal) this.closeModal(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeModal(); });
    }

    setStatus(text, type = '') {
        this.el.status.textContent = text;
        this.el.status.dataset.type = type;
    }

    async load() {
        const base = this.baseUrl();
        this.setStatus('Loading pool…');
        this.el.grid.innerHTML = '';
        this.el.summary.innerHTML = '';
        try {
            this.pool = await PoolData.fetch(base, this.gen);
            this.setStatus(`${this.pool.mons.length} Pokemon in the pool`, 'success');
            this.renderSummary();
            this.renderGrid();
        } catch (e) {
            this.pool = null;
            this.setStatus(`Could not load pool: ${e.message}`, 'error');
        }
    }

    renderSummary() {
        const s = PoolData.summarize(this.pool);
        const tiles = [
            ['Pokemon', s.total], ['Unique species', s.unique], ['Average level', s.avgLevel],
            ['Shiny', s.shiny],
        ];
        // Gen 1 games have neither eggs nor held items
        if (this.gen !== 1) tiles.push(['Eggs', s.eggs], ['Held items', s.holding]);
        this.el.summary.innerHTML =
            tiles.map(([label, value]) => `<div class="pool-stat"><span class="pool-stat-value">${value}</span><span class="pool-stat-label">${label}</span></div>`).join('') +
            (s.top.length ? `<div class="pool-stat pool-stat-wide"><span class="pool-stat-label">Most common</span><span class="pool-top">${s.top.map(([n, c]) => `${this.esc(n)} <b>x${c}</b>`).join(' &middot; ')}</span></div>` : '');
    }

    visibleMons() {
        let mons = this.pool ? [...this.pool.mons] : [];
        if (this.filter) {
            mons = mons.filter(m =>
                m.speciesName.toLowerCase().includes(this.filter) ||
                (m.nickname || '').toLowerCase().includes(this.filter) ||
                (m.otName || '').toLowerCase().includes(this.filter));
        }
        const by = {
            name: (a, b) => a.speciesName.localeCompare(b.speciesName),
            level: (a, b) => b.level - a.level,
            dex: (a, b) => a.national - b.national,
        }[this.sort] || ((a, b) => a.national - b.national);
        return mons.sort(by);
    }

    renderGrid() {
        if (!this.pool) return;
        const mons = this.visibleMons();
        if (!mons.length) {
            this.el.grid.innerHTML = '<p class="pool-empty">No Pokemon match that search.</p>';
            return;
        }
        this.el.grid.innerHTML = mons.map(m => {
            const badges = [
                m.isShiny ? `<span class="pool-badge shiny"${this.shinyTitle(m)}>Shiny</span>` : '',
                m.isEgg ? '<span class="pool-badge egg">Egg</span>' : '',
                m.item ? `<span class="pool-badge item">${this.esc(m.item.name || `Item #${m.item.id}`)}</span>` : '',
            ].join('');
            const title = m.nickname && m.nickname !== m.speciesName ? m.nickname : m.speciesName;
            return `<button class="pool-card" data-slot="${m.slot}">
                ${this.spriteMarkup(m)}
                <div class="pool-name">${this.esc(title)}</div>
                <div class="pool-sub">${this.esc(m.speciesName)}${m.level ? ` &middot; Lv${m.level}` : ''}</div>
                <div class="pool-badges">${badges}</div>
            </button>`;
        }).join('');
        this.el.grid.querySelectorAll('.pool-card').forEach(card => {
            card.addEventListener('click', () => this.openModal(parseInt(card.dataset.slot, 10)));
        });
    }

    openModal(slot) {
        const m = this.pool?.mons.find(x => x.slot === slot);
        if (!m) return;
        const row = (label, value) => (value === null || value === undefined || value === '') ? ''
            : `<div class="pool-row"><span>${this.esc(label)}</span><b>${this.esc(String(value))}</b></div>`;
        const block = (title, rows) => rows ? `<div class="pool-detail-block"><h4>${title}</h4>${rows}</div>` : '';
        const moves = block('Moves', m.moves.map(mv =>
            `<div class="pool-row"><span>${this.esc(mv.name || `Move #${mv.id}`)}</span><b>${mv.pp} PP</b></div>`).join(''));
        const stats = block('Stats', m.stats.map(([n, v]) =>
            `<div class="pool-row"><span>${this.esc(n)}</span><b>${v}</b></div>`).join(''));
        const ivs = block(m.gen === 3 ? 'IVs' : 'DVs', m.ivs.map(([n, v]) =>
            `<div class="pool-row"><span>${this.esc(n)}</span><b>${v}</b></div>`).join(''));
        this.el.modalBody.innerHTML = `
            <div class="pool-detail-head">
                ${this.spriteMarkup(m, true)}
                <div>
                    <h3>${this.esc(m.nickname || m.speciesName)}</h3>
                    <p class="pool-sub">${this.esc(m.speciesName)}${m.national ? ` &middot; #${m.national}` : ''}${m.level ? ` &middot; Level ${m.level}` : ''}</p>
                    <div class="pool-badges">
                        ${m.isShiny ? `<span class="pool-badge shiny"${this.shinyTitle(m)}>Shiny</span>` : ''}
                        ${m.isEgg ? '<span class="pool-badge egg">Egg</span>' : ''}
                    </div>
                </div>
            </div>
            <div class="pool-detail-grid">
                ${block('Trainer', row('OT name', m.otName) + row('OT ID', m.otId))}
                ${block('Details', row('Held item', m.item ? (m.item.name || `Item #${m.item.id}`) : null) +
                    row('Nature', m.nature) + row('Friendship', m.friendship) + row('EXP', m.exp) +
                    row('Current HP', m.currHp) + row('Inside the egg', m.hatchName))}
                ${stats}${moves}${ivs}
            </div>`;
        this.el.modal.style.display = 'flex';
        this.wireEggReveal();
    }

    /**
     * In the detail view an egg reveals what is inside: hovering shows it on a
     * pointer, tapping toggles it for touch. Opacity is set directly because
     * the sprites are built while the modal is still hidden.
     */
    wireEggReveal() {
        const sprite = this.el.modalBody.querySelector('.egg-swap');
        if (!sprite) return;
        const eggImg = sprite.querySelector('.egg');
        const hatchImg = sprite.querySelector('.hatch');
        if (!eggImg || !hatchImg) return;
        let revealed = false;
        const show = (on) => {
            eggImg.style.opacity = on ? '0' : '1';
            hatchImg.style.opacity = on ? '1' : '0';
        };
        show(false);
        sprite.addEventListener('mouseenter', () => show(true));
        sprite.addEventListener('mouseleave', () => show(revealed));
        sprite.addEventListener('click', () => { revealed = !revealed; show(revealed); });
    }

    closeModal() { this.el.modal.style.display = 'none'; }

    /**
     * Sprite markup. An egg shows the egg sprite with the species underneath,
     * revealed on hover.
     */
    spriteMarkup(m, big = false) {
        const sprite = PoolData.spriteUrl(m);
        const cls = `pool-sprite${big ? ' big' : ''}`;
        const lazy = big ? '' : ' loading="lazy"';
        const fallback = PoolData.spriteFallbackUrl(m) || '';
        const onerror = `onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.dataset.fallback='';}else{this.remove();}"`;
        if (!sprite) return `<div class="${cls}"></div>`;
        if (m.isEgg) {
            return `<div class="${cls} egg-swap">
                <img class="hatch" src="${sprite}" alt=""${lazy} data-fallback="${fallback}" ${onerror}>
                <img class="egg" src="${PoolData.EGG_SPRITE}" alt="Egg"${lazy}>
            </div>`;
        }
        return `<div class="${cls}"><img src="${sprite}" alt=""${lazy} data-fallback="${fallback}" ${onerror}></div>`;
    }

    shinyTitle(m) {
        return m.gen === 1
            ? ' title="Shiny DVs - Gen 1 cannot show this, but it appears shiny once traded to Gen 2"'
            : '';
    }

    esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
}
