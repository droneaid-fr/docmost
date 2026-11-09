/** Fake model for tests: "alpha" -> "ALFA", "beta" -> "BETA"; everything else as is. */
export const fakeGenerate = async (_system: string, user: string) =>
  user.replace(/\balpha\b/g, 'ALFA').replace(/\bbeta\b/g, 'BETA');
