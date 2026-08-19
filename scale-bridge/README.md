# POS Scale Bridge

Connects an RS232/USB weighing scale to the POS.

A web browser cannot open a serial port directly, so this small
program does the actual talking to the scale, and re-broadcasts every
weight reading over a local WebSocket that the POS's "Products" and
"Till" screens connect to. **It's optional** — if it isn't running,
the POS simply falls back to typing the weight in manually. Nothing
else in the system depends on it.

## Setup (once, on the till computer the scale is plugged into)

1. Plug the scale into the till computer via USB or an RS232-to-USB
   adapter. Install its driver if Windows/macOS doesn't recognise it
   automatically (most USB-serial adapters use CH340, PL2303, or
   FTDI chips — search the adapter's brand + "driver" if it doesn't
   show up).
2. ```
   cd scale-bridge
   npm install
   npm run list-ports
   ```
   Note the port name your scale is on (e.g. `COM3`, or
   `/dev/ttyUSB0` on Linux, `/dev/tty.usbserial-XXXX` on macOS).
3. ```
   cp .env.example .env
   ```
   Edit `.env`:
   - `SCALE_PORT` — the port from step 2.
   - `SCALE_BAUD_RATE` — check your scale indicator's manual or DIP
     switches. 9600 is the most common default.
   - `SCALE_UNIT` — `kg` or `g`, whatever the scale is set to display.
4. ```
   npm start
   ```
   You should see `[scale-bridge] connected to scale on COM3 @ 9600 baud`.
   Put something on the scale — the terminal won't print anything by
   itself (readings only get logged when a POS tab is connected), but
   you can confirm it's working by opening the POS's till screen: the
   weight field should show a live "Scale connected" indicator.

## Running it automatically

So the cashier doesn't have to remember to start this every morning:

- **Windows**: put a shortcut to `npm start` (or `node server.js`) in
  the Startup folder (`shell:startup`), or use Task Scheduler to run
  it at logon.
- **macOS**: add it as a Login Item, or use `launchd`.
- **Linux**: add a systemd user service, or an `@reboot` cron entry.

It's a small always-on background process — expect it to use well
under 50MB of RAM.

## If the weight reading looks wrong

Different scale indicator brands format their continuous RS232 output
slightly differently. The parser in `server.js` (`parseLine`) handles
the common case — a plain signed decimal number somewhere in each
line, optionally prefixed with a stability flag like `ST,` (stable) or
`US,` (unstable). If your scale sends something the parser doesn't
pick up correctly:

1. Temporarily add `console.log(line)` inside the `parser.on('data', ...)`
   handler in `server.js` and restart — this prints exactly what the
   scale is sending, character for character.
2. Adjust the regex/logic in `parseLine()` to match that format. This
   is the only function you should ever need to edit.

## Multiple tills

Each till computer with a scale plugged into it needs to run its own
copy of this bridge (it talks to the scale physically attached to that
machine). The POS in the browser always connects to
`ws://localhost:4501` by default — i.e. "whatever scale is plugged
into the same computer this browser tab is running on" — which is
almost always what you want for a cash-register setup.
