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
      sessionStorage.setItem("strike-rush-client-id", this.clientId);
      this.listeners = new Map();
      this.socket = null;
      this.local = null;
      this.mode = config.realtime.mode === "socket" && typeof window.io === "function" ? "socket" : "local";

      if (this.mode === "socket") {
        this.socket = window.io(config.realtime.socketUrl, {
          transports: ["websocket", "polling"],
          timeout: 7000
        });
        ["state", "error-message", "joined", "chat"].forEach((event) => {
          this.socket.on(event, (payload) => this.emitLocal(event, payload));
        });
        this.socket.on("connect", () => this.emitLocal("connection", { online: true, mode: "socket" }));
        this.socket.on("disconnect", () => this.emitLocal("connection", { online: false, mode: "socket" }));
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

    createRoom() {
      const code = generateCode();
      this.roomCode = code;
      if (this.mode === "socket") {
        this.socket.emit("host:create", { code });
      } else {
        this.writeRoom(emptyRoom(code));
      }
      return code;
    }

    watchRoom(code) {
      this.roomCode = cleanCode(code);
      if (this.mode === "socket") this.socket.emit("room:watch", { code: this.roomCode });
      else {
        const room = this.readRoom();
        if (room) this.emitLocal("state", clone(room));
      }
    }

    joinRoom(code, profile) {
      this.roomCode = cleanCode(code);
      const payload = { code: this.roomCode, clientId: this.clientId, profile };
      if (this.mode === "socket") return this.socket.emit("player:join", payload);
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

    hostAction(action, payload = {}) {
      if (this.mode === "socket") return this.socket.emit(`host:${action}`, { code: this.roomCode, ...payload });
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

    placeBet(prediction, stake, power = false, target = "") {
      const payload = { code: this.roomCode, clientId: this.clientId, prediction, stake: Number(stake), power, target };
      if (this.mode === "socket") return this.socket.emit("player:bet", payload);
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

    sendChat(message) {
      const allowed = ["Strike !", "Oh non...", "Il est chaud", "Bluffeur"];
      if (!allowed.includes(message)) return;
      if (this.mode === "socket") return this.socket.emit("player:chat", { code: this.roomCode, clientId: this.clientId, message });
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
