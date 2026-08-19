/**
 * POS Scale Bridge
 * ------------------------------------------------------------------
 * Reads continuous weight output from an RS232/USB weighing-scale
 * indicator and re-broadcasts each reading as JSON over a plain local
 * WebSocket, so the POS's browser tab (which cannot open a serial
 * port itself) can display live weight and let the cashier "capture"
 * it into the cart.
 *
 * Run this on the till computer the scale is physically plugged into:
 *   cd scale-bridge
 *   npm install
 *   cp .env.example .env      # then edit SCALE_PORT etc.
 *   npm start
 *
 * It is entirely optional — if it's not running, the POS just falls
 * back to manual weight entry. Nothing else breaks.
 */
require('dotenv').config();
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const WebSocket = require('ws');

const PORT = process.env.SCALE_PORT || 'COM3';
const BAUD_RATE = Number(process.env.SCALE_BAUD_RATE || 9600);
const DATA_BITS = Number(process.env.SCALE_DATA_BITS || 8);
const STOP_BITS = Number(process.env.SCALE_STOP_BITS || 1);
const PARITY = process.env.SCALE_PARITY || 'none';
const UNIT = process.env.SCALE_UNIT === 'g' ? 'g' : 'kg';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 4501);
const ALLOWED_ORIGINS = (process.env.BRIDGE_ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());

/**
 * Pulls the first signed decimal number out of a line of scale output.
 * Covers the vast majority of cheap/generic RS232 indicators, which
 * send lines like:
 *   "ST,+001.235kg\r\n"   (stable)
 *   "US,+012.500kg\r\n"   (unstable / still moving)
 *   "+   1.235 kg\r\n"
 *   "W: 1.235KG\r\n"
 *
 * "Stable" is guessed from an "ST"/"S" prefix, or the letter 'U'
 * ("unstable") to mark the reading as still-moving — if your
 * indicator doesn't send a stability flag at all, everything is
 * treated as stable. If your scale's format doesn't parse correctly,
 * adjust the regex below (check the indicator's serial-output spec in
 * its manual) — this is the only function you should need to touch.
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const numberMatch = trimmed.match(/[-+]?\d+(\.\d+)?/);
  if (!numberMatch) return null;
  const weight = parseFloat(numberMatch[0]);
  if (Number.isNaN(weight)) return null;

  const stable = !/^\s*U/i.test(trimmed) && !/unstable/i.test(trimmed);

  return { weight, unit: UNIT, stable };
}

// ------------------------------------------------------------------
// WebSocket server: the POS's browser tab connects here.
// ------------------------------------------------------------------
const wss = new WebSocket.Server({ port: BRIDGE_PORT }, () => {
  console.log(`[scale-bridge] listening for POS connections on ws://localhost:${BRIDGE_PORT}`);
});

let lastReading = null;

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.includes('*') && !ALLOWED_ORIGINS.includes(origin)) {
    ws.close(1008, 'origin not allowed');
    return;
  }
  console.log(`[scale-bridge] POS tab connected (${origin || 'unknown origin'})`);
  if (lastReading) ws.send(JSON.stringify(lastReading));
});

function broadcast(reading) {
  lastReading = reading;
  const payload = JSON.stringify(reading);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

// ------------------------------------------------------------------
// Serial port: the actual scale.
// ------------------------------------------------------------------
function startSerial() {
  const port = new SerialPort(
    { path: PORT, baudRate: BAUD_RATE, dataBits: DATA_BITS, stopBits: STOP_BITS, parity: PARITY, autoOpen: false },
    (err) => {
      if (err) {
        console.error(`[scale-bridge] Could not open serial port ${PORT}: ${err.message}`);
        console.error('[scale-bridge] Run "npm run list-ports" to see available ports. Retrying in 5s…');
      }
    }
  );

  port.open((err) => {
    if (err) {
      setTimeout(startSerial, 5000);
      return;
    }
    console.log(`[scale-bridge] connected to scale on ${PORT} @ ${BAUD_RATE} baud`);
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
  parser.on('data', (line) => {
    const reading = parseLine(line);
    if (reading) broadcast(reading);
  });

  port.on('close', () => {
    console.warn('[scale-bridge] serial port closed — retrying in 5s…');
    setTimeout(startSerial, 5000);
  });

  port.on('error', (err) => {
    console.error('[scale-bridge] serial error:', err.message);
  });
}

startSerial();

console.log('[scale-bridge] Press Ctrl+C to stop.');
