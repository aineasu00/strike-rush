import express from "express";
import http from "node:http";
import cors from "cors";
import helmet from "helmet";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
const MAX_PLAYERS = 9;
const STARTING_CREDITS = 1000;
const BETTING_SECONDS = 20;
const TOTAL_FRAMES = 10;
const ROOM_TTL = 24 * 60 * 60 * 1000;
const rooms = new Map();
const rateBuckets = new Map();

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN }));
app.get("/", (_request, response) => response.json({ service: "strike-rush-realtime", status: "ok", rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 12_000
});

const cleanCode = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const cleanNickname = (value) => String(value || "").trim().slice(0, 12).replace(/[^\p{L}\p{N}_-]/gu, "");
const publicRoom = (room) => ({
  code: room.code, createdAt: room.createdAt, updatedAt: room.updatedAt, phase: room.phase,
  frame: room.frame, bettingEndsAt: room.bettingEndsAt, bowler: room.bowler,
  players: Object.fromEntries(Object.entries(room.players).map(([id, player]) => {
    const { socketId, ...safePlayer } = player;
    return [id, safePlayer];
  })), bets: room.bets, chats: room.chats, lastResult: room.lastResult
});
const sendState = (room) => {
  room.updatedAt = Date.now();
  io.to(room.code).emit("state", publicRoom(room));
};
const error = (socket, message) => socket.emit("error-message", message);
const isHost = (socket, room) => room?.hostId === socket.id;
const multiplierFor = (streak) => streak >= 4 ? 5 : streak === 3 ? 3 : streak === 2 ? 2 : 1;
const predictionMatches = (prediction, result) => {
  if (prediction === "strike") return result.type === "strike" || result.pins === 10;
  if (prediction === "spare") return result.type === "spare";
  if (prediction === "0") return result.type === "pins" && result.pins === 0;
  return result.type === "pins" && result.pins >= 1 && result.pins <= 9;
};
const allow = (socketId, action, limit, windowMs) => {
  const key = `${socketId}:${action}`;
  const current = rateBuckets.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (Date.now() > current.resetAt) { current.count = 0; current.resetAt = Date.now() + windowMs; }
  current.count += 1;
  rateBuckets.set(key, current);
  return current.count <= limit;
};

io.on("connection", (socket) => {
  socket.on("host:create", ({ code }) => {
    const safeCode = cleanCode(code);
    if (safeCode.length !== 6 || rooms.has(safeCode)) return error(socket, "Code de lobby indisponible.");
    const room = {
      code: safeCode, hostId: socket.id, createdAt: Date.now(), updatedAt: Date.now(),
      phase: "lobby", frame: 0, bettingEndsAt: 0, bowler: "Joueur libre",
      players: {}, bets: {}, chats: [], lastResult: null
    };
    rooms.set(safeCode, room);
    socket.join(safeCode);
    sendState(room);
  });

  socket.on("room:watch", ({ code }) => {
    const room = rooms.get(cleanCode(code));
    if (!room) return error(socket, "Partie introuvable ou expirée.");
    socket.join(room.code);
    socket.emit("state", publicRoom(room));
  });

  socket.on("player:join", ({ code, clientId, profile }) => {
    if (!allow(socket.id, "join", 8, 60_000)) return error(socket, "Trop de tentatives. Réessayez dans une minute.");
    const room = rooms.get(cleanCode(code));
    if (!room) return error(socket, "Partie introuvable ou expirée.");
    if (room.phase !== "lobby") return error(socket, "La partie a déjà commencé.");
    const nickname = cleanNickname(profile?.nickname);
    if (nickname.length < 3) return error(socket, "Pseudo invalide.");
    if (!room.players[clientId] && Object.keys(room.players).length >= MAX_PLAYERS) return error(socket, "Ce lobby est complet.");
    room.players[clientId] = {
      id: clientId, socketId: socket.id, nickname, avatar: String(profile?.avatar || "🎳").slice(0, 4),
      color: String(profile?.color || "#FF2E63").slice(0, 9), credits: STARTING_CREDITS,
      streak: 0, bestStreak: 0, totalWon: 0, correct: 0, bets: 0, joinedAt: Date.now()
    };
    socket.data.clientId = clientId;
    socket.data.roomCode = room.code;
    socket.join(room.code);
    socket.emit("joined", { clientId, room: publicRoom(room) });
    sendState(room);
  });

  socket.on("host:start", ({ code }) => {
    const room = rooms.get(cleanCode(code));
    if (!isHost(socket, room) || !Object.keys(room.players).length) return;
    room.phase = "waiting";
    sendState(room);
  });

  socket.on("host:open-betting", ({ code, bowler }) => {
    const room = rooms.get(cleanCode(code));
    if (!isHost(socket, room) || room.frame >= TOTAL_FRAMES || room.phase === "betting") return;
    room.frame += 1;
    room.phase = "betting";
    room.bets = {};
    room.lastResult = null;
    room.bowler = cleanNickname(bowler) || "Joueur libre";
    room.bettingEndsAt = Date.now() + BETTING_SECONDS * 1000;
    sendState(room);
  });

  socket.on("player:bet", ({ code, clientId, prediction, stake, power, target }) => {
    if (!allow(socket.id, "bet", 12, 60_000)) return error(socket, "Trop de requêtes.");
    const room = rooms.get(cleanCode(code));
    const player = room?.players[clientId];
    const safeStake = Math.round(Number(stake) / 10) * 10;
    if (!room || !player || player.socketId !== socket.id) return error(socket, "Joueur non autorisé.");
    if (room.phase !== "betting" || Date.now() >= room.bettingEndsAt) return error(socket, "La fenêtre de mise est fermée.");
    if (room.bets[clientId]) return error(socket, "Une seule mise est autorisée.");
    if (!["0", "1-9", "spare", "strike"].includes(prediction)) return error(socket, "Prédiction invalide.");
    if (safeStake < 10 || safeStake > 500 || safeStake > player.credits) return error(socket, "Mise invalide.");
    const safePower = Boolean(power && player.streak >= 3);
    const safeTarget = safePower && Object.values(room.players).some((candidate) => candidate.nickname === target) ? target : room.bowler;
    player.credits -= safeStake;
    room.bets[clientId] = { playerId: clientId, prediction, stake: safeStake, power: safePower, target: safeTarget, placedAt: Date.now() };
    sendState(room);
  });

  socket.on("host:result", ({ code, type, pins }) => {
    const room = rooms.get(cleanCode(code));
    if (!isHost(socket, room) || room.phase !== "betting") return;
    const result = { type: ["pins", "spare", "strike"].includes(type) ? type : "pins", pins: Math.max(0, Math.min(10, Number(pins) || 0)), at: Date.now() };
    Object.values(room.players).forEach((player) => {
      const bet = room.bets[player.id];
      if (!bet) return;
      bet.won = predictionMatches(bet.prediction, result);
      if (bet.won) {
        player.streak += 1;
        player.bestStreak = Math.max(player.bestStreak, player.streak);
        player.correct += 1;
        bet.reward = bet.stake * (1 + (bet.power ? 5 : multiplierFor(player.streak)));
        player.credits += bet.reward;
        player.totalWon += bet.reward;
      } else {
        player.streak = 0;
        bet.reward = 0;
      }
      player.bets += 1;
    });
    room.lastResult = result;
    room.bettingEndsAt = 0;
    room.phase = room.frame >= TOTAL_FRAMES ? "finished" : "result";
    sendState(room);
  });

  socket.on("player:chat", ({ code, clientId, message }) => {
    if (!allow(socket.id, "chat", 4, 8_000)) return;
    const room = rooms.get(cleanCode(code));
    const player = room?.players[clientId];
    const allowed = ["Strike !", "Oh non...", "Il est chaud", "Bluffeur"];
    if (!room || !player || player.socketId !== socket.id || !allowed.includes(message)) return;
    room.chats = [...room.chats.slice(-7), { playerId: clientId, nickname: player.nickname, message, at: Date.now() }];
    sendState(room);
  });

  socket.on("host:new-lobby", ({ code }) => {
    const room = rooms.get(cleanCode(code));
    if (!isHost(socket, room)) return;
    io.to(room.code).emit("error-message", "Cette partie est terminée. Scannez le nouveau QR code.");
    rooms.delete(room.code);
  });

  socket.on("disconnect", () => {
    rateBuckets.forEach((_value, key) => { if (key.startsWith(`${socket.id}:`)) rateBuckets.delete(key); });
  });
});

setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL;
  rooms.forEach((room, code) => {
    if (room.updatedAt < cutoff) {
      io.to(code).emit("error-message", "Cette partie a expiré.");
      rooms.delete(code);
    }
  });
}, 15 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Strike Rush realtime listening on ${PORT}`));
