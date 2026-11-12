
import { AppUI } from './ui/AppUI.js?v=104';
import { polyfillCountryFlagEmojis } from './vendor/country-flag-emoji-polyfill.js?v=104';

polyfillCountryFlagEmojis('Twemoji Country Flags', 'fonts/TwemojiCountryFlags.woff2');

document.addEventListener('DOMContentLoaded', () => {
    window.app = new AppUI();
});
