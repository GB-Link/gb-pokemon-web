# GBLink_Pokemon_Web

This is a web port from the CLI made by Lorenzooone, [original CLI implementation]([https://github.com/Lorenzooone/PokemonGB_Online_Trades_and_Battles). It allows you to trade or battle on your physical gen1-2 Pokemon games as well as Trade with Gen3.
Ported to Web by Starlark for easier access and wider device support.

## Features

- **WebUSB/WebSerial Support**: Connect your Game Boy Link Cable USB adapter directly to Chrome/Edge/Firefox.

- **Gen 1 (Red/Blue/Green/Yellow)

- **Gen 2 Support (Gold/Silver/Crystal)

- **Link Battles (Gen 1 & Gen 2)
- 
- **Multiboot**:
    - **Sending**: Sends the Gen3toGenx multiboot ROM to GBA. Using the Pokemon-Gen3-to-GenX project. https://github.com/Lorenzooone/Pokemon-Gen3-to-Gen-X

- **Gen 3 (Ruby/Sapphire/Emerald/FRLG)**: Working through the multiboot.

## Prerequisites

- **Google Chrome** or **Microsoft Edge** (browsers with WebUSB support).
- A **GB-Link Adapter** Using this firmware: [GBLink firmware](https://github.com/GB-Link/GBLink-Firmware/releases) or [reconfigurable firmware](https://github.com/starlarkus/gb-link-firmware-reconfigurable)
- Game Boy Color Link Cable

## Usage

1. Open the web page in a supported browser.
2. Connect your GB Link Cable USB Adapter to your computer.
3. Click **"Connect USB Device"** and select your adapter.
4. Select your game generation and trade mode.

### Playing on the emulator (no adapter needed)
- Press **Connect Emulator** instead of Connect USB. The Status box becomes a game screen.
- Choose your game's ROM (.gb or .gbc) and its save (.sav) together, or the ROM first and then the save with **Load save**. Generation and Game Language are set from the ROM. Your files stay on your device.
- The page keeps every game you load, with its save, in this browser. They are listed under **Kept in this browser** when you connect the emulator or press **Load other game** (which pauses the game you're playing): pick one to play it, or download its save or remove it with the buttons beside it. Games whose save changed since you last downloaded it are marked, and the page asks before that progress would be replaced or removed. Download the saves you want to keep: they are only in this browser.
- **Reset** restarts the game like the power switch; your save is kept.
- Gen 1 games run as on a Super Game Boy, in the colors the games made for it. The buttons next to the Game title turn sound on or off, add the game's Super Game Boy border, and go fullscreen. Red, Blue, Green, Yellow, Gold and Silver have a border; Gold and Silver keep their Game Boy Color colors inside it. Crystal and the Korean Gold and Silver have none. On a phone the on-screen buttons come along, beside the screen when the phone is turned sideways.
- Play with the keyboard (arrows, X or A = A, Z or S = B, Enter = Start, Shift = Select), a gamepad, or the on-screen buttons on a phone.
- Pick Trade, Battle or Pool Trade, press Start, then go to the Cable Club as on a real Game Boy. You can trade and battle with players on real hardware, on the emulator or on the Python CLI.
- When the game has saved (after a trade, for example) **Download save** gets a dot: press it to get your updated .sav.
- Gold, Silver and Crystal keep the time with a clock in the cartridge. A save from another emulator brings its clock along. A save without clock data, such as one dumped from a cartridge, starts the game's clock at your computer's time and day of the week; the cartridge's own clock is not changed when you put the save back.
- Gen 1 and Gen 2 games: Red, Blue, Green, Yellow, Gold, Silver and Crystal, in every language including Korean Gold/Silver. The downloaded save has the same format as the one you loaded, so a cartridge dump can go back onto the cartridge.

### Gen 2 Trading (Gold/Silver/Crystal)
- Go to the Pokémon Center Cable Club.
- Select "Start trade".
- Initiate Trade in game.
- For **Pool Trade**: The server will automatically select a Pokémon for you to receive.
- For **2-Player Trade**: Coordinate with another player in the same room.

### Battles (Gen 1 & Gen 2)
- Select your generation, pick **Battle**, and share a room code with the other player (they can use this web client or the Python CLI).
- Go to the Cable Club and enter the **Colosseum** (not the Trade Center).
- Notes ported from the Python client:
    - **Gen 2** waits between turns (default 30 s, changeable in Settings, skippable with the "Start turn now" button) because the inputs of the two games must stay in lockstep; very short waits (a second or two) can leave a game frozen at "Waiting...!". Beat Up is known to be risky.
    - **Gen 1** has no wait, but Counter, Mirror Move, Psywave, Fly, Dig and Mimic can desync the battle, and turn order can look odd.
    - Sanity checks validate the opponent's data and moves; if the data had to be fixed, the battle is stopped ("SOMETHING CHANGED"): both games stay at "Waiting...!" after the first move and need a reset.
    - In both generations, two Pokémon with exactly the same Speed desync the battle: each game thinks its own Pokémon moved first.
    - Gen 2's Whirlwind/Roar/Metronome/Mimic temporarily make the opponent's moves unverifiable.
    - **Buffered mode** starts with a ghost battle against a stand-in "FLEE" party: pick any action, then flee - the real battle follows.
    - Battles are not available for Gen 3 or Time Capsule.

### Languages and names
- For Gen 1 and 2, set **Game Language** (next to Generation) to the language of your cartridge: Japanese, English, French, Italian, German, Korean or Spanish. Korean Gold/Silver are supported. Gen 3 doesn't need it and shows Automatic, and Korean is only offered for Gen 2.
- You can trade between games of different languages, and mail is converted for the other game. When one game is Japanese or Korean and the other isn't, a **Buffered** trade is the safer choice, and if either party holds mail it is the only kind that works.
- **Profanity Filter** (on by default) blanks out offensive words in received nicknames and trainer names: usually the letter that completes the word is shown as "?", and some names are changed into a similar harmless word.
- **Default Pokémon Names** and **Default Trainer Names** replace received names with your game's defaults. They can be set separately for trades (off by default) and battles (Pokémon names on by default).

### Multiboot (GBA)
- Send multiboot homebrew to trade with gen3 games.

## Safety & Sanity Checks
Like the original project, this web port attempts to includes sanity checks to ensure that data received from other players (or the server) is valid and won't crash your game or corrupt your save.

## Credits
- The emulator is [mGBA](https://mgba.io) 0.10.5 by Jeffrey Pfau and contributors, used under the Mozilla Public License 2.0 (`emulator/LICENSE-mGBA.txt`). Its source is at [github.com/mgba-emu/mgba](https://github.com/mgba-emu/mgba/tree/0.10.5).
- Flags in the language list on Windows use the Twemoji Country Flags font from [country-flag-emoji-polyfill](https://github.com/talkjs/country-flag-emoji-polyfill) by TalkJS (MIT). The flag art is from [Twemoji](https://github.com/twitter/twemoji), used under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). Both licenses are in `fonts/LICENSE.md`.
