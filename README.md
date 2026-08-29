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
    - **Gen 2** waits between turns (default 30 s, changeable in Settings, skippable with the "Start turn now" button) because the inputs of the two games must stay in lockstep. Beat Up is known to be risky.
    - **Gen 1** has no wait, but Counter, Mirror Move, Psywave, Fly, Dig and Mimic can desync the battle, and turn order can look odd.
    - Sanity checks validate the opponent's data and moves; if the data had to be fixed, the battle is aborted before it starts ("SOMETHING CHANGED").
    - Gen 2's Whirlwind/Roar/Metronome/Mimic temporarily make the opponent's moves unverifiable.
    - **Buffered mode** starts with a ghost battle against a stand-in "FLEE" party: pick any action, then flee - the real battle follows.
    - Battles are not available for Gen 3 or Time Capsule.

### Multiboot (GBA)
- Send multiboot homebrew to trade with gen3 games.

## Safety & Sanity Checks
Like the original project, this web port attempts to includes sanity checks to ensure that data received from other players (or the server) is valid and won't crash your game or corrupt your save.
