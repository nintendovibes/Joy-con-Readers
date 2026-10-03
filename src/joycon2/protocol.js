// Copied from Bowser Jr (src/joycon2). Keep the copies in sync.
// Joy-Con 2 BLE protocol. Nothing here is official — it is community
// reverse-engineered, cross-checked between two independent projects:
//   https://github.com/mascii/joy-con-2-web-bluetooth-api-demo (Web Bluetooth)
//   https://github.com/seitanmen/Joycon2forMac               (CoreBluetooth)
// The Lab page exists to verify these offsets on real hardware.

export const NINTENDO_COMPANY_ID = 0x0553

export const SERVICE_UUID = 'ab7de9be-89fe-49ad-828f-118f09df7fd0'
export const INPUT_CHAR_UUID = 'ab7de9be-89fe-49ad-828f-118f09df7fd2'
export const COMMAND_CHAR_UUID = '649d4ac9-8eb7-4e6c-af44-1ea54fe5f005'
// Replies to commands written to COMMAND_CHAR_UUID arrive here. From
// https://github.com/ndeadly/switch2_controller_research (bluetooth_interface.md)
export const COMMAND_RESPONSE_CHAR_UUID = 'c765a961-d9d8-4d36-a20a-5315b111836a'

// Command header: [command, 0x91 = host→device, 0x01 = Bluetooth,
// subcommand, 0x00, data length, 0x00, 0x00] followed by the data.
// Replies use the same header with 0x01 in the direction byte.
export const COMMAND_HEADER_LENGTH = 8

export function buildCommand(command, subcommand, data = []) {
  return new Uint8Array([command, 0x91, 0x01, subcommand, 0x00, data.length, 0x00, 0x00, ...data])
}

// Rumble: "play vibration sample". The console plays sample 3 on connect;
// other sample numbers are untested.
export const CMD_VIBRATION = 0x0a
export const SUB_PLAY_SAMPLE = 0x02

// NFC (right Joy-Con only — the reader sits under the stick). The subcommands
// come from ndeadly's research; the flow below was worked out on hardware.
// START_POLL's data is copied from what the console sends; 0x03e8 (1000)
// matches the observed ~1.2 s search timeout. After timing out the reader
// stays in NFC_STATE_TIMED_OUT and ignores another START until STOP is sent.
// GET_STATUS replies: data[0] is the state; with a tag, data[8] is the UID
// length followed by the UID bytes.
export const CMD_NFC = 0x01
export const NFC_START_POLL = { sub: 0x03, data: [0x00, 0xe8, 0x03, 0x2c, 0x01] }
export const NFC_STOP_POLL = { sub: 0x04, data: [] }
export const NFC_GET_STATUS = { sub: 0x05, data: [] }

export const NFC_STATE_IDLE = 0x00
export const NFC_STATE_POLLING = 0x01
export const NFC_STATE_TIMED_OUT = 0x07   // seen as 07 41
export const NFC_STATE_TAG_FOUND = 0x09   // from the documented example reply

export const NFC_STATE_NAMES = {
  [NFC_STATE_IDLE]: 'idle',
  [NFC_STATE_POLLING]: 'searching',
  [NFC_STATE_TIMED_OUT]: 'timed out',
  [NFC_STATE_TAG_FOUND]: 'tag found',
}

const NFC_UID_LENGTH_OFFSET = 8
const VALID_UID_LENGTHS = new Set([4, 7, 10])

export function parseCommandResponse(bytes) {
  return {
    command: bytes[0],
    subcommand: bytes[3],
    ack: bytes[5],
    data: bytes.slice(COMMAND_HEADER_LENGTH),
    raw: bytes,
  }
}

