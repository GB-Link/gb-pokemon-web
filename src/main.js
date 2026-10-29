
import { AppUI } from './ui/AppUI.js?v=100';
import { polyfillCountryFlagEmojis } from './vendor/country-flag-emoji-polyfill.js?v=100';

polyfillCountryFlagEmojis('Twemoji Country Flags', 'fonts/TwemojiCountryFlags.woff2');

document.addEventListener('DOMContentLoaded', () => {
    window.app = new AppUI();
});
