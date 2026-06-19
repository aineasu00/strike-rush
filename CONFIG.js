window.STRIKE_RUSH_CONFIG = Object.freeze({
  appName: "Strike Rush",
  bowlingName: "NEON BOWL",
  colors: {
    charcoal: "#0D0D0D",
    pink: "#FF2E63",
    cyan: "#08D9D6",
    violet: "#533483",
    offWhite: "#EAEAEA"
  },
  game: {
    maxPlayers: 9,
    startingCredits: 1000,
    bettingSeconds: 20,
    totalFrames: 10,
    lobbyTtlHours: 24,
    minBet: 10,
    maxBet: 500
  },
  realtime: {
    // "supabase" fonctionne entre réseaux différents. "local" sert aux tests hors ligne.
    mode: "supabase",
    supabaseUrl: "https://mlvdutlvcadoifojoxzh.supabase.co",
    supabaseAnonKey: "sb_publishable_WQRDRw-Mrq6rT69Xp1OQaQ_-ikRJkVU"
  },
  ui: {
    musicMutedByDefault: true,
    reducedMotion: false
  }
});