// Returns the tag UID as uppercase hex (matching the API's band UIDs), or
// null when no tag is present.
export function parseNfcStatus(data) {
  const len = data[NFC_UID_LENGTH_OFFSET]
  if (!VALID_UID_LENGTHS.has(len)) return null
  const uid = data.slice(NFC_UID_LENGTH_OFFSET + 1, NFC_UID_LENGTH_OFFSET + 1 + len)
  if (uid.length !== len || uid.every(b => b === 0)) return null
  return Array.from(uid, b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

// Product IDs appear little-endian at bytes 5-6 of the BLE manufacturer data.
export const SIDES = {
  L: { label: 'Joy-Con 2 (L)', productId: 0x2067 },
  R: { label: 'Joy-Con 2 (R)', productId: 0x2066 },
}

// Sent after connecting to start the input stream. Joycon2forMac describes
// them as "standard data" and "extended data" (the latter adds motion).
export const CMD_ENABLE_STANDARD = [0x0c, 0x91, 0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00]
export const CMD_ENABLE_EXTENDED = [0x0c, 0x91, 0x01, 0x04, 0x00, 0x04, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00]

// Player-indicator LEDs: the low 4 bits are the 4 lights.
export const PLAYER_LIGHT_PATTERNS = [0x01, 0x03, 0x07, 0x0f]

export function playerLightsCommand(pattern) {
  return new Uint8Array([0x09, 0x91, 0x01, 0x07, 0x00, 0x08, 0x00, 0x00, pattern & 0xff, 0, 0, 0, 0, 0, 0, 0])
}

// Buttons are a little-endian uint32 at offset 3. `side` is the Joy-Con the
// button physically lives on. SL/SR exist on both, with separate bits.
export const BUTTONS = [
  { id: 'Y',       bit: 0x00000100, side: 'R', label: 'Y',  name: 'Y' },
  { id: 'X',       bit: 0x00000200, side: 'R', label: 'X',  name: 'X' },
  { id: 'B',       bit: 0x00000400, side: 'R', label: 'B',  name: 'B' },
  { id: 'A',       bit: 0x00000800, side: 'R', label: 'A',  name: 'A' },
  { id: 'SR_R',    bit: 0x00001000, side: 'R', label: 'SR', name: 'SR (rail)' },
  { id: 'SL_R',    bit: 0x00002000, side: 'R', label: 'SL', name: 'SL (rail)' },
  { id: 'R',       bit: 0x00004000, side: 'R', label: 'R',  name: 'R' },
  { id: 'ZR',      bit: 0x00008000, side: 'R', label: 'ZR', name: 'ZR' },
  { id: 'MINUS',   bit: 0x00010000, side: 'L', label: '−',  name: 'Minus' },
  { id: 'PLUS',    bit: 0x00020000, side: 'R', label: '+',  name: 'Plus' },
  { id: 'RS',      bit: 0x00040000, side: 'R', label: 'RS', name: 'Stick click' },
  { id: 'LS',      bit: 0x00080000, side: 'L', label: 'LS', name: 'Stick click' },
  { id: 'HOME',    bit: 0x00100000, side: 'R', label: '⌂',  name: 'Home' },
  { id: 'CAPTURE', bit: 0x00200000, side: 'L', label: '●',  name: 'Capture' },
  { id: 'C',       bit: 0x00400000, side: 'R', label: 'C',  name: 'C (GameChat)' },
  { id: 'DOWN',    bit: 0x01000000, side: 'L', label: '▼',  name: 'D-pad down' },
  { id: 'UP',      bit: 0x02000000, side: 'L', label: '▲',  name: 'D-pad up' },
  { id: 'RIGHT',   bit: 0x04000000, side: 'L', label: '▶',  name: 'D-pad right' },
  { id: 'LEFT',    bit: 0x08000000, side: 'L', label: '◀',  name: 'D-pad left' },
  { id: 'SR_L',    bit: 0x10000000, side: 'L', label: 'SR', name: 'SR (rail)' },
  { id: 'SL_L',    bit: 0x20000000, side: 'L', label: 'SL', name: 'SL (rail)' },
  { id: 'L',       bit: 0x40000000, side: 'L', label: 'L',  name: 'L' },
  { id: 'ZL',      bit: 0x80000000, side: 'L', label: 'ZL', name: 'ZL' },
]

export const isPressed = (buttons, bit) => (buttons & bit) !== 0

// Byte ranges of each known field, for labelling the raw packet view.
export const FIELDS = [
  { key: 'packet',  name: 'Packet counter', start: 0x00, end: 0x02 },
  { key: 'buttons', name: 'Buttons',        start: 0x03, end: 0x06 },
  { key: 'stickL',  name: 'Left stick',     start: 0x0a, end: 0x0c },
  { key: 'stickR',  name: 'Right stick',    start: 0x0d, end: 0x0f },
  { key: 'mouse',   name: 'Mouse sensor',   start: 0x10, end: 0x17 },
  { key: 'mag',     name: 'Magnetometer',   start: 0x18, end: 0x1d },
  { key: 'battery', name: 'Battery',        start: 0x1f, end: 0x20 },
  { key: 'current', name: 'Current',        start: 0x28, end: 0x29 },
  { key: 'temp',    name: 'Temperature',    start: 0x2e, end: 0x2f },
  { key: 'accel',   name: 'Accelerometer',  start: 0x30, end: 0x35 },
  { key: 'gyro',    name: 'Gyroscope',      start: 0x36, end: 0x3b },
  { key: 'trigger', name: 'Triggers',       start: 0x3c, end: 0x3d },
]

export function fieldForOffset(offset) {
  return FIELDS.find(f => offset >= f.start && offset <= f.end) ?? null
}

// Motion is the last field we rely on, so anything shorter can't be parsed.
export const REPORT_MIN_LENGTH = 0x3c

// Accelerometer reads ~4096 at rest along gravity (Joycon2forMac's sample
// log: |(-1311, 1250, 3702)| ≈ 4121), so treat it as counts per g.
export const ACCEL_COUNTS_PER_G = 4096

function readStick(dv, offset) {
  const b0 = dv.getUint8(offset)
  const b1 = dv.getUint8(offset + 1)
  const b2 = dv.getUint8(offset + 2)
  return { x: b0 | ((b1 & 0x0f) << 8), y: (b1 >> 4) | (b2 << 4) }
}

export function parseReport(dv) {
  const len = dv.byteLength
  const i16 = o => (o + 2 <= len ? dv.getInt16(o, true) : 0)
  const u8 = o => (o < len ? dv.getUint8(o) : 0)
  return {
    packetId: dv.getUint8(0) | (dv.getUint8(1) << 8) | (dv.getUint8(2) << 16),
    buttons: dv.getUint32(3, true),
    stickL: readStick(dv, 0x0a),
    stickR: readStick(dv, 0x0d),
    mouse: { x: dv.getUint16(0x10, true), y: dv.getUint16(0x12, true), distance: i16(0x16) },
    mag: { x: i16(0x18), y: i16(0x1a), z: i16(0x1c) },
    batteryVolts: dv.getUint16(0x1f, true) / 1000,
    currentAmps: i16(0x28) / 100,
    temperatureC: 25 + i16(0x2e) / 127,
    accel: { x: i16(0x30), y: i16(0x32), z: i16(0x34) },
    gyro: { x: i16(0x36), y: i16(0x38), z: i16(0x3a) },
    triggers: { l: u8(0x3c), r: u8(0x3d) },
  }
}
