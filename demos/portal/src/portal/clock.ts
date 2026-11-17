// biome.json exempts this file from no-nondeterminism, so everything else reads the clock only through it.

export const wallClock = (): number => Date.now();
