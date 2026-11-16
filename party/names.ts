// Neutral room names: never user-supplied, so a name can't reveal a client or project.
const ADJ = [
  "amber", "azure", "brisk", "calm", "cedar", "coral", "crisp", "dusky", "ember", "fern", "frosty", "gentle", "golden",
  "hazel", "indigo", "ivory", "jade", "lunar", "maple", "misty", "mossy", "nimble", "ochre", "pale", "quiet", "rapid",
  "rosy", "rustic", "sandy", "silver", "slate", "solar", "stony", "sunny", "swift", "tawny", "teal", "velvet", "windy",
];
const NOUN = [
  "falcon", "otter", "heron", "badger", "lynx", "marten", "osprey", "puffin", "raven", "sparrow", "tern", "wren",
  "willow", "birch", "aspen", "harbor", "meadow", "canyon", "glacier", "lagoon", "summit", "valley", "comet", "delta",
  "ember", "fjord", "grove", "island", "mesa", "prairie", "reef", "ridge", "river", "tundra", "beacon", "lantern",
];

export function roomName(taken: (n: string) => boolean): string {
  const pick = (xs: string[]) => {
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return xs[b[0]! % xs.length]!;
  };
  for (let i = 0; i < 50; i++) {
    const n = `${pick(ADJ)}-${pick(NOUN)}`;
    if (!taken(n)) return n;
  }
  for (;;) {
    const b = new Uint16Array(1);
    crypto.getRandomValues(b);
    const n = `${pick(ADJ)}-${pick(NOUN)}-${b[0]! % 1000}`;
    if (!taken(n)) return n;
  }
}

export const ROOM_NAME_RE = /^[a-z]+-[a-z]+(-\d{1,3})?$/;
