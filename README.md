# GBLink_Pokemon_Web

This is a work in progress JavaScript-based web application for **PokemonGB_Online_Trades**, ported from the [original Python implementation](https://github.com/Lorenzooone/PokemonGB_Online_Trades). It allows you to trade Pokémon from your physical Game Boy cartridges directly in the browser using WebUSB.

## Features

- **WebUSB Support**: Connect your Game Boy Link Cable USB adapter directly to Chrome/Edge without installing Python drivers.

- **Gen 1 (Red/Blue/Green/Yellow)**:
    - **International Versions**: Fully working (Pool Trade & 2-Player).
    - **Japanese Versions**: Not tested.

- **Gen 2 Support (Gold/Silver/Crystal)**:
    - **International Versions**: Fully working (Pool Trade & 2-Player).
    - **Japanese Versions**: Not tested.
    - **Mail**: Not tested.

- **Link Battles (Gen 1 & Gen 2)**:
    - 2-Player battles over the same server as the Python client (the two are interoperable - a web player can battle a CLI player).
    - Japanese versions supported the same way as the Python client (no mail, name fillers handled).
    - Not tested on real hardware yet.
- **Multiboot**:
    - **Sending**: Sends the Gen3toGenx multiboot ROM to GBA. Using the Pokemon-Gen3-to-GenX project. https://github.com/Lorenzooone/Pokemon-Gen3-to-Gen-X

- **Gen 3 (Ruby/Sapphire/Emerald/FRLG)**: Not working yet.

## Prerequisites

- **Google Chrome** or **Microsoft Edge** (browsers with WebUSB support).
- A **Game Boy Link Cable to USB Adapter** Using this firmware: [GBLink firmware](https://github.com/starlarkus/GBLink-Firmware) or [reconfigurable firmware (legacy)](https://github.com/starlarkus/gb-link-firmware-reconfigurable)
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

## Troubleshooting
- Currently when refreshing the web page most of the time the pico/usb device needs to be reset. Unplugging or pressing reset on the USB adapter should acomplish this
- If on linux you may need to edit Udev rules. See here https://stackoverflow.com/questions/30983221/chrome-app-fails-to-open-usb-device

### Multiboot (GBA)
- Connect your GBA via the link cable with no cartridge inserted.
- Click **"Send Multiboot"** to transfer the multiboot ROM to GBA.

## Safety & Sanity Checks
Like the original project, this web port attempts to includes sanity checks to ensure that data received from other players (or the server) is valid and won't crash your game or corrupt your save.

## Credits
- Based on [PokemonGB_Online_Trades](https://github.com/Lorenzooone/PokemonGB_Online_Trades) by Lorenzooone.
- Ported to JavaScript/WebUSB for easier access.
