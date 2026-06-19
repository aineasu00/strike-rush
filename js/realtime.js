(function () {
  "use strict";

  const config = window.STRIKE_RUSH_CONFIG;
  const STORAGE_PREFIX = "strike-rush-room:";
  const id = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const roomKey = (code) => `${STORAGE_PREFIX}${code}`;
  const now = () => Date.now();
  const cleanCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const generateCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

  function emptyRoom(code) {
    return {
      code,
      createdAt: now(),
      updatedAt: now(),
      phase: "lobby",
      frame: 0,
      bettingEndsAt: 0,
      bowler: "Joueur libre",
      players: {},
      bets: {},
      chats: [],
      lastResult: null
    };
  }

  function multiplierFor(streak) {
    if (streak >= 4) return 5;
    if (streak === 3) return 3;
    if (streak === 2) return 2;
    return 1;
  }

  function predictionMatches(prediction, result) {
    if (prediction === "strike") return result.type === "strike" || Number(result.pins) === 10;
    if (prediction === "spare") return result.type === "spare";
    if (prediction === "0") return result.type === "pins" && Number(result.pins) === 0;
    return result.type === "pins" && Number(result.pins) >= 1 && Number(result.pins) <= 9;
  }

  class LocalTransport {
    constructor(onMessage) {
      this.onMessage = onMessage;
      this.channel = new BroadcastChannel("strike-rush");
      this.channel.onmessage = ({ data }) => this.onMessage(data);
      window.addEventListener("storage", (event) => {
        if (event.key?.startsWith(STORAGE_PREFIX) && event.newValue) {
          this.onMessage({ type: "state", state: JSON.parse(event.newValue) });
        }
      });
    }
    publish(message) { this.channel.postMessage(message); }
    close() { this.channel.close(); }
  }

  class StrikeRushRealtime {
    constructor(role) {
      this.role = role;
      this.roomCode = "";
      this.clientId = sessionStorage.getItem("strike-rush-client-id") || id();
      this.playerToken = sessionStorage.getItem("strike-rush-player-token") || id();
      sessionStorage.setItem("strike-rush-client-id", this.clientId);
      sessionStorage.setItem("strike-rush-player-token", this.playerToken);
      this.listeners = new Map();
      this.supabaseClient = null;
      this.supabaseChannel = null;
      this.hostToken = sessionStorage.getItem("strike-rush-host-token") || id();
      this.local = null;
      this.mode = config.realtime.mode === "supabase" && window.supabase?.createClient ? "supabase" : "local";

      if (this.mode === "supabase") {
        sessionStorage.setItem("strike-rush-host-token", this.hostToken);
        this.supabaseClient = window.supabase.createClient(
          config.realtime.supabaseUrl,
          config.realtime.supabaseAnonKey,
          { auth: { persistSession: false, autoRefreshToken: false } }
        );
        queueMicrotask(() => this.emitLocal("connection", { online: true, mode: "supabase" }));
      } else {
        this.local = new LocalTransport((message) => {
          if (message.type === "state" && message.state.code === this.roomCode) this.emitLocal("state", clone(message.state));
          if (message.type === "chat" && message.roomCode === this.roomCode) this.emitLocal("chat", message);
        });
        queueMicrotask(() => this.emitLocal("connection", { online: true, mode: "local" }));
      }
    }

    on(event, callback) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(callback);
      return this;
    }

    emitLocal(event, payload) {
      (this.listeners.get(event) || []).forEach((callback) => callback(payload));
    }

    async rpc(name, params) {
      const { data, error } = await this.supabaseClient.rpc(name, params);
      if (error) {
        const message = error.code === "PGRST202"
          ? "Configuration Supabase incomplète : exécutez supabase/schema.sql."
          : error.message || "Erreur de synchronisation.";
        this.emitLocal("error-message", message);
        return null;
      }
      return data;
    }

    subscribe(code) {
      if (this.mode !== "supabase") return;
      if (this.supabaseChannel) this.supabaseClient.removeChannel(this.supabaseChannel);
      this.supabaseChannel = this.supabaseClient
        .channel(`strike-rush:${code}:${this.clientId}`)
        .on("postgres_changes", {
          event: "*",
          schema: "public",
          table: "strike_rush_rooms",
          filter: `code=eq.${code}`
        }, (payload) => {
          if (payload.eventType === "DELETE") return;
          if (payload.new?.state) this.emitLocal("state", clone(payload.new.state));
        })
        .subscribe((status) => {
          const online = status === "SUBSCRIBED";
          if (online || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            this.emitLocal("connection", { online, mode: "supabase" });
          }
        });
    }

    readRoom(code = this.roomCode) {
      const raw = localStorage.getItem(roomKey(code));
      if (!raw) return null;
      const room = JSON.parse(raw);
      if (now() - room.updatedAt > config.game.lobbyTtlHours * 3600000) {
        localStorage.removeItem(roomKey(code));
        return null;
      }
      return room;
    }

    writeRoom(room) {
      room.updatedAt = now();
      localStorage.setItem(roomKey(room.code), JSON.stringify(room));
      this.local?.publish({ type: "state", state: clone(room) });
      this.emitLocal("state", clone(room));
      return room;
    }

    async createRoom() {
      const code = generateCode();
      this.roomCode = code;
      if (this.mode === "supabase") {
        const state = await this.rpc("strike_rush_create_room", {
          p_code: code,
          p_host_token: this.hostToken
        });
        if (!state) return null;
        this.subscribe(code);
        this.emitLocal("state", clone(state));
      } else {
        this.writeRoom(emptyRoom(code));
      }
      return code;
    }

    async watchRoom(code) {
      this.roomCode = cleanCode(code);
      if (this.mode === "supabase") {
        this.subscribe(this.roomCode);
        const state = await this.rpc("strike_rush_get_room", { p_code: this.roomCode });
        if (state) this.emitLocal("state", clone(state));
      } else {
        const room = this.readRoom();
        if (room) this.emitLocal("state", clone(room));
      }
    }

    async joinRoom(code, profile) {
      this.roomCode = cleanCode(code);
      if (this.mode === "supabase") {
        const room = await this.rpc("strike_rush_join", {
          p_code: this.roomCode,
          p_client_id: this.clientId,
          p_player_token: this.playerToken,
          p_nickname: profile.nickname,
          p_avatar: profile.avatar,
          p_color: profile.color
        });
        if (!room) return;
        this.subscribe(this.roomCode);
        this.emitLocal("joined", { clientId: this.clientId, room: clone(room) });
        this.emitLocal("state", clone(room));
        return;
      }
      const room = this.readRoom();
      if (!room) return this.emitLocal("error-message", "Partie introuvable ou expirée.");
      if (room.phase !== "lobby") return this.emitLocal("error-message", "La partie a déjà commencé.");
      if (!room.players[this.clientId] && Object.keys(room.players).length >= config.game.maxPlayers) return this.emitLocal("error-message", "Ce lobby est complet.");
      room.players[this.clientId] = {
        id: this.clientId,
        nickname: profile.nickname,
        avatar: profile.avatar,
        color: profile.color,
        credits: config.game.startingCredits,
        streak: 0,
        bestStreak: 0,
        totalWon: 0,
        correct: 0,
        bets: 0,
        joinedAt: now()
      };
      this.writeRoom(room);
      this.emitLocal("joined", { clientId: this.clientId, room: clone(room) });
    }

    async hostAction(action, payload = {}) {
      if (this.mode === "supabase") {
        const state = await this.rpc("strike_rush_host_action", {
          p_code: this.roomCode,
          p_host_token: this.hostToken,
          p_action: action,
          p_payload: payload
        });
        if (state) this.emitLocal("state", clone(state));
        return state;
      }
      const room = this.readRoom();
      if (!room) return;
      if (action === "start") room.phase = "waiting";
      if (action === "open-betting") {
        if (room.frame >= config.game.totalFrames) return;
        room.frame += 1;
        room.phase = "betting";
        room.bets = {};
        room.lastResult = null;
        room.bowler = payload.bowler || "Joueur libre";
        room.bettingEndsAt = now() + config.game.bettingSeconds * 1000;
      }
      if (action === "result") {
        if (!["betting", "locked"].includes(room.phase)) return;
        const result = { type: payload.type, pins: Math.max(0, Math.min(10, Number(payload.pins) || 0)), at: now() };
        Object.values(room.players).forEach((player) => {
          const bet = room.bets[player.id];
          if (!bet) return;
          const won = predictionMatches(bet.prediction, result);
          if (won) {
            player.streak += 1;
            player.bestStreak = Math.max(player.bestStreak, player.streak);
            player.correct += 1;
            const reward = bet.stake * (1 + (bet.power ? 5 : multiplierFor(player.streak)));
            player.credits += reward;
            player.totalWon += reward;
            bet.reward = reward;
          } else {
            player.streak = 0;
            bet.reward = 0;
          }
          bet.won = won;
          player.bets += 1;
        });
        room.lastResult = result;
        room.phase = room.frame >= config.game.totalFrames ? "finished" : "result";
        room.bettingEndsAt = 0;
      }
      if (action === "new-lobby") {
        localStorage.removeItem(roomKey(room.code));
        this.local?.publish({ type: "deleted", roomCode: room.code });
        return;
      }
      this.writeRoom(room);
    }

    async placeBet(prediction, stake, power = false, target = "") {
      if (this.mode === "supabase") {
        const state = await this.rpc("strike_rush_place_bet", {
          p_code: this.roomCode,
          p_client_id: this.clientId,
          p_player_token: this.playerToken,
          p_prediction: prediction,
          p_stake: Number(stake),
          p_power: Boolean(power),
          p_target: target
        });
        if (state) this.emitLocal("state", clone(state));
        return;
      }
      const room = this.readRoom();
      const player = room?.players[this.clientId];
      if (!room || !player || room.phase !== "betting" || now() >= room.bettingEndsAt) return this.emitLocal("error-message", "La fenêtre de mise est fermée.");
      if (room.bets[this.clientId]) return this.emitLocal("error-message", "Une seule mise est autorisée par lancer.");
      if (!["0", "1-9", "spare", "strike"].includes(prediction)) return;
      const safeStake = Math.round(Number(stake) / 10) * 10;
      if (safeStake < config.game.minBet || safeStake > config.game.maxBet || safeStake > player.credits) return this.emitLocal("error-message", "Mise invalide.");
      const safePower = Boolean(power && player.streak >= 3);
      const safeTarget = safePower && Object.values(room.players).some((candidate) => candidate.nickname === target) ? target : room.bowler;
      player.credits -= safeStake;
      room.bets[this.clientId] = { playerId: this.clientId, prediction, stake: safeStake, power: safePower, target: safeTarget, placedAt: now() };
      this.writeRoom(room);
    }

    async sendChat(message) {
      const allowed = ["Strike !", "Oh non...", "Il est chaud", "Bluffeur"];
      if (!allowed.includes(message)) return;
      if (this.mode === "supabase") {
        const state = await this.rpc("strike_rush_chat", {
          p_code: this.roomCode,
          p_client_id: this.clientId,
          p_player_token: this.playerToken,
          p_message: message
        });
        if (state) this.emitLocal("state", clone(state));
        return;
      }
      const room = this.readRoom();
      const player = room?.players[this.clientId];
      if (!room || !player) return;
      const last = room.chats.at(-1);
      if (last?.playerId === this.clientId && now() - last.at < 1500) return;
      const chat = { playerId: this.clientId, nickname: player.nickname, message, at: now() };
      room.chats = [...room.chats.slice(-7), chat];
      this.writeRoom(room);
      this.local?.publish({ type: "chat", roomCode: room.code, ...chat });
    }
  }

  window.StrikeRushRealtime = StrikeRushRealtime;
})();
