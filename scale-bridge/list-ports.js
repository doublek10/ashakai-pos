// Run with: npm run list-ports
// Prints every serial port the OS can see, so you can identify which
// one your weighing scale is plugged into before editing .env.
const { SerialPort } = require('serialport');

SerialPort.list()
  .then((ports) => {
    if (ports.length === 0) {
      console.log('No serial ports found. Is the scale plugged in and its USB/RS232 driver installed?');
      return;
    }
    console.log('Available serial ports:\n');
    for (const p of ports) {
      console.log(`  ${p.path}${p.manufacturer ? `  (${p.manufacturer})` : ''}`);
    }
    console.log('\nSet SCALE_PORT in scale-bridge/.env to the one your scale is on.');
  })
  .catch((err) => {
    console.error('Could not list serial ports:', err.message);
    process.exit(1);
  });
