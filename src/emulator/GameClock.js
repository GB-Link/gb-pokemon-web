/**
 * Gold, Silver and Crystal keep the time on a clock in the cartridge; the save
 * holds what the game adds to it (set when the player sets the time). Emulators
 * store the clock in a 48-byte record after the save. A save without one (a
 * cartridge dump) gets a record that makes the game show this computer's time.
 */
const JAPANESE = 1, KOREAN = 6;
const RECORD_SIZE = 48;
const SRAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];
const CLOCK_CARTS = [0x0F, 0x10];
// The game's day counter wraps here (it keeps the cartridge's day count below 140)
const DAY_WRAP = 140;

// Save offsets of the day/hour/minute/second added to the clock, and of the
// game's last day count (Japanese names are 6 bytes, the others 11)
const LAYOUTS = {
    Gold: { start: 0x2044, day: 0x205A }, Silver: { start: 0x2044, day: 0x205A }, Crystal: { start: 0x2044, day: 0x2059 },
};
const JAPANESE_LAYOUT = { start: 0x202B, day: 0x203B };
const KOREAN_LAYOUT = { start: 0x2044, day: 0x2054 };

/**
 * The cartridge clock (days, hours, minutes, seconds) that makes the game show
 * `now`, or null when the save holds no valid time. The day count continues
 * from the save's last day, on the right day of the week.
 */
export function clockForLocalTime(save, info, now = new Date()) {
    const layout = info.language === JAPANESE ? JAPANESE_LAYOUT : info.language === KOREAN ? KOREAN_LAYOUT : LAYOUTS[info.version];
    if (!layout) return null;
    const [startDay, startHour, startMinute, startSecond] = save.subarray(layout.start, layout.start + 4);
    if (startDay > 6 || startHour > 23 || startMinute > 59 || startSecond > 59) return null;

    let time = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() - (startHour * 3600 + startMinute * 60 + startSecond);
    const carry = time < 0 ? 1 : 0;
    if (carry) time += 86400;
    let days = save[layout.day] - startDay - carry;
    if (days < 0 || days >= DAY_WRAP) days = 0;
    days += (((now.getDay() - startDay - carry - days) % 7) + 7) % 7;
    if (days >= DAY_WRAP) days -= DAY_WRAP;
    return { days, hours: Math.floor(time / 3600), minutes: Math.floor(time / 60) % 60, seconds: time % 60 };
}

/** The save with a clock record set to this computer's time, when it is a Gen 2 cartridge save without one. */
export function withLocalClock(rom, save, info, now = new Date()) {
    if (!save || !info || info.gen !== 2 || !CLOCK_CARTS.includes(rom[0x147])) return save;
    if (save.length !== SRAM_SIZES[rom[0x149]]) return save;
    const clock = clockForLocalTime(save, info, now);
    if (!clock) return save;
    const out = new Uint8Array(save.length + RECORD_SIZE);
    out.set(save);
    const view = new DataView(out.buffer, save.length);
    // Current and latched registers, then the time they were read
    const regs = [clock.seconds, clock.minutes, clock.hours, clock.days & 0xFF, clock.days >> 8];
    regs.forEach((v, i) => {
        view.setUint32(i * 4, v, true);
        view.setUint32(20 + i * 4, v, true);
    });
    view.setBigUint64(40, BigInt(Math.floor(now.getTime() / 1000)), true);
    return out;
}
