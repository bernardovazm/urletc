// The name a device carries until someone renames it, minted once on first boot.
//
// Shape: adjective-noun-NN, e.g. "quiet-otter-38". Two 32-word lists and a two-digit
// suffix give 32 * 32 * 100 = 102,400 names, against 900 for the older "peer-206": ten
// devices in one room now collide with probability 45/102400, under 0.05%.
//
// The rest of the app constrains the string: it must start with a letter (the roster
// builds an avatar from the first character), it must never be the bare word "peer"
// (senderLabel() reads that as "no name" and falls back to a key fingerprint), and it
// must stay clear of the roster's 24-character truncation and the handshake's
// MAX_NAME_CHARS. The longest name these lists can produce is 16 characters.
//
// Words are ASCII, pronounceable, and chosen to be neither common given names nor terms
// with a second meaning, since this label is shown to other people and no one reviews it
// before it goes out.

import { randomBytes } from './crypto'

const ADJECTIVES = [
  'brisk',
  'calm',
  'clear',
  'crisp',
  'deft',
  'dusky',
  'early',
  'fair',
  'fleet',
  'glad',
  'keen',
  'level',
  'light',
  'lucid',
  'mellow',
  'mild',
  'neat',
  'plain',
  'quiet',
  'rapid',
  'sleek',
  'snowy',
  'solar',
  'spry',
  'still',
  'sunny',
  'swift',
  'teal',
  'tidy',
  'warm',
  'wide',
  'wise',
]

const NOUNS = [
  'otter',
  'heron',
  'finch',
  'lark',
  'crane',
  'egret',
  'marten',
  'badger',
  'marmot',
  'bison',
  'cedar',
  'maple',
  'birch',
  'fern',
  'moss',
  'comet',
  'cinder',
  'basalt',
  'quartz',
  'pebble',
  'river',
  'meadow',
  'harbor',
  'summit',
  'canyon',
  'lagoon',
  'gorge',
  'ridge',
  'dune',
  'reef',
  'mesa',
  'atoll',
]

/** A fresh `adjective-noun-NN` handle. */
export function randomNickname(): string {
  // Same CSPRNG as the rest of the app rather than Math.random, which costs nothing here.
  // Both lists are 32 long, so those two modulos are exact; the suffix takes 16 bits so
  // the leftover skew across 0-99 is a fraction of a percent.
  const r = randomBytes(4)
  const suffix = ((r[0] << 8) | r[1]) % 100
  return `${ADJECTIVES[r[2] % ADJECTIVES.length]}-${NOUNS[r[3] % NOUNS.length]}-${String(suffix).padStart(2, '0')}`
}
